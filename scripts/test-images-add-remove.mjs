// Phase 1 颜色/图片槽位管理集成测试：spawn 一个服务器实例，覆盖
// - 管理端新增颜色（POST /api/admin/products/{model}/colors）与移除（DELETE …/colors?color=）
// - 图片上传新增缺失槽位（upload?model=&color=&view=，颜色必须已存在）与替换既有槽位
// - 图片删除（DELETE /api/admin/images/remove?model=&color=&view=）备份原图、审计留痕
// - 部分完整度（0/4–4/4）：新增颜色 + 单视角图片即可通过构建/校验，不伪造图片
// - 公开目录只含 public 产品（新增颜色/图片不改变 displayStatus，不自动公开）
// 结束后恢复原图、删除测试文件与备份、还原 admin-store/目录快照并重跑校验，不留测试产物。
import { spawn } from 'node:child_process';
import { copyFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { jpegSize } from './jpeg-size.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const imageDir = path.join(root, 'data', 'images');
const backupDir = path.join(root, 'data', 'images-backup');
const adminStoreFile = path.join(root, 'data', 'admin-store.json');
const internalPasswordFile = path.join(root, 'data', '.internal-password');
const catalogFile = path.join(root, 'data', 'catalog.json');
const publicCatalogFile = path.join(root, 'data', 'catalog.public.json');

const port = Number(process.env.TEST_PORT || 5207);
const base = `http://127.0.0.1:${port}`;
const token = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const VIEWS = ['正面', '45度', '侧面', '背面'];

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 合成 JPEG 夹具（零依赖构造，仅 SOI + JFIF APP0 + SOF0 + EOI） ----------
function makeJpeg(width, height) {
  const segs = [
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), // JFIF APP0
    Buffer.concat([
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), // SOF0：精度 8
      Buffer.from([(height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03]),
      Buffer.from([0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]), // 3 个分量
    ]),
    Buffer.from([0xff, 0xd9]), // EOI
  ];
  return Buffer.concat(segs);
}

// 在 EOI 前插入一个 COM 标记，得到内容不同但尺寸相同的 JPEG（用于“替换”断言）
function makeJpegVariant(width, height, marker) {
  const plain = makeJpeg(width, height);
  return Buffer.concat([
    plain.subarray(0, plain.length - 2),
    Buffer.from([0xff, 0xfe, 0x00, 0x04, marker & 0xff, 0x00]),
    plain.subarray(plain.length - 2),
  ]);
}

const validJpeg = makeJpeg(1200, 1500);
const validJpegVariant = makeJpegVariant(1200, 1500, 0x41); // 内容不同、尺寸相同
const wrongSizeJpeg = makeJpeg(100, 100);
if (jpegSize(validJpeg)?.width !== 1200 || jpegSize(validJpeg)?.height !== 1500) {
  throw new Error('测试夹具失败：validJpeg 尺寸解析不正确');
}
if (hex(validJpeg) === hex(validJpegVariant)) {
  throw new Error('测试夹具失败：validJpegVariant 应与 validJpeg 内容不同');
}

// ---------- 测试现场快照（结束后完全复原） ----------
const snapshotFiles = [adminStoreFile, `${adminStoreFile}.bak`, internalPasswordFile, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);
const hadBackupDir = await stat(backupDir).then(() => true).catch(() => false);
const backupFilesBefore = hadBackupDir ? new Set(await readdir(backupDir)) : new Set();
const imageFilesBefore = new Set(await readdir(imageDir));

const createdFiles = []; // 测试期间由新增槽位写入的图片文件（结束后删除）

