// 图片上传集成测试：spawn 一个服务器实例，覆盖成功替换与各类失败校验、审计与 /admin 路由，
// 结束后恢复原图、删除测试备份、还原 admin-store 与目录快照，确保不留测试产物。
import { spawn } from 'node:child_process';
import { copyFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { jpegSize } from './jpeg-size.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageDir = path.join(root, 'data', 'images');
const backupDir = path.join(root, 'data', 'images-backup');
const adminStoreFile = path.join(root, 'data', 'admin-store.json');
const internalPasswordFile = path.join(root, 'data', '.internal-password');
const catalogFile = path.join(root, 'data', 'catalog.json');
const publicCatalogFile = path.join(root, 'data', 'catalog.public.json');

const port = Number(process.env.TEST_PORT || 5199);
const base = `http://127.0.0.1:${port}`;
const token = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MB = 1024 * 1024;

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

const validJpeg = makeJpeg(1200, 1500); // 应与既有槽位同规格
const wrongSizeJpeg = makeJpeg(100, 100);
if (jpegSize(validJpeg)?.width !== 1200 || jpegSize(validJpeg)?.height !== 1500) {
  throw new Error('测试夹具失败：validJpeg 尺寸解析不正确');
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

function apiReq(pathname, options = {}) {
  return fetch(`${base}${pathname}`, {
    ...options,
    headers: { ...(options.headers || {}), 'Content-Type': 'image/jpeg' },
  });
}

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// 既有槽位：LP2136 / 黑色 / 正面
const target = { model: 'LP2136', color: '黑色', view: '正面', file: 'LP2136_黑色_正面.jpg' };
const targetQuery = `model=${encodeURIComponent(target.model)}&color=${encodeURIComponent(target.color)}&view=${encodeURIComponent(target.view)}`;

// 测试现场快照（结束后完全复原）
const snapshotFiles = [adminStoreFile, `${adminStoreFile}.bak`, internalPasswordFile, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);
const hadBackupDir = await stat(backupDir).then(() => true).catch(() => false);
const backupFilesBefore = hadBackupDir ? new Set(await readdir(backupDir)) : new Set();

const originalBytes = await readFile(path.join(imageDir, target.file));
const originalHash = hex(originalBytes);

async function main() {
  await waitForServer();

  // ---------- 认证与既有行为 ----------
  {
    const res = await fetch(`${base}/api/admin/auth-check`);
    const data = await res.json();
    record('auth-check 免鉴权返回 authenticated=false', res.status === 200 && data.authenticated === false, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/catalog`);
    record('公开目录无令牌可访问', res.status === 200, `status=${res.status}`);
  }

  // ---------- 上传校验 ----------
  {
    const res = await apiReq(`/api/admin/images/upload?${targetQuery}`, { method: 'POST', body: Buffer.from([0x00, 0x01, 0x02, 0x03]) });
    record('未认证上传返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await apiReq(`/api/admin/images/upload`, { method: 'POST', body: validJpeg, headers: { Authorization: `Bearer ${token}` } });
    record('缺少 model/color/view 返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    // 新槽位（既有型号但没有该颜色的图片槽位）
    const res = await apiReq(`/api/admin/images/upload?model=LP2136&color=${encodeURIComponent('红色')}&view=${encodeURIComponent('正面')}`, { method: 'POST', body: validJpeg, headers: { Authorization: `Bearer ${token}` } });
    record('新槽位返回 409', res.status === 409, `status=${res.status}`);
  }
  {
    const res = await apiReq(`/api/admin/images/upload?${targetQuery}`, { method: 'POST', body: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), headers: { Authorization: `Bearer ${token}` } });
    record('非 JPEG 返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await apiReq(`/api/admin/images/upload?${targetQuery}`, { method: 'POST', body: wrongSizeJpeg, headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    record('尺寸不符返回 400', res.status === 400 && /1200×1500/.test(data.error || ''), `status=${res.status}, error=${data.error}`);
  }
  {
    const big = Buffer.alloc(20 * MB + 1);
    const res = await apiReq(`/api/admin/images/upload?${targetQuery}`, { method: 'POST', body: big, headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    record('超过 20MB 返回 400', res.status === 400 && /20MB/.test(data.error || ''), `status=${res.status}, error=${data.error}`);
  }

  // ---------- 成功替换 ----------
  let uploadData = null;
  {
    const res = await apiReq(`/api/admin/images/upload?${targetQuery}`, { method: 'POST', body: validJpeg, headers: { Authorization: `Bearer ${token}` } });
    uploadData = await res.json();
    record('成功替换返回 200', res.status === 200, `status=${res.status}, body=${JSON.stringify(uploadData)}`);
    record('返回字段齐全', !!(uploadData && uploadData.ok && uploadData.file === target.file && uploadData.backup && uploadData.sha256), JSON.stringify(uploadData || null));
  }
  {
    const replaced = await readFile(path.join(imageDir, target.file));
    record('文件被替换为新内容', hex(replaced) === hex(validJpeg), `hash=${hex(replaced).slice(0, 12)}`);
  }
  {
    const backupContent = uploadData ? await readFile(path.join(backupDir, uploadData.backup)) : Buffer.alloc(0);
    record('备份内容为原图', hex(backupContent) === originalHash, `backup=${uploadData && uploadData.backup}`);
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    const internal = await res.json();
    const still = internal.images.some((img) => img.model === target.model && img.color === target.color && img.view === target.view && img.file === target.file);
    record('替换后槽位仍在目录中', res.status === 200 && still, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/internal/image/${encodeURIComponent(target.file)}?v=1`, { headers: { Authorization: `Bearer ${token}` } });
    const bytes = Buffer.from(await res.arrayBuffer());
    record('内部图片接口返回替换后的图片', res.status === 200 && hex(bytes) === hex(validJpeg), `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/audit`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const entry = (data.audit || []).find((e) => e.action === 'image-upload' && e.model === target.model);
    record('审计新增 image-upload 记录', res.status === 200 && !!entry, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/audit`);
    record('审计接口未认证返回 401', res.status === 401, `status=${res.status}`);
  }

  // ---------- /admin 路由与缓存头 ----------
  {
    const res = await fetch(`${base}/admin`);
    const text = await res.text();
    record('/admin 返回管理页', res.status === 200 && text.includes('图片巡检'), `status=${res.status}`);
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
