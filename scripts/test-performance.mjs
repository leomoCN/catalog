// 部署前性能测试：spawn 一个临时服务器实例（默认端口 5213，可用 TEST_PORT 覆盖），
// 对公开与内部端点做延迟探针（每端点 1 次预热 + PERF_ITERATIONS 次采样（默认 5），
// 统计 min/avg/max/p95，断言全部成功且 avg < PERF_MAX_AVG_MS（默认 1000ms）、
// p95 < PERF_MAX_P95_MS（默认 2500ms））；内部探测先尝试默认密码登录——成功则用
// 内部会话令牌探测 /api/internal/*，失败（已配置自定义 INTERNAL_PASSWORD）则回退为
// 管理 Bearer 探测并记录跳过，兼容自定义密码环境。随后检查服务器日志不含管理令牌/
// 密码/会话令牌、带 ADMIN_TOKEN 启动不改写 data/.admin-token；结束后还原 admin-store /
// 目录 / .internal-password / .admin-token 快照、杀服务器、清理残留临时文件、确认
// 运行时文件与快照一致（无泄漏）并重跑 validate-catalog，不留测试产物。
import { spawn } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const internalPasswordFile = path.join(dataDir, '.internal-password');
const adminTokenFile = path.join(dataDir, '.admin-token');
const adminStoreFile = path.join(dataDir, 'admin-store.json');
const catalogFile = path.join(dataDir, 'catalog.json');
const publicCatalogFile = path.join(dataDir, 'catalog.public.json');

const port = Number(process.env.TEST_PORT || 5213);
const base = `http://127.0.0.1:${port}`;
const adminToken = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
const DEFAULT_PASSWORD = process.env.INTERNAL_PASSWORD || 'test-internal-password';

