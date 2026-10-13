// 产品编辑弹窗图片整合集成测试：静态校验后台三件套
// （产品资料为默认标签、只读图片巡检、编辑弹窗内按颜色分组的四视角图片槽位与替换入口、上传端点与语法），
// 并通过受保护 API 验证 LP2136 的颜色/四视角结构，驱动一次测试替换（审计/备份/目录校验），
// 结束后恢复原图与数据快照并重跑校验，不留测试产物。
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

const port = Number(process.env.TEST_PORT || 5206);
const base = `http://127.0.0.1:${port}`;
const token = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const VIEWS = ['正面', '45度', '侧面', '背面'];

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 合成 JPEG 夹具（零依赖构造，仅 SOI + JFIF APP0 + SOF0 + EOI） ----------
function makeJpeg(width, height) {
  const b = Buffer.alloc(0);
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
  return Buffer.concat([b, ...segs]);
}

const validJpeg = makeJpeg(1200, 1500); // 与既有槽位同规格
if (jpegSize(validJpeg)?.width !== 1200 || jpegSize(validJpeg)?.height !== 1500) {
  throw new Error('测试夹具失败：validJpeg 尺寸解析不正确');
}

// ---------- 测试现场快照（结束后完全复原） ----------
const snapshotFiles = [adminStoreFile, `${adminStoreFile}.bak`, internalPasswordFile, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);
const hadBackupDir = await stat(backupDir).then(() => true).catch(() => false);
const backupFilesBefore = hadBackupDir ? new Set(await readdir(backupDir)) : new Set();

// 替换槽位：LP2136 / 黑色 / 正面（真实存在）
const target = { model: 'LP2136', color: '黑色', view: '正面', file: 'LP2136_黑色_正面.jpg' };
const targetQuery = `model=${encodeURIComponent(target.model)}&color=${encodeURIComponent(target.color)}&view=${encodeURIComponent(target.view)}`;
const originalBytes = await readFile(path.join(imageDir, target.file));
const originalHash = hex(originalBytes);

