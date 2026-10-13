// 图片补充工作台集成测试：
// - 静态校验后台三件套：图片补充标签、完整度/系列/状态/搜索筛选、每产品/每颜色 0/4–4/4 进度、
//   批量文件选择器（多选/拖拽）、文件名解析 / 本地预检 / 预览、批量新增颜色与上传（复用既有 API）、
//   进度与撤销/自动回滚标记、既有标签/编辑/翻译/审计标记回归、脚本语法有效；
// - 行为校验：parseFileName / readJpegDimensions 纯函数解析；
//   工作台统计 API（未认证 401、410 款产品、每产品每颜色完整度）、
//   安全备份读取 API（未认证 401、目录穿越/非 JPEG/不存在 404、有效备份 200 且内容一致）、
//   模拟批量「新增颜色 + 上传 → 回滚（删除槽位 + 移除颜色）」、替换槽位后「读取备份 → 重传还原」；
// 结束后删除测试文件与备份、还原 admin-store/目录/.internal-password 快照并重跑校验，不留测试产物。
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

const port = Number(process.env.TEST_PORT || 5209);
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

// 在 EOI 前插入一个 COM 标记，得到内容不同但尺寸相同的 JPEG（用于“替换/撤销”断言）
function makeJpegVariant(width, height, marker) {
  const plain = makeJpeg(width, height);
  return Buffer.concat([
    plain.subarray(0, plain.length - 2),
    Buffer.from([0xff, 0xfe, 0x00, 0x04, marker & 0xff, 0x00]),
    plain.subarray(plain.length - 2),
  ]);
}

const validJpeg = makeJpeg(1200, 1500);
const validJpegVariant = makeJpegVariant(1200, 1500, 0x42);
if (jpegSize(validJpeg)?.width !== 1200 || jpegSize(validJpeg)?.height !== 1500) {
  throw new Error('测试夹具失败：validJpeg 尺寸解析不正确');
}

// ---------- 测试现场快照（结束后完全复原） ----------
const snapshotFiles = [adminStoreFile, `${adminStoreFile}.bak`, internalPasswordFile, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);
const hadBackupDir = await stat(backupDir).then(() => true).catch(() => false);
const backupFilesBefore = hadBackupDir ? new Set(await readdir(backupDir)) : new Set();
const imageFilesBefore = new Set(await readdir(imageDir));

const createdFiles = []; // 测试期间由新增槽位写入的图片文件（结束后删除）