const iterations = Math.max(1, Number(process.env.PERF_ITERATIONS || 5));
const MAX_AVG_MS = Number(process.env.PERF_MAX_AVG_MS || 1000);
const MAX_P95_MS = Number(process.env.PERF_MAX_P95_MS || 2500);

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 测试现场快照（结束后完全复原，无泄漏） ----------
const snapshotFiles = [
  adminTokenFile, internalPasswordFile, adminStoreFile, `${adminStoreFile}.bak`,
  catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`,
];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);

// ---------- 服务器 ----------
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_TOKEN: adminToken },
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

async function stopServer() {
  if (server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
  }
}

// ---------- 延迟探针 ----------
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length * p) / 100) - 1));
  return sorted[idx];
}

async function probe(name, request) {
  await request(); // 预热（首次冷启动不计入采样）
  const samples = [];
  const statuses = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    let res;
    try {
      res = await request();
    } catch (error) {
      statuses.push('ERR');
      samples.push(performance.now() - start);
      continue;
    }
    samples.push(performance.now() - start);
    statuses.push(res.status);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95 = percentile(sorted, 95);
  const stats = {
    n: samples.length,
    min: +sorted[0].toFixed(1),
    avg: +avg.toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1),
    p95: +p95.toFixed(1),
  };
  const allOk = statuses.every((s) => s === 200);
  const ok = allOk && avg < MAX_AVG_MS && p95 < MAX_P95_MS;
  record(name, ok, `status=${[...new Set(statuses)].join(',')} min=${stats.min}ms avg=${stats.avg}ms max=${stats.max}ms p95=${stats.p95}ms`);
  return { ok, stats };
}

// ---------- 主流程 ----------
async function main() {
  await waitForServer();

  // 预取公开目录：取一张公开图片做图片探针，并记录产品/图片计数
  const catalogRes = await fetch(`${base}/api/catalog`);
  const publicCatalog = await catalogRes.json();
  const imageFile = (publicCatalog.images && publicCatalog.images[0] && publicCatalog.images[0].file) || 'LP2136_黑色_正面.jpg';
  record('公开目录可加载', catalogRes.status === 200 && (publicCatalog.products || []).length > 0,
    `status=${catalogRes.status}, products=${(publicCatalog.products || []).length}`);
  record('公开目录含图片', (publicCatalog.images || []).length > 0,
    `images=${(publicCatalog.images || []).length}`);

  // ---------- 公开端点延迟探针 ----------
  const probeResults = {};
  const publicEndpoints = [
    ['GET /api/health', () => fetch(`${base}/api/health`)],
    ['GET /api/catalog', () => fetch(`${base}/api/catalog`)],
    ['GET /api/products', () => fetch(`${base}/api/products`)],
    ['GET /api/products?q=Backpack（英文检索）', () => fetch(`${base}/api/products?q=Backpack`)],
    [`GET /api/image/${imageFile}（流式）`, async () => { const r = await fetch(`${base}/api/image/${encodeURIComponent(imageFile)}`); await r.arrayBuffer(); return r; }],
    ['GET /（首页）', () => fetch(`${base}/`)],
    ['GET /admin（管理页）', () => fetch(`${base}/admin`)],
    ['GET /static/admin.js', () => fetch(`${base}/static/admin.js`)],
  ];
  for (const [name, request] of publicEndpoints) {
    probeResults[name] = await probe(name, request);
  }

  // ---------- 内部端点：可选内部登录 + 管理 Bearer 探测 ----------
  let internalToken = null;
  {
    const res = await fetch(`${base}/api/internal/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    });
    if (res.status === 200) {
      const data = await res.json();
      internalToken = data.token;
      record('内部登录（默认密码）可用', !!internalToken, `status=${res.status}`);
      probeResults['POST /api/internal/login（延迟）'] = await probe('POST /api/internal/login（延迟）', () =>
        fetch(`${base}/api/internal/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: DEFAULT_PASSWORD }),
        }));
    } else {
      record('内部登录（默认密码）跳过（已配置自定义 INTERNAL_PASSWORD）', true, `status=${res.status}`);
    }
  }

  // 管理 Bearer：无论登录是否成功都探测内部端点（内部接口接受管理 Bearer）
  probeResults['GET /api/internal/catalog（管理 Bearer）'] = await probe('GET /api/internal/catalog（管理 Bearer）', () =>
    fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${adminToken}` } }));
  probeResults['GET /api/internal/image（管理 Bearer，流式）'] = await probe('GET /api/internal/image（管理 Bearer，流式）', async () => {
    const r = await fetch(`${base}/api/internal/image/${encodeURIComponent(imageFile)}`, { headers: { Authorization: `Bearer ${adminToken}` } });
    await r.arrayBuffer();
    return r;
  });
  probeResults['GET /api/admin/audit（管理 Bearer）'] = await probe('GET /api/admin/audit（管理 Bearer）', () =>
    fetch(`${base}/api/admin/audit`, { headers: { Authorization: `Bearer ${adminToken}` } }));
  probeResults['GET /api/admin/auth-check'] = await probe('GET /api/admin/auth-check', () =>
    fetch(`${base}/api/admin/auth-check`, { headers: { Authorization: `Bearer ${adminToken}` } }));

  if (internalToken) {
    probeResults['GET /api/internal/catalog（内部会话）'] = await probe('GET /api/internal/catalog（内部会话）', () =>
      fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${internalToken}` } }));
    probeResults['GET /api/internal/session（内部会话）'] = await probe('GET /api/internal/session（内部会话）', () =>
      fetch(`${base}/api/internal/session`, { headers: { Authorization: `Bearer ${internalToken}` } }));
    const logoutRes = await fetch(`${base}/api/internal/logout`, { method: 'POST', headers: { Authorization: `Bearer ${internalToken}` } });
    record('内部会话可登出（探针结束清理会话）', logoutRes.status === 200, `status=${logoutRes.status}`);
  } else {
    record('内部会话探测跳过（未取得内部会话令牌，回退为管理 Bearer 探测）', true, '');
  }

  // 输出延迟统计表
  console.log('\n延迟统计（ms）：');
  for (const [name, p] of Object.entries(probeResults)) {
    const s = p.stats;
    console.log(`  ${name.padEnd(48)} n=${s.n} min=${s.min} avg=${s.avg} max=${s.max} p95=${s.p95}`);
  }

  // ---------- 无泄漏检查 ----------
  await new Promise((r) => setTimeout(r, 100)); // 等待 stdout 刷新
  {
    const leaked = [adminToken, DEFAULT_PASSWORD, internalToken].filter((t) => t && serverLog.includes(t));
    record('服务器日志不含管理令牌/内部密码/会话令牌', leaked.length === 0,
      leaked.length ? `泄漏片段=${leaked.map((t) => t.slice(0, 8)).join('|')}` : '');
  }
  {
    const current = (await readFile(adminTokenFile, 'utf8').catch(() => null))?.trim() || null;
    const before = (snapshot[adminTokenFile] || '').trim() || null;
    record('ADMIN_TOKEN 环境变量启动不改写 .admin-token', current === before,
      `before=${before ? '存在' : '无'}, after=${current ? '存在' : '无'}`);
  }
}

// ---------- 清理与收尾 ----------
async function cleanup() {
  await stopServer();
  // 还原运行时文件快照
  for (const file of snapshotFiles) {
    if (snapshot[file] === null) await rm(file, { force: true });
    else await writeFile(file, snapshot[file]);
  }
  // 清理 data 下残留的临时文件（.internal-password.tmp-* 等），不影响正式文件
  try {
    const entries = await readdir(dataDir);
    for (const name of entries) {
      if (!name) continue;
      const f = path.join(dataDir, name);
      if (snapshotFiles.includes(f)) continue;
      if (name.startsWith('.internal-password') || name.includes('.tmp-')) await rm(f, { force: true });
    }
  } catch { /* data 目录不存在 */ }
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

// ---------- 最终校验：恢复后运行时文件与快照一致（无泄漏）且 validate 通过 ----------
{
  let leakFree = true;
  for (const file of snapshotFiles) {
    const now = await readFile(file, 'utf8').catch(() => null);
    if ((now === null) !== (snapshot[file] === null) || (now !== null && now !== snapshot[file])) leakFree = false;
  }
  record('清理后运行时文件与快照一致（无泄漏）', leakFree, '');
}
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