// ---------- 静态前端校验（后台三件套） ----------
async function staticChecks() {
  const [html, js, css] = await Promise.all([
    readFile(path.join(publicDir, 'admin.html'), 'utf8'),
    readFile(path.join(publicDir, 'admin.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin.css'), 'utf8'),
  ]);

  record('admin.html 产品资料为默认标签', html.includes('class="tab active" data-tab="products"') && html.includes('data-tab="images"') && html.includes('data-tab="audit"'), '');
  record('admin.html 图片管理标签已改名为图片巡检', html.includes('图片巡检') && !html.includes('图片管理'), '');
  record('admin.html 文件选择器移至页面级隐藏控件', html.includes('id="file-input"') && html.includes('accept="image/jpeg'), '');
  record('admin.html 品牌说明已更新为五标签顺序', html.includes('产品资料 / 图片补充 / 图片标准化 / 图片巡检 / 审计日志'), '');

  record('admin.js 复用既有上传端点', js.includes('/api/admin/images/upload'), '');
  record('admin.js 复用客户端预检与 pendingSlot', js.includes('precheckFile') && js.includes('pendingSlot'), '');
  record('admin.js 弹窗含产品图片区域标记', js.includes('dialog-image-slots') && js.includes('dialog-image-note') && js.includes('renderDialogImages'), '');
  record('admin.js 图片槽位提供替换入口', js.includes('data-dialog-replace') && js.includes('VIEW_ORDER'), '');
  record('admin.js 只读巡检不再渲染替换按钮', js.includes('inspectionSlotHTML') && !js.includes('document.querySelectorAll(\'.slot-replace\')'), '');
  record('admin.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');

  record('admin.css 含弹窗图片区域样式', css.includes('.dialog-images') && css.includes('.dialog-view-grid') && css.includes('.dialog-color-group'), '');
  record('admin.css 含缺图槽位样式', css.includes('.slot-thumb-missing') && css.includes('is-missing'), '');
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

async function main() {
  await waitForServer();

  // ---------- 认证与产品详情 ----------
  {
    const res = await fetch(`${base}/api/admin/products/LP2136`);
    record('产品详情未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const variants = (data.product && data.product.variants) || [];
    record('产品详情返回 LP2136 含 4 个颜色', res.status === 200 && data.product && variants.length === 4, `status=${res.status}, variants=${variants.length}`);
    record('每个颜色四视角齐备且完整', variants.length === 4 && variants.every((v) => v.complete === true && VIEWS.every((view) => v.views && v.views[view] && v.views[view].file)), JSON.stringify(variants.map((v) => ({ color: v.color, complete: v.complete, views: Object.keys(v.views || {}).length }))));
  }
  {
    const res = await fetch(`${base}/api/internal/image/${encodeURIComponent(target.file)}`, { headers: { Authorization: `Bearer ${token}` } });
    record('弹窗缩略图所用内部图片接口可用', res.status === 200, `status=${res.status}`);
  }

  // ---------- 驱动一次测试替换（弹窗替换入口对应的既有 API） ----------
  let uploadData = null;
  {
    const res = await fetch(`${base}/api/admin/images/upload?${targetQuery}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: validJpeg });
    uploadData = await res.json();
    record('替换既有槽位成功返回 200', res.status === 200 && uploadData.ok && uploadData.file === target.file, `status=${res.status}`);
  }
  {
    const replaced = await readFile(path.join(imageDir, target.file));
    record('槽位文件已被替换', hex(replaced) === hex(validJpeg), `hash=${hex(replaced).slice(0, 12)}`);
  }
  {
    const backupContent = uploadData ? await readFile(path.join(backupDir, uploadData.backup)) : Buffer.alloc(0);
    record('原图已备份', hex(backupContent) === originalHash, `backup=${uploadData && uploadData.backup}`);
  }
  {
    const res = await fetch(`${base}/api/admin/audit`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const entry = (data.audit || []).find((e) => e.action === 'image-upload' && e.model === target.model);
    record('审计新增 image-upload 记录', res.status === 200 && !!entry, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const black = (data.product.variants || []).find((v) => v.color === target.color);
    record('替换后产品弹窗数据仍四视角完整', !!black && black.complete === true && VIEWS.every((view) => black.views && black.views[view]), JSON.stringify(black ? { color: black.color, views: Object.keys(black.views || {}) } : null));
  }
  {
    const res = await fetch(`${base}/api/internal/image/${encodeURIComponent(target.file)}?v=2`, { headers: { Authorization: `Bearer ${token}` } });
    const bytes = Buffer.from(await res.arrayBuffer());
    record('内部图片接口返回替换后的图片', res.status === 200 && hex(bytes) === hex(validJpeg), `status=${res.status}`);
  }

  // ---------- /admin 路由与标签 ----------
  {
    const res = await fetch(`${base}/admin`);
    const text = await res.text();
    record('/admin 返回含图片巡检的新管理页', res.status === 200 && text.includes('图片巡检') && !text.includes('图片管理'), `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/static/admin.js`);
    record('/static/admin.js 带 no-store', res.status === 200 && (res.headers.get('cache-control') || '').includes('no-store'), `cache-control=${res.headers.get('cache-control')}`);
  }
}

// ---------- 清理与收尾 ----------
async function cleanup() {
  server.kill();
  await new Promise((resolve) => {
    server.once('exit', resolve);
    setTimeout(resolve, 3000);
  });

  // 1) 恢复原图
  const backupList = await readdir(backupDir).catch(() => []);
  const testBackups = backupList.filter((name) => !backupFilesBefore.has(name));
  const targetPath = path.join(imageDir, target.file);
  for (const name of testBackups) {
    try {
      await copyFile(path.join(backupDir, name), targetPath);
    } catch { /* 继续尝试其余备份 */ }
  }

  // 2) 校验恢复后的文件确为原图
  const restored = await readFile(targetPath);
  if (hex(restored) !== originalHash) throw new Error(`清理失败：图片未恢复为原图（${hex(restored).slice(0, 12)} ≠ ${originalHash.slice(0, 12)}）`);

  // 3) 删除测试期间产生的备份与残留临时文件
  for (const name of testBackups) await rm(path.join(backupDir, name), { force: true });
  for (const name of await readdir(imageDir)) {
    if (name.startsWith('.')) await rm(path.join(imageDir, name), { force: true });
  }
  const remainingBackups = await readdir(backupDir).catch(() => []);
  if (!hadBackupDir && remainingBackups.length === 0) await rm(backupDir, { recursive: true, force: true });

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
  const child = spawn(process.execPath, ['scripts/validate-catalog.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  record('清理后 validate-catalog 通过', code === 0, out.split('\n')[0] || `exit=${code}`);
}

for (const r of results) console.log(`${r.passed ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const allPassed = results.every((r) => r.passed);
console.log(`\n${allPassed ? '全部通过' : '存在失败'}：${results.filter((r) => r.passed).length}/${results.length}`);
if (failed || !allPassed) process.exit(1);
