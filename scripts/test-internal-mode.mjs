// Step 2 前端模式切换集成测试：spawn 一个服务器实例，静态校验 public 三件套
// （模式切换标记、内部端点引用、内部字段仅内部模式渲染、前端不含明文密码、脚本语法有效），
// 并模拟前端完整调用链（公开目录不含内部字段 → 未认证 401 → 密码登录 → 内部目录 410 款含内部字段
// → 会话探测 → logout 后 401 → 公开接口回归）；
// 结束后还原 admin-store/目录/.internal-password 快照、删除测试残留并重跑校验，不留测试产物。
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const internalPasswordFile = path.join(dataDir, '.internal-password');
const adminStoreFile = path.join(dataDir, 'admin-store.json');
const catalogFile = path.join(dataDir, 'catalog.json');
const publicCatalogFile = path.join(dataDir, 'catalog.public.json');

const port = Number(process.env.TEST_PORT || 5203);
const base = (p) => `http://127.0.0.1:${p}`;
const adminToken = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
const DEFAULT_PASSWORD = process.env.INTERNAL_PASSWORD || 'test-internal-password';
const INTERNAL_ONLY_KEYS = ['wholesalePrice', 'retailPrice', 'onlinePrice', 'moq', 'cartonSize', 'cartonQty', 'cartonWeight', 'notes', 'source', 'displayStatus', 'displayReason'];

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 测试现场快照（结束后完全复原；admin-store/公开目录当前可能非初始状态） ----------
const snapshotFiles = [internalPasswordFile, adminStoreFile, `${adminStoreFile}.bak`, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);

// ---------- 服务器 ----------
function startServer(p) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(p), HOST: '127.0.0.1', ADMIN_TOKEN: adminToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  return { child: server, log: () => serverLog };
}

async function waitForServer(srv, p) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base(p)}/api/health`);
      if (res.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务器启动超时。日志：\n${srv.log()}`);
}

async function stopServer(srv) {
  srv.child.kill();
  await new Promise((resolve) => {
    srv.child.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
}

// ---------- 静态前端校验 ----------
async function staticChecks() {
  const [html, js, css] = await Promise.all([
    readFile(path.join(publicDir, 'index.html'), 'utf8'),
    readFile(path.join(publicDir, 'app.js'), 'utf8'),
    readFile(path.join(publicDir, 'style.css'), 'utf8'),
  ]);

  record('index.html 含模式切换按钮', html.includes('data-mode="public"') && html.includes('data-mode="internal"'), '');
  record('index.html 含内部登录对话框', html.includes('internal-login-dialog') && html.includes('internal-password'), '');
  record('index.html 含退出内部按钮', html.includes('internal-logout'), '');

  record('app.js 引用内部登录接口', js.includes('/api/internal/login'), '');
  record('app.js 引用会话探测接口', js.includes('/api/internal/session'), '');
  record('app.js 引用登出接口', js.includes('/api/internal/logout'), '');
  record('app.js 引用内部目录接口', js.includes('/api/internal/catalog'), '');
  record('app.js 使用 sessionStorage 内部令牌键', js.includes('internalToken'), '');
  record('app.js 内部字段渲染以 mode 守卫', js.includes("state.mode === 'internal'") && js.includes('internalCardInfoHTML') && js.includes('internalGalleryHTML'), '');
  record('app.js 不含明文默认密码', !js.includes(DEFAULT_PASSWORD), '');
  record('app.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');
  record('style.css 含模式切换与内部字段样式', css.includes('.mode-switch') && css.includes('#internal-login-dialog') && css.includes('.internal-panel'), '');
}

// ---------- 模拟前端调用链 ----------
async function serverFlow(p) {
  {
    const res = await fetch(`${base(p)}/`);
    const text = await res.text();
    record('首页返回含模式切换与登录对话框的 HTML', res.status === 200 && text.includes('data-mode="internal"') && text.includes('internal-login-dialog'), `status=${res.status}`);
  }
  {
    const res = await fetch(`${base(p)}/api/catalog`);
    const data = await res.json();
    const leaked = (data.products || []).filter((product) => INTERNAL_ONLY_KEYS.some((k) => Object.prototype.hasOwnProperty.call(product, k)));
    record('公开目录不含内部业务/审核字段', res.status === 200 && leaked.length === 0, `products=${(data.products || []).length}, leaked=${leaked.length}`);
  }
  {
    const res = await fetch(`${base(p)}/api/internal/catalog`);
    record('内部目录无凭证返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base(p)}/api/internal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
    record('错误密码返回 401', res.status === 401, `status=${res.status}`);
  }
  let token = null;
  {
    const res = await fetch(`${base(p)}/api/internal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: DEFAULT_PASSWORD }) });
    const data = await res.json();
    token = data.token;
    record('默认密码登录成功返回 token', res.status === 200 && !!token, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const withFields = (data.products || []).filter((product) => product.wholesalePrice !== undefined && product.displayStatus !== undefined);
    record('内部目录含全部产品与内部字段', res.status === 200 && (data.products || []).length === 410 && withFields.length > 0, `products=${(data.products || []).length}, withFields=${withFields.length}`);
  }
  {
    const res = await fetch(`${base(p)}/api/internal/session`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    record('会话探测返回 authenticated+source=internal', res.status === 200 && data.authenticated === true && data.source === 'internal', JSON.stringify(data));
  }
  {
    const res = await fetch(`${base(p)}/api/internal/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    record('logout 成功返回 200', res.status === 200, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    record('logout 后原令牌访问内部目录返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base(p)}/api/products?q=LP2136`);
    record('公开产品接口无需凭证可访问', res.status === 200, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base(p)}/api/health`);
    record('健康检查无需凭证可访问', res.status === 200, `status=${res.status}`);
  }
}

// ---------- 清理与收尾 ----------
async function cleanup() {
  for (const file of snapshotFiles) {
    if (snapshot[file] === null) await rm(file, { force: true });
    else await writeFile(file, snapshot[file]);
  }
  try {
    const entries = await readdir(dataDir);
    for (const name of entries) {
      if (name.startsWith('.internal-password')) {
        const f = path.join(dataDir, name);
        if (!snapshotFiles.includes(f)) await rm(f, { force: true });
      }
    }
  } catch { /* data 目录不存在 */ }
}

let failed = false;
let srv = null;
try {
  await staticChecks();
  srv = startServer(port);
  await waitForServer(srv, port);
  await serverFlow(port);
} catch (error) {
  failed = true;
  results.push({ name: '测试执行异常', passed: false, detail: error.stack || error.message });
} finally {
  if (srv) await stopServer(srv).catch(() => {});
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