// ---------- 从 admin.js 提取纯函数做行为校验（parseFileName / readJpegDimensions） ----------
function extractFn(adminJs, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`);
  const m = adminJs.match(re);
  if (!m) return null;
  try { return eval(`(${m[0]})`); } catch { return null; }
}

// ---------- 静态前端校验 ----------
async function staticChecks() {
  const [html, js, css] = await Promise.all([
    readFile(path.join(publicDir, 'admin.html'), 'utf8'),
    readFile(path.join(publicDir, 'admin.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin.css'), 'utf8'),
  ]);

  record('admin.html 含图片补充标签与面板', html.includes('data-tab="workbench"') && html.includes('图片补充') && html.includes('id="tab-workbench"'), '');
  record('admin.html 工作台含统计/筛选/进度区域', html.includes('id="workbench-stats"') && html.includes('id="workbench-models"') && html.includes('id="wb-filter-q"') && html.includes('id="wb-filter-series"') && html.includes('id="wb-filter-status"') && html.includes('id="wb-filter-completeness"'), '');
  record('admin.html 批量选择器（多选 + 拖拽区）', html.includes('id="batch-file-input"') && html.includes('multiple') && html.includes('id="batch-dropzone"'), '');
  record('admin.html 批量队列/进度/撤销按钮', html.includes('id="batch-queue"') && html.includes('id="batch-progress"') && html.includes('id="workbench-undo-all"') && html.includes('id="batch-start"'), '');
  record('admin.html 既有标签/说明回归', html.includes('data-tab="products"') && html.includes('data-tab="images"') && html.includes('data-tab="audit"') && html.includes('id="file-input"'), '');

  record('admin.js 文件名解析与本地预检', js.includes('function parseFileName') && js.includes('function readJpegDimensions') && js.includes('function preflightFile'), '');
  record('admin.js 工作台统计/进度渲染', js.includes('loadWorkbench') && js.includes('renderWorkbenchModels') && js.includes('wb-color-chip') && js.includes('workbenchFilter'), '');
  record('admin.js 批量上传/回滚/撤销函数', js.includes('startBatch') && js.includes('undoUploadItem') && js.includes('undoLastBatch') && js.includes('undoItemById') && js.includes('removeAddedColorIfEmpty'), '');
  record('admin.js 复用既有 API（colors/upload/remove）', js.includes('/api/admin/workbench') && js.includes('/api/admin/backup/') && js.includes('/api/admin/images/upload') && js.includes('/api/admin/images/remove') && js.includes('/colors'), '');
  record('admin.js 行内撤销/移除标记', js.includes('data-undo-item') && js.includes('data-remove-item') && js.includes('batch-input'), '');
  record('admin.js 既有弹窗/编辑/翻译标记回归', js.includes('dialog-image-slots') && js.includes('data-dialog-replace') && js.includes('precheckFile') && js.includes('dialog-translations-form'), '');
  record('admin.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');

  record('admin.css 含完整度色块/进度条样式', css.includes('.wb-color-chip') && css.includes('.is-full') && css.includes('.is-partial') && css.includes('.is-missing') && css.includes('.wb-progress-bar'), '');
  record('admin.css 含批量拖拽/队列/统计样式', css.includes('.batch-dropzone') && css.includes('.batch-queue') && css.includes('.batch-row') && css.includes('.wb-stat'), '');

  // 行为校验：parseFileName（与工作台渲染同源，避免测试逻辑漂移）
  const parseFileName = extractFn(js, 'parseFileName');
  const p1 = parseFileName('LP2136_黑色_正面.jpg');
  const p2 = parseFileName('LP2145_卡其色_45度.JPG');
  const p3 = parseFileName('BL002_黑色CP_侧面.jpg');
  record('parseFileName 解析 型号_颜色_视角', !!parseFileName && p1 && p1.model === 'LP2136' && p1.color === '黑色' && p1.view === '正面' && p2 && p2.view === '45度' && p3 && p3.color === '黑色CP', JSON.stringify(p1));
  record('parseFileName 非法文件名返回 null', !!parseFileName && parseFileName('notanimage.png') === null && parseFileName('LP2136_黑色_全景.jpg') === null && parseFileName('LP2136_黑色正面.jpg') === null, '');
  record('parseFileName 抽取成功（工作台函数可用）', !!parseFileName, '');

  // 行为校验：readJpegDimensions（本地预检的尺寸解析，与上传服务端校验同标准）
  const readJpegDimensions = extractFn(js, 'readJpegDimensions');
  const dimsOk = readJpegDimensions(new Uint8Array(validJpeg));
  const dimsNull = readJpegDimensions(new Uint8Array(Buffer.from([0x00, 0x01, 0x02, 0x03])));
  record('readJpegDimensions 解析出 1200×1500', !!readJpegDimensions && !!dimsOk && dimsOk.width === 1200 && dimsOk.height === 1500, JSON.stringify(dimsOk));
  record('readJpegDimensions 非 JPEG 返回 null', !!readJpegDimensions && dimsNull === null, '');
  record('readJpegDimensions 抽取成功（本地预检函数可用）', !!readJpegDimensions, '');
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

  // ---------- 工作台统计 API：认证与结构 ----------
  {
    const res = await fetch(`${base}/api/admin/workbench`);
    record('工作台统计未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  let workbench = null;
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: adminHeaders() });
    const data = await res.json();
    workbench = data;
    record('工作台统计返回 200 且覆盖全部产品', res.status === 200 && data.totals && data.totals.products === 410 && (data.models || []).length === 410, `status=${res.status}, products=${data.totals && data.totals.products}, models=${data.models && data.models.length}`);
    record('工作台 totals 图片总数与内部目录一致', res.status === 200 && typeof data.totals.images === 'number' && data.totals.images > 0, `images=${data.totals && data.totals.images}`);
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: adminHeaders() });
    const data = await res.json();
    const imgCount = (data.images || []).length;
    record('工作台统计图片数与内部目录一致', workbench && workbench.totals.images === imgCount, `wb=${workbench && workbench.totals.images}, catalog=${imgCount}`);
  }
  // 每产品 / 每颜色 0/4–4/4 进度
  {
    const lp2136 = (workbench.models || []).find((m) => m.model === 'LP2136');
    const allFull = lp2136 && lp2136.colors.length === 4 && lp2136.colors.every((c) => c.present === 4 && c.total === 4 && c.complete);
    record('LP2136 每颜色 4/4 完整（4 色 × 4 视角）', !!lp2136 && lp2136.colorCount === 4 && lp2136.completeColors === 4 && lp2136.images === 16 && allFull, JSON.stringify(lp2136 && { colorCount: lp2136.colorCount, completeColors: lp2136.completeColors, images: lp2136.images }));
  }
  {
    const bl002 = (workbench.models || []).find((m) => m.model === 'BL002');
    const black = bl002 && bl002.colors.find((c) => c.color === '黑色');
    record('BL002 部分完整（1/4）正确统计', !!bl002 && bl002.images === 1 && bl002.partialColors === 1 && bl002.missingColors === bl002.colorCount - 1 && black && black.present === 1 && black.total === 4 && !black.complete, JSON.stringify(bl002 && { images: bl002.images, partial: bl002.partialColors, black }));
  }
  {
    const noImg = (workbench.models || []).find((m) => m.images === 0);
    const hasMissing = (workbench.models || []).some((m) => m.missingColors === m.colorCount && m.images === 0);
    record('无图产品全部颜色 0/4 缺图', !!noImg && hasMissing, `noImage=${!!noImg}`);
  }

  // ---------- 安全备份读取 API ----------
  {
    const res = await fetch(`${base}/api/admin/backup/nonexistent.jpg`);
    record('备份读取未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/backup/not-a-real-file.jpg`, { headers: adminHeaders() });
    record('备份读取不存在的文件返回 404', res.status === 404, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/backup/..%2F..%2Fcatalog.json`, { headers: adminHeaders() });
    record('备份读取目录穿越返回 404', res.status === 404, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/backup/foo%5C..%5Cbar.jpg`, { headers: adminHeaders() });
    record('备份读取反斜杠路径返回 404', res.status === 404, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/backup/foo.png`, { headers: adminHeaders() });
    record('备份读取非 JPEG 返回 404', res.status === 404, `status=${res.status}`);
  }

  // ---------- 模拟批量「新增颜色 + 上传」（复用既有 colors / upload API） ----------
  let createdFile = null;
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ colors: ['测试红'] }) });
    const data = await res.json();
    record('批量前置：新增颜色成功', res.status === 200 && data.ok && data.added.includes('测试红'), `status=${res.status}`);
  }
  {
    const res = await uploadImage('LP2136', '测试红', '正面', validJpeg);
    const data = await res.json();
    createdFile = data.file;
    record('批量上传新增槽位成功（created=true）', res.status === 200 && data.ok && data.created === true && data.file === 'LP2136_测试红_正面.jpg', `status=${res.status}, file=${data.file}`);
    createdFiles.push(createdFile);
  }
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: adminHeaders() });
    const data = await res.json();
    const lp2136 = (data.models || []).find((m) => m.model === 'LP2136');
    const tc = lp2136 && lp2136.colors.find((c) => c.color === '测试红');
    record('工作台统计反映新增颜色 1/4 部分完整', res.status === 200 && !!lp2136 && lp2136.colorCount === 5 && !!tc && tc.present === 1 && !tc.complete && lp2136.images === 17, JSON.stringify(tc));
  }

  // ---------- 模拟自动回滚（删除新增槽位 + 移除新增颜色） ----------
  {
    const res = await removeImage('LP2136', '测试红', '正面');
    const data = await res.json();
    record('回滚：删除新增槽位成功（备份留痕）', res.status === 200 && data.ok && data.backup, `status=${res.status}, backup=${data.backup}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/LP2136/colors?color=${encodeURIComponent('测试红')}`, { method: 'DELETE', headers: adminHeaders() });
    record('回滚：移除新增颜色成功', res.status === 200 && res.ok && !(res.colors || []).includes('测试红'), `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: adminHeaders() });
    const data = await res.json();
    const lp2136 = (data.models || []).find((m) => m.model === 'LP2136');
    record('回滚后工作台恢复 4 色 16 图', res.status === 200 && !!lp2136 && lp2136.colorCount === 4 && lp2136.images === 16 && lp2136.completeColors === 4, JSON.stringify(lp2136 && { colorCount: lp2136.colorCount, images: lp2136.images }));
  }

  // ---------- 模拟「替换槽位 → 读取备份 → 重传还原」（手动撤销路径） ----------
  let originalHash = null;
  let replaceData = null;
  {
    const current = await readFile(path.join(imageDir, 'LP2136_黑色_正面.jpg'));
    originalHash = hex(current);
    const res = await uploadImage('LP2136', '黑色', '正面', validJpegVariant);
    replaceData = await res.json();
    record('替换既有槽位成功（created=false + 备份）', res.status === 200 && replaceData.ok && replaceData.created === false && replaceData.backup, `status=${res.status}, backup=${replaceData.backup}`);
  }
  {
    const current = await readFile(path.join(imageDir, 'LP2136_黑色_正面.jpg'));
    record('替换后文件为新内容', hex(current) === hex(validJpegVariant), `hash=${hex(current).slice(0, 12)}`);
  }
  let backupContent = null;
  {
    const res = await fetch(`${base}/api/admin/backup/${encodeURIComponent(replaceData.backup)}`, { headers: adminHeaders() });
    backupContent = Buffer.from(await res.arrayBuffer());
    record('备份读取返回 200 且为原图内容', res.status === 200 && (res.headers.get('content-type') || '').includes('image/jpeg') && hex(backupContent) === originalHash, `status=${res.status}, bytes=${backupContent.length}`);
  }
  {
    const res = await uploadImage('LP2136', '黑色', '正面', backupContent);
    const data = await res.json();
    record('撤销：重传备份原图成功', res.status === 200 && data.ok && data.created === false, `status=${res.status}`);
    const current = await readFile(path.join(imageDir, 'LP2136_黑色_正面.jpg'));
    record('撤销后槽位恢复为原图', hex(current) === originalHash, `hash=${hex(current).slice(0, 12)}`);
  }
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: adminHeaders() });
    const data = await res.json();
    const lp2136 = (data.models || []).find((m) => m.model === 'LP2136');
    record('撤销后 LP2136 黑色仍 4/4 完整', res.status === 200 && !!lp2136 && lp2136.completeColors === 4 && lp2136.images === 16, `status=${res.status}`);
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
    record('/admin 返回含图片补充的新管理页', res.status === 200 && text.includes('图片补充') && text.includes('图片巡检'), `status=${res.status}`);
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
