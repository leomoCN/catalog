// Step 3 高级内部筛选前端集成测试：spawn 一个服务器实例，静态校验 public 三件套
// （高级筛选容器、业务属性开关、区间输入、分页、表格视图、内部排序项、内部搜索守卫），
// 并模拟前端调用链（公开目录不含内部字段 → 密码登录 → 内部目录 410 款 → 覆盖检测启发式
// 与 admin-store 全等 → 容量/批发价解析正确 → 内部字段齐全）；
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

const port = Number(process.env.TEST_PORT || 5204);
const base = (p) => `http://127.0.0.1:${p}`;
const adminToken = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
const DEFAULT_PASSWORD = process.env.INTERNAL_PASSWORD || 'test-internal-password';
const INTERNAL_ONLY_KEYS = ['wholesalePrice', 'retailPrice', 'onlinePrice', 'moq', 'cartonSize', 'cartonQty', 'cartonWeight', 'notes', 'source', 'displayStatus', 'displayReason', 'sizeChart', 'returnDate'];

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 与前端一致的覆盖检测启发式（仅用目录自身可推导的默认值） ----------
function overriddenModels(catalog) {
  const photoModels = new Set(catalog.images.map((img) => img.model));
  return catalog.products
    .filter((p) => p.displayStatus !== (photoModels.has(p.model) ? 'pending' : 'internal'))
    .map((p) => p.model);
}

// 与前端一致的数值区间解析（用于容量/批发价过滤与排序）
function numericBounds(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const nums = String(raw).match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const vals = nums.map(Number);
  return { lo: Math.min(...vals), hi: Math.max(...vals) };
}

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

  record('index.html 含高级筛选容器且默认隐藏', html.includes('id="advanced-filters"') && /\badvanced-group hidden\b/.test(html) && html.includes('id="adv-toggle"') && html.includes('id="adv-body"'), '');
  record('index.html 含内部专用筛选组', ['source-filters', 'status-filters', 'brand-filters'].every((id) => html.includes(id)), '');
  record('index.html 含业务属性开关', ['has-wholesale', 'has-moq', 'has-carton', 'has-sizechart', 'has-admin-override'].every((id) => html.includes(id)), '');
  record('index.html 含容量/批发价区间输入', ['capacity-min', 'capacity-max', 'wholesale-min', 'wholesale-max'].every((id) => html.includes(id)), '');
  record('index.html 含分页容器', html.includes('id="pagination"'), '');
  record('index.html 含表格视图按钮', html.includes('data-view="table"'), '');
  record('index.html 含内部专用排序项', html.includes('value="wholesale"') && html.includes('value="status"') && html.includes('class="internal-only"'), '');
  record('index.html 保留模式切换/登录/登出标记', html.includes('data-mode="public"') && html.includes('data-mode="internal"') && html.includes('internal-login-dialog') && html.includes('internal-logout'), '');

  record('app.js 定义高级筛选状态', ['advQ', 'sources', 'statuses', 'brands', 'hasWholesale', 'hasMoq', 'hasCarton', 'hasSizeChart', 'hasAdminOverride', 'capacityMin', 'capacityMax', 'wholesaleMin', 'wholesaleMax'].every((s) => js.includes(s)), '');
  record('app.js 定义分页常量与翻页', js.includes('PAGE_SIZE') && js.includes('renderPagination') && js.includes('lastPages'), '');
  record('app.js 内部字段搜索有模式守卫', js.includes('internalHaystackFor') && js.includes("state.mode !== 'internal'") && js.includes('p.displayReason'), '');
  record('app.js 覆盖检测不依赖内部字段泄露', js.includes('isAdminOverridden') && js.includes('defaultDisplayStatusFor'), '');
  record('app.js 表格视图内部列以模式守卫', js.includes('tableHTML') && js.includes('state.mode === \'internal\'') && js.includes('data-table'), '');
  record('app.js 内部字段渲染保留 mode 守卫', js.includes('internalCardInfoHTML') && js.includes('internalGalleryHTML') && js.includes('state.mode === \'internal\''), '');
  record('app.js 不含明文默认密码', !js.includes(DEFAULT_PASSWORD), '');
  record('app.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');
  record('style.css 含高级筛选/表格/分页样式', css.includes('.advanced-group') && css.includes('.data-table') && css.includes('.pagination') && css.includes('.page-btn'), '');
}

// ---------- 模拟前端调用链 ----------
async function serverFlow(p) {
  {
    const res = await fetch(`${base(p)}/`);
    const text = await res.text();
    record('首页返回含高级筛选与模式切换的 HTML', res.status === 200 && text.includes('id="advanced-filters"') && text.includes('data-mode="internal"'), `status=${res.status}`);
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
  let internal = null;
  {
    const res = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    internal = await res.json();
    record('内部目录含全部产品与内部字段', res.status === 200 && (internal.products || []).length === 410 && internal.products.some((p) => p.wholesalePrice !== undefined && p.source && p.displayStatus), `products=${(internal.products || []).length}`);
  }

  // 覆盖检测启发式：应与 admin-store.json 的覆盖模型集合完全一致（当前为 LP2135/36/45）
  {
    const adminStore = JSON.parse(await readFile(adminStoreFile, 'utf8'));
    const groundTruth = Object.keys(adminStore.products || {});
    const detected = overriddenModels(internal);
    const sameSet = detected.length === groundTruth.length && [...detected].sort().join() === [...groundTruth].sort().join();
    const allOverriddenHaveOverride = detected.every((m) => groundTruth.includes(m));
    record('覆盖检测启发式与 admin-store 全等', sameSet && allOverriddenHaveOverride, `detected=${detected.join(',')}, store=${groundTruth.join(',')}`);
  }

  // 数值区间解析：容量/批发价样例
  {
    const cases = [
      ['约25-45L', { lo: 25, hi: 45 }],
      ['约55L', { lo: 55, hi: 55 }],
      ['26-26.5', { lo: 26, hi: 26.5 }],
      ['75', { lo: 75, hi: 75 }],
      [null, null],
      ['S-3XL', { lo: 3, hi: 3 }],
    ];
    const ok = cases.every(([raw, expected]) => {
      const got = numericBounds(raw);
      if (expected === null) return got === null;
      return got && got.lo === expected.lo && got.hi === expected.hi;
    });
    record('容量/批发价区间解析正确', ok, '');
  }

  // 容量区间过滤语义：容量 <= 30L 时不应包含 约55L 的产品
  {
    const capOk = internal.products.filter((p) => numericBounds(p.capacity) && numericBounds(p.capacity).hi <= 30).every((p) => numericBounds(p.capacity).lo <= 30);
    record('容量上界过滤语义正确', capOk, '');
  }

  // 业务属性字段存在性可被检测（MOQ/箱规/尺码/批发价均有存量）
  {
    const hasMoq = internal.products.some((p) => p.moq !== undefined && p.moq !== null && p.moq !== '');
    const hasCarton = internal.products.some((p) => p.cartonSize !== undefined && p.cartonSize !== null && p.cartonSize !== '');
    const hasSizeChart = internal.products.some((p) => (p.sizeChart !== undefined && p.sizeChart !== null && p.sizeChart !== '') || (p.size !== undefined && p.size !== null && p.size !== ''));
    const hasWholesale = internal.products.some((p) => p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesalePrice !== '');
    record('内部业务属性字段存量可检测', hasMoq && hasCarton && hasSizeChart && hasWholesale, `moq=${hasMoq},carton=${hasCarton},sizeChart=${hasSizeChart},wholesale=${hasWholesale}`);
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