// ---------- 静态前端校验（新增颜色编辑器 + 上传/替换/删除按钮） ----------
async function staticChecks() {
  const [html, js, css] = await Promise.all([
    readFile(path.join(publicDir, 'admin.html'), 'utf8'),
    readFile(path.join(publicDir, 'admin.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin.css'), 'utf8'),
  ]);

  record('admin.html 含页面级文件选择器与图片巡检说明', html.includes('id="file-input"') && html.includes('产品图片'), '');
  record('admin.js 含产品图片弹窗区域', js.includes('dialog-image-slots') && js.includes('dialog-image-note'), '');

  record('admin.js 颜色编辑器（表单/输入/新增/移除）', js.includes('dialog-colors-form') && js.includes('dialog-color-input') && js.includes('renderDialogColors') && js.includes('addProductColors') && js.includes('removeProductColor') && js.includes('data-color-remove'), '');
  record('admin.js 缺失视角上传按钮', js.includes('data-dialog-upload') && js.includes('slot-upload'), '');
  record('admin.js 既有槽位替换/删除按钮', js.includes('data-dialog-replace') && js.includes('data-dialog-remove') && js.includes('removeSlot'), '');
  record('admin.js 颜色接口引用', js.includes('/colors'), '');
  record('admin.js 图片删除接口引用', js.includes('/api/admin/images/remove'), '');
  record('admin.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');

  record('admin.css 含颜色管理样式', css.includes('.color-chips') && css.includes('.chip-remove') && css.includes('.color-add-row'), '');
  record('admin.css 含槽位操作/删除样式', css.includes('.slot-actions') && css.includes('quiet.danger'), '');
}

