// 双语客户展示 + 移动端筛选抽屉/图库（Step 4）集成测试：
// - 静态校验 public 三件套：语言切换标记、移动端悬浮工具栏与底部抽屉、统一翻译字典（I18N）、
//   客户界面翻译不触碰内部模式（内部仍中文）、移动端图库主图 4:5、
//   既有内部模式/高级筛选/鉴权标记全部保留（回归）；
// - 模拟前端调用链（公开目录不含内部字段 → 内部 401 → 密码登录 → 内部目录 410 款 → 公开接口回归）；
// 结束后还原 admin-store/目录/.internal-password 快照并重跑校验，不留测试产物。
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

const port = Number(process.env.TEST_PORT || 5205);
const base = (p) => `http://127.0.0.1:${p}`;
const adminToken = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
const DEFAULT_PASSWORD = process.env.INTERNAL_PASSWORD || 'test-internal-password';
const INTERNAL_ONLY_KEYS = ['wholesalePrice', 'retailPrice', 'onlinePrice', 'moq', 'cartonSize', 'cartonQty', 'cartonWeight', 'notes', 'source', 'displayStatus', 'displayReason'];

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 测试现场快照（结束后完全复原） ----------
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

  // 语言切换（客户展示模式）
  record('index.html 含语言切换控件', html.includes('id="lang-switch"') && ['data-lang="zh"', 'data-lang="en"', 'data-lang="bilingual"'].every((m) => html.includes(m)), '');
  record('index.html 使用 data-i18n 静态翻译标记', html.includes('data-i18n=') && html.includes('data-i18n-ph='), '');
  record('index.html 保留客户/内部模式切换标记', html.includes('data-mode="public"') && html.includes('data-mode="internal"'), '');

  // 移动端悬浮工具栏与底部抽屉
  record('index.html 含移动端悬浮工具栏', html.includes('id="mobile-toolbar"') && html.includes('id="mobile-search"') && html.includes('id="mobile-count"') && html.includes('id="mobile-lang"') && html.includes('id="mobile-filter-btn"'), '');
  record('index.html 含筛选抽屉头/尾/遮罩', html.includes('id="drawer-header"') && html.includes('id="drawer-close"') && html.includes('id="drawer-clear"') && html.includes('id="drawer-apply"') && html.includes('id="drawer-backdrop"'), '');

  // app.js 翻译字典与语言逻辑
  record('app.js 定义统一翻译字典 I18N（zh/en）', js.includes('const I18N') && js.includes('I18N.zh') && js.includes('I18N.en'), '');
  record('app.js 定义 t() 翻译函数与语言状态', js.includes('function t(') && js.includes('state.lang') && js.includes('LANG_MODES'), '');
  record('app.js 翻译仅客户模式生效（内部固定中文）', js.includes("state.mode === 'public'") && js.includes("state.mode !== 'public'"), '');
  record('app.js 含语言应用/切换入口', js.includes('applyLanguage') && js.includes('setLang(') && js.includes('renderStaticLabels'), '');
  record('app.js 含抽屉开合与滚动锁定逻辑', js.includes('openFiltersDrawer') && js.includes('closeFiltersDrawer') && js.includes('drawer-open'), '');
  record('app.js 语言偏好写入 localStorage', js.includes('localStorage.setItem(\'langPref\'') || js.includes('langPref'), '');

  // 既有功能回归标记
  record('app.js 保留内部模式端点与守卫', ['/api/internal/login', '/api/internal/session', '/api/internal/logout', '/api/internal/catalog'].every((s) => js.includes(s)) && js.includes('state.mode === \'internal\''), '');
  record('app.js 保留高级筛选与内部字段渲染守卫', js.includes('internalHaystackFor') && js.includes('internalCardInfoHTML') && js.includes('internalGalleryHTML'), '');
  record('app.js 不含明文默认密码', !js.includes(DEFAULT_PASSWORD), '');
  record('app.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');

  // style.css：移动工具栏 / 抽屉 / 图库主图 4:5
  record('style.css 含移动端悬浮工具栏样式', css.includes('.mobile-toolbar'), '');
  record('style.css 含抽屉开合与滚动锁定样式', css.includes('body.drawer-open') && css.includes('.drawer-backdrop') && css.includes('body.drawer-open .filters'), '');
  const m760 = css.match(/@media\(max-width:760px\)([\s\S]*?)(?=@media|$)/g);
  record('style.css 移动端图库主图保持 4:5', (m760 || []).some((b) => b.includes('.g-main') && b.includes('aspect-ratio:4/5') && b.includes('max-height:none')), '');

  // 内部模式仍中文：登录对话框 / 高级筛选标题不被翻译字典替换为英文
  record('内部登录与高级筛选保持中文文案', html.includes('内部查询登录') && html.includes('高级筛选 · 内部'), '');
}

// ---------- 模拟前端调用链 ----------
async function serverFlow(p) {
  {
    const res = await fetch(`${base(p)}/`);
    const text = await res.text();
    record('首页返回含语言切换/移动工具栏/抽屉的 HTML', res.status === 200 && text.includes('id="lang-switch"') && text.includes('id="mobile-toolbar"') && text.includes('id="drawer-backdrop"') && text.includes('data-mode="internal"'), `status=${res.status}`);
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
    record('内部目录含全部产品与内部字段', res.status === 200 && (data.products || []).length === 410 && data.products.some((p) => p.wholesalePrice !== undefined && p.displayStatus !== undefined), `products=${(data.products || []).length}`);
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