// ---------- 服务器 ----------
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务器启动超时。日志：\n${serverLog}`);
}

function jsonHeaders() { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }
function adminHeaders() { return { Authorization: `Bearer ${token}` }; }
const uploadQuery = (model, color, view) => `model=${encodeURIComponent(model)}&color=${encodeURIComponent(color)}&view=${encodeURIComponent(view)}`;

async function uploadImage(model, color, view, body, withAuth = true) {
  const headers = withAuth ? { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' } : { 'Content-Type': 'image/jpeg' };
  return fetch(`${base}/api/admin/images/upload?${uploadQuery(model, color, view)}`, { method: 'POST', headers, body });
}
async function removeImage(model, color, view, withAuth = true) {
  const headers = withAuth ? adminHeaders() : {};
  return fetch(`${base}/api/admin/images/remove?${uploadQuery(model, color, view)}`, { method: 'DELETE', headers });
}

async function runValidate() {
  const child = spawn(process.execPath, ['scripts/validate-catalog.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  return { code, out };
}

async function main() {
  await waitForServer();

  // ---------- 认证边界（新端点未认证一律 401） ----------
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colors: ['红色'] }) });
    record('新增颜色未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await removeImage('LP2136', '黑色', '正面', false);
    record('删除图片未认证返回 401', res.status === 401, `status=${res.status}`);
  }

  // ---------- 颜色管理 ----------
  let redColorAdd = null;
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: ['红色'] }) });
    const data = await res.json();
    redColorAdd = data;
    record('新增颜色成功返回 200', res.status === 200 && data.ok && data.added.includes('红色'), `status=${res.status}, added=${JSON.stringify(data.added)}`);
    record('新增颜色后产品颜色列表包含 红色', res.status === 200 && data.colors.includes('红色'), JSON.stringify(data.colors));
    record('新增颜色写入 override.colors', res.status === 200 && Array.isArray(data.override.colors) && data.override.colors.includes('红色'), JSON.stringify(data.override.colors));
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: ['红色'] }) });
    record('重复新增颜色返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: ['黑色'] }) });
    record('新增基础颜色返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: ['红/色'] }) });
    record('非法颜色名（含路径分隔符）返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: [] }) });
    record('空 colors 数组返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/NOPE999/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: ['红色'] }) });
    record('不存在的型号新增颜色返回 404', res.status === 404, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'DELETE', headers: adminHeaders() });
    record('删除颜色缺 color 参数返回 400', res.status === 400, `status=${res.status}`);
  }

  // 新增颜色后：产品出现新变体（尚未有图，0/4）
  {
    const res = await fetch(`${base}/api/admin/products/LP2136`, { headers: adminHeaders() });
    const data = await res.json();
    const red = (data.product.variants || []).find((v) => v.color === '红色');
    record('新增颜色生成了 红色 变体（0/4 无图）', res.status === 200 && !!red && !red.complete && red.missingViews.length === 4, JSON.stringify(red ? { complete: red.complete, views: Object.keys(red.views || {}).length } : null));
  }

  // ---------- 新增槽位前置校验：颜色必须已存在 ----------
  {
    const res = await uploadImage('LP2136', '蓝色', '正面', validJpeg);
    record('颜色未存在时新增图片返回 409', res.status === 409, `status=${res.status}`);
  }
  {
    const res = await uploadImage('NOPE999', '红色', '正面', validJpeg);
    record('不存在的型号上传返回 404', res.status === 404, `status=${res.status}`);
  }
  {
    const res = await uploadImage('LP2136', '红色', '全景', validJpeg);
    record('非法视角返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await uploadImage('LP2136', '红色', '正面', Buffer.from([0x00, 0x01, 0x02, 0x03]));
    record('新增槽位非 JPEG 返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await uploadImage('LP2136', '红色', '正面', wrongSizeJpeg);
    const data = await res.json();
    record('新增槽位尺寸不符返回 400', res.status === 400 && /1200×1500/.test(data.error || ''), `status=${res.status}, error=${data.error}`);
  }

  // ---------- 新增缺失槽位（部分完整 0/4 → 1/4） ----------
  let createData = null;
  const frontFile = 'LP2136_红色_正面.jpg';
  {
    const res = await uploadImage('LP2136', '红色', '正面', validJpeg);
    createData = await res.json();
    record('新增缺失槽位成功返回 200（created=true）', res.status === 200 && createData.ok && createData.created === true, `status=${res.status}, body=${JSON.stringify(createData)}`);
    record('新槽位文件名为安全规范名', res.status === 200 && createData.file === frontFile, `file=${createData.file}`);
  }
  {
    const exists = await stat(path.join(imageDir, frontFile)).then(() => true).catch(() => false);
    record('新槽位图片文件已写入', exists, `file=${frontFile}`);
    createdFiles.push(frontFile);
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: adminHeaders() });
    const data = await res.json();
    const img = (data.images || []).find((i) => i.model === 'LP2136' && i.color === '红色' && i.view === '正面');
    record('新槽位已进入内部目录', res.status === 200 && !!img && img.file === frontFile, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136`, { headers: adminHeaders() });
    const data = await res.json();
    const red = (data.product.variants || []).find((v) => v.color === '红色');
    record('新槽位后 红色 变体 1/4 部分完整', res.status === 200 && !!red && Object.keys(red.views || {}).length === 1 && red.missingViews.length === 3 && !red.complete, JSON.stringify(red ? { views: Object.keys(red.views || {}), complete: red.complete } : null));
  }
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    const pubImg = (data.images || []).find((i) => i.file === frontFile);
    record('公开目录包含 public 型号的新图片', res.status === 200 && !!pubImg, `status=${res.status}`);
  }
  {
    const store = JSON.parse(await readFile(adminStoreFile, 'utf8'));
    const entry = store.products.LP2136;
    record('admin-store 注册了新槽位条目', !!(entry && Array.isArray(entry.images) && entry.images.some((mi) => mi.file === frontFile && mi.color === '红色' && mi.view === '正面')), JSON.stringify(entry && entry.images));
  }

  // ---------- 部分完整度（1/4）可通过构建校验 ----------
  {
    const { code, out } = await runValidate();
    record('部分完整度（1/4）validate-catalog 通过', code === 0, out.split('\n')[0] || `exit=${code}`);
  }

  // ---------- 替换同一槽位（created=false，备份原图） ----------
  let replaceData = null;
  {
    const res = await uploadImage('LP2136', '红色', '正面', validJpegVariant);
    replaceData = await res.json();
    record('替换既有槽位返回 200（created=false）', res.status === 200 && replaceData.ok && replaceData.created === false && replaceData.backup, `status=${res.status}, created=${replaceData && replaceData.created}`);
  }
  {
    const current = await readFile(path.join(imageDir, frontFile));
    record('替换后文件为新内容', hex(current) === hex(validJpegVariant), `hash=${hex(current).slice(0, 12)}`);
  }
  {
    const backup = replaceData ? await readFile(path.join(backupDir, replaceData.backup)).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    record('替换前的备份为旧内容', replaceData && hex(backup) === hex(validJpeg), `backup=${replaceData && replaceData.backup}`);
  }

  // ---------- 新增第二个视角（2/4） ----------
  const sideFile = 'LP2136_红色_侧面.jpg';
  {
    const res = await uploadImage('LP2136', '红色', '侧面', validJpeg);
    const data = await res.json();
    record('新增第二个视角成功（2/4）', res.status === 200 && data.created === true && data.file === sideFile, `status=${res.status}, file=${data.file}`);
    createdFiles.push(sideFile);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136`, { headers: adminHeaders() });
    const data = await res.json();
    const red = (data.product.variants || []).find((v) => v.color === '红色');
    record('红色 变体现为 2/4 部分完整', res.status === 200 && !!red && Object.keys(red.views || {}).length === 2, JSON.stringify(red && Object.keys(red.views || {})));
  }

  // ---------- 删除图片（备份 + 移除注册表 + 审计） ----------
  let removeData = null;
  {
    const res = await removeImage('LP2136', '红色', '侧面');
    removeData = await res.json();
    record('删除槽位成功返回 200 且带备份', res.status === 200 && removeData.ok && removeData.file === sideFile && removeData.backup, `status=${res.status}, body=${JSON.stringify(removeData)}`);
  }
  {
    const gone = await stat(path.join(imageDir, sideFile)).then(() => false).catch(() => true);
    record('删除后槽位文件已移除', gone, '');
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: adminHeaders() });
    const data = await res.json();
    const still = (data.images || []).some((i) => i.model === 'LP2136' && i.color === '红色' && i.view === '侧面');
    record('删除后槽位已从目录移除', res.status === 200 && !still, `status=${res.status}`);
  }
  {
    const backup = removeData ? await readFile(path.join(backupDir, removeData.backup)).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    record('删除备份为原图内容', removeData && hex(backup) === hex(validJpeg), `backup=${removeData && removeData.backup}`);
  }
  {
    const res = await removeImage('LP2136', '红色', '背面');
    record('删除不存在的槽位返回 404', res.status === 404, `status=${res.status}`);
  }

  // ---------- 颜色移除守卫 ----------
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors?color=${encodeURIComponent('红色')}`, { method: 'DELETE', headers: adminHeaders() });
    record('颜色已有图片时移除返回 409', res.status === 409, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors?color=${encodeURIComponent('蓝色')}`, { method: 'DELETE', headers: adminHeaders() });
    record('移除未新增的颜色返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors?color=${encodeURIComponent('黑色')}`, { method: 'DELETE', headers: adminHeaders() });
    record('移除基础颜色返回 400', res.status === 400, `status=${res.status}`);
  }

  // ---------- 删除剩余图片后移除颜色 ----------
  {
    const res = await removeImage('LP2136', '红色', '正面');
    const data = await res.json();
    record('删除最后一个新增槽位成功', res.status === 200 && data.ok && data.file === frontFile, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors?color=${encodeURIComponent('红色')}`, { method: 'DELETE', headers: adminHeaders() });
    const data = await res.json();
    record('删除颜色（无图片）成功', res.status === 200 && data.ok && data.removed === '红色' && !data.colors.includes('红色'), `status=${res.status}, colors=${JSON.stringify(data.colors)}`);
    record('移除颜色后 override.colors 已清空', res.status === 200 && (!data.override.colors || !data.override.colors.length), JSON.stringify(data.override));
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136`, { headers: adminHeaders() });
    const data = await res.json();
    const red = (data.product.variants || []).find((v) => v.color === '红色');
    record('移除颜色后 红色 变体已消失', res.status === 200 && !red, '');
  }

  // ---------- 不自动公开：给内部型号新增颜色不改变状态、不进公开目录 ----------
  const internalModel = 'BL012';
  {
    const before = await (await fetch(`${base}/api/internal/catalog`, { headers: adminHeaders() })).json();
    const p = (before.products || []).find((x) => x.model === internalModel);
    record('内部型号 BL012 存在于目录且未公开', !!p && p.displayStatus !== 'public', `displayStatus=${p && p.displayStatus}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${internalModel}/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: ['玫红'] }) });
    record('内部型号新增颜色成功', res.status === 200 && res.ok, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    record('内部型号新增颜色不进公开目录', res.status === 200 && !(data.products || []).some((p) => p.model === internalModel), `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${internalModel}/colors?color=${encodeURIComponent('玫红')}`, { method: 'DELETE', headers: adminHeaders() });
    record('移除内部型号新增颜色', res.status === 200, `status=${res.status}`);
  }

  // ---------- 审计留痕 ----------
  {
    const res = await fetch(`${base}/api/admin/audit`, { headers: adminHeaders() });
    const data = await res.json();
    const actions = (data.audit || []).map((e) => e.action);
    record('审计含 color-add / color-remove', actions.includes('color-add') && actions.includes('color-remove'), actions.filter((a) => a.startsWith('color-')).join(','));
    record('审计含 image-create / image-upload / image-remove', actions.includes('image-create') && actions.includes('image-upload') && actions.includes('image-remove'), actions.filter((a) => a.startsWith('image-')).join(','));
  }

  // ---------- /admin 路由回归 ----------
  {
    const res = await fetch(`${base}/admin`);
    const text = await res.text();
    record('/admin 返回管理页', res.status === 200 && text.includes('图片巡检'), `status=${res.status}`);
  }
}

// ---------- 清理与收尾 ----------
async function cleanup() {
  server.kill();
  await new Promise((resolve) => {
    server.once('exit', resolve);
    setTimeout(resolve, 3000);
  });

  // 1) 删除测试期间新增的图片文件
  for (const file of createdFiles) await rm(path.join(imageDir, file), { force: true });

  // 2) 删除测试期间产生的备份与残留临时文件
  const backupList = await readdir(backupDir).catch(() => []);
  for (const name of backupList) {
    if (!backupFilesBefore.has(name)) await rm(path.join(backupDir, name), { force: true });
  }
  for (const name of await readdir(imageDir)) {
    if (name.startsWith('.')) await rm(path.join(imageDir, name), { force: true });
  }
  const remainingBackups = await readdir(backupDir).catch(() => []);
  if (!hadBackupDir && remainingBackups.length === 0) await rm(backupDir, { recursive: true, force: true });

  // 3) 校验图片目录与快照一致
  const after = new Set(await readdir(imageDir));
  const extra = [...after].filter((name) => !imageFilesBefore.has(name));
  if (extra.length) throw new Error(`清理失败：残留图片文件 ${extra.join(', ')}`);
  const missing = [...imageFilesBefore].filter((name) => !after.has(name));
  if (missing.length) throw new Error(`清理失败：原图片文件缺失 ${missing.join(', ')}`);

  // 4) 还原 admin-store 与目录快照
  for (const file of snapshotFiles) {
    if (snapshot[file] === null) await rm(file, { force: true });
    else await writeFile(file, snapshot[file]);
  }
}

let failed = false;
try {
  await staticChecks();
  await main();
} catch (error) {
  failed = true;
  results.push({ name: '测试执行异常', passed: false, detail: error.stack || error.message });
} finally {
  await cleanup();
}

// ---------- 最终校验：恢复后必须通过 validate ----------
{
  const { code, out } = await runValidate();
  record('清理后 validate-catalog 通过', code === 0, out.split('\n')[0] || `exit=${code}`);
}

for (const r of results) console.log(`${r.passed ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const allPassed = results.every((r) => r.passed);
console.log(`\n${allPassed ? '全部通过' : '存在失败'}：${results.filter((r) => r.passed).length}/${results.length}`);
if (failed || !allPassed) process.exit(1);
