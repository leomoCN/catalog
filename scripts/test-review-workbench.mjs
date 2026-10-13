// 审核工作台（图片补充 + 审核就绪）集成测试：
// - 静态校验后台三件套：分类/就绪度筛选、就绪度与分类分布统计、每产品分类/就绪度徽标、
//   快速审核动作（公开/待审核/隐藏/清除覆盖/编辑，复用既有状态接口）、既有工作台标记回归、脚本语法有效；
// - 行为校验：scripts/review-readiness.mjs 纯函数（assessReadiness 分级 / buildReadinessCounts / buildCategoryCounts）；
// - 通过受保护 API 覆盖工作台统计扩展（未认证 401、410 款产品、每款携带
//   category/categoryStatus/displayReason/statusOverridden/imageComplete/readiness、
//   totals.readinessCounts/byCategory 汇总一致）、
//   快速审核动作复用既有状态接口（public/hidden 无原因 400、设置 pending 生效、清除覆盖回落、公开目录随之增减）、
//   审计留痕、/admin 路由回归；
// 结束后还原 admin-store/目录快照并重跑校验，不留测试产物。
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { assessReadiness, buildReadinessCounts, buildCategoryCounts, READINESS_ORDER, READINESS_LABELS } from './review-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const adminStoreFile = path.join(root, 'data', 'admin-store.json');
const internalPasswordFile = path.join(root, 'data', '.internal-password');
const catalogFile = path.join(root, 'data', 'catalog.json');
const publicCatalogFile = path.join(root, 'data', 'catalog.public.json');
const categoryReviewFile = path.join(root, 'data', 'category-review.json');

const port = Number(process.env.TEST_PORT || 5211);
const base = `http://127.0.0.1:${port}`;
const token = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 测试现场快照（结束后完全复原） ----------
const snapshotFiles = [adminStoreFile, `${adminStoreFile}.bak`, internalPasswordFile, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`, categoryReviewFile, `${categoryReviewFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);

// ---------- 静态前端校验 ----------
async function staticChecks() {
  const [html, js, css] = await Promise.all([
    readFile(path.join(publicDir, 'admin.html'), 'utf8'),
    readFile(path.join(publicDir, 'admin.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin.css'), 'utf8'),
  ]);

  record('admin.html 含分类/就绪度筛选', html.includes('id="wb-filter-category"') && html.includes('id="wb-filter-readiness"') && html.includes('value="needs-images"') && html.includes('value="needs-category"') && html.includes('value="needs-both"'), '');
  record('admin.html 工作台统计/进度区域回归', html.includes('id="workbench-stats"') && html.includes('id="workbench-models"') && html.includes('id="wb-filter-q"') && html.includes('id="wb-filter-series"') && html.includes('id="wb-filter-status"') && html.includes('id="wb-filter-completeness"'), '');
  record('admin.html 批量选择器回归', html.includes('id="batch-file-input"') && html.includes('multiple') && html.includes('id="batch-dropzone"'), '');
  record('admin.html 既有标签回归', html.includes('data-tab="products"') && html.includes('data-tab="workbench"') && html.includes('data-tab="images"') && html.includes('data-tab="audit"'), '');

  record('admin.js 就绪度常量与渲染', js.includes('READINESS_ORDER') && js.includes('READINESS_LABELS') && js.includes('renderWorkbench') && js.includes('renderWorkbenchModels') && js.includes('populateWorkbenchFilters'), '');
  record('admin.js 分类/就绪度筛选逻辑', js.includes('workbenchFilter.category') && js.includes('workbenchFilter.readiness') && js.includes('wb-filter-category') && js.includes('wb-filter-readiness'), '');
  record('admin.js 快速审核动作函数', js.includes('function setWorkbenchStatus') && js.includes('function clearWorkbenchStatus') && js.includes('data-wb-set-status') && js.includes('data-wb-clear-status') && js.includes('data-wb-edit'), '');
  record('admin.js 快速审核复用既有状态接口', js.includes('/api/admin/products/') && js.includes('/status') && js.includes('/api/admin/workbench'), '');
  record('admin.js 分类徽标/就绪徽标/覆盖标记', js.includes('wb-cat') && js.includes('wb-readiness') && js.includes('readiness-') && js.includes('statusOverridden') && js.includes('override-badge'), '');
  record('admin.js 审核原因展示', js.includes('wb-reason') && js.includes('displayReason'), '');
  record('admin.js 既有弹窗/批量标记回归', js.includes('parseFileName') && js.includes('startBatch') && js.includes('undoLastBatch') && js.includes('dialog-image-slots') && js.includes('data-dialog-replace'), '');
  record('admin.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');

  record('admin.css 就绪度徽标样式', css.includes('.wb-readiness') && css.includes('.readiness-ready') && css.includes('.readiness-needs-images') && css.includes('.readiness-needs-category') && css.includes('.readiness-needs-both'), '');
  record('admin.css 分类徽标/快速动作样式', css.includes('.wb-cat') && css.includes('.wb-quick-actions') && css.includes('.wb-reason') && css.includes('.wb-cat-chip'), '');
  record('admin.css 既有工作台样式回归', css.includes('.wb-color-chip') && css.includes('.wb-progress-bar') && css.includes('.wb-stat') && css.includes('.batch-dropzone'), '');
}

// ---------- 纯函数行为校验（scripts/review-readiness.mjs） ----------
function readinessUnitChecks() {
  const fullProduct = { variants: [{ complete: true }, { complete: true }], categoryStatus: 'approved' };
  const missingProduct = { variants: [{ complete: true }, { complete: false }], categoryStatus: 'approved' };
  const pendingCatProduct = { variants: [{ complete: true }, { complete: true }], categoryStatus: 'pending' };
  const bothProduct = { variants: [{ complete: false }, { complete: false }], categoryStatus: 'pending' };
  const zeroColorProduct = { variants: [], categoryStatus: 'approved' };

  const r1 = assessReadiness(fullProduct);
  record('assessReadiness 图片完整+分类确认 → ready', r1.imageComplete && !r1.needsCategory && r1.readiness === 'ready', JSON.stringify(r1));
  const r2 = assessReadiness(missingProduct);
  record('assessReadiness 图片未完整+分类确认 → needs-images', !r2.imageComplete && !r2.needsCategory && r2.readiness === 'needs-images', JSON.stringify(r2));
  const r3 = assessReadiness(pendingCatProduct);
  record('assessReadiness 图片完整+分类待确认 → needs-category', r3.imageComplete && r3.needsCategory && r3.readiness === 'needs-category', JSON.stringify(r3));
  const r4 = assessReadiness(bothProduct);
  record('assessReadiness 图片未完整+分类待确认 → needs-both', !r4.imageComplete && r4.needsCategory && r4.readiness === 'needs-both', JSON.stringify(r4));
  const r5 = assessReadiness(zeroColorProduct);
  record('assessReadiness 零颜色组合视为未完整', !r5.imageComplete && r5.readiness === 'needs-images', JSON.stringify(r5));

  const counts = buildReadinessCounts([
    { readiness: 'ready' }, { readiness: 'ready' }, { readiness: 'needs-images' }, { readiness: 'needs-category' }, { readiness: 'needs-both' },
  ]);
  record('buildReadinessCounts 计数正确', counts.ready === 2 && counts['needs-images'] === 1 && counts['needs-category'] === 1 && counts['needs-both'] === 1, JSON.stringify(counts));
  const catCounts = buildCategoryCounts([
    { category: '双肩背包' }, { category: '双肩背包' }, { category: '配件' }, { category: '' },
  ]);
  record('buildCategoryCounts 分类分布正确', catCounts['双肩背包'] === 2 && catCounts['配件'] === 1 && catCounts[''] === 1, JSON.stringify(catCounts));
  record('READINESS_ORDER/LABELS 齐全', READINESS_ORDER.length === 4 && READINESS_ORDER.every((k) => READINESS_LABELS[k]), READINESS_ORDER.join(','));
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

function adminHeaders() { return { Authorization: `Bearer ${token}` }; }
function jsonHeaders() { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }

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

  // ---------- 工作台统计 API：认证与新增字段 ----------
  {
    const res = await fetch(`${base}/api/admin/workbench`);
    record('工作台统计未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  let workbench = null;
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: adminHeaders() });
    const data = await res.json();
    workbench = data;
    record('工作台统计返回 200 且覆盖全部产品', res.status === 200 && data.totals && data.totals.products === 410 && (data.models || []).length === 410, `status=${res.status}, products=${data.totals && data.totals.products}`);
  }
  {
    const models = workbench.models || [];
    const missingField = models.find((m) => !m || typeof m.category !== 'string' || typeof m.categoryStatus !== 'string' || typeof m.displayReason !== 'string' || typeof m.statusOverridden !== 'boolean' || typeof m.imageComplete !== 'boolean' || typeof m.readiness !== 'string');
    record('每款携带 分类/分类状态/审核原因/是否覆盖/图片完整/就绪度', !missingField, missingField ? `缺少字段：${JSON.stringify(missingField && { model: missingField.model, category: missingField.category, readiness: missingField.readiness })}` : '');
  }
  {
    const totals = workbench.totals || {};
    const rc = totals.readinessCounts || {};
    const sum = READINESS_ORDER.reduce((n, k) => n + (Number(rc[k]) || 0), 0);
    record('totals.readinessCounts 求和等于产品数', sum === totals.products, `sum=${sum}, products=${totals.products}`);
    const catSum = Object.values(totals.byCategory || {}).reduce((n, v) => n + Number(v) || 0, 0);
    record('totals.byCategory 求和等于产品数', catSum === totals.products, `sum=${catSum}, products=${totals.products}, keys=${Object.keys(totals.byCategory || {}).length}`);
  }
  {
    const lp2136 = (workbench.models || []).find((m) => m.model === 'LP2136');
    record('LP2136 图片完整且就绪（4 色 × 4 视角，分类已确认）', !!lp2136 && lp2136.imageComplete && lp2136.readiness === 'ready' && lp2136.completeColors === 4, JSON.stringify(lp2136 && { imageComplete: lp2136.imageComplete, readiness: lp2136.readiness, completeColors: lp2136.completeColors }));
  }
  {
    const bl012 = (workbench.models || []).find((m) => m.model === 'BL012');
    record('BL012 无图且待补图', !!bl012 && !bl012.imageComplete && bl012.readiness === 'needs-images' && bl012.images === 0, JSON.stringify(bl012 && { readiness: bl012.readiness, images: bl012.images }));
  }
  {
    const lp2136 = (workbench.models || []).find((m) => m.model === 'LP2136');
    const bl012 = (workbench.models || []).find((m) => m.model === 'BL012');
    record('statusOverridden 反映 admin-store 覆盖', !!lp2136 && lp2136.statusOverridden === true && !!bl012 && bl012.statusOverridden === false, `LP2136=${lp2136 && lp2136.statusOverridden}, BL012=${bl012 && bl012.statusOverridden}`);
  }
  {
    // 就绪度与 imageComplete/categoryStatus 组合一致（防前端/服务端漂移）
    const mismatch = (workbench.models || []).find((m) => {
      const expected = m.imageComplete && m.categoryStatus !== 'pending' ? 'ready'
        : !m.imageComplete && m.categoryStatus !== 'pending' ? 'needs-images'
        : m.imageComplete && m.categoryStatus === 'pending' ? 'needs-category'
        : 'needs-both';
      return m.readiness !== expected;
    });
    record('就绪度与 图片完整/分类状态 组合一致', !mismatch, mismatch ? `不一致：${JSON.stringify(mismatch && { model: mismatch.model, readiness: mismatch.readiness, imageComplete: mismatch.imageComplete, categoryStatus: mismatch.categoryStatus })}` : '');
  }
  {
    const lp2136 = (workbench.models || []).find((m) => m.model === 'LP2136');
    const bl012 = (workbench.models || []).find((m) => m.model === 'BL012');
    record('分类/审核原因字段有值', !!lp2136 && lp2136.category === '双肩背包' && typeof lp2136.displayReason === 'string' && lp2136.displayReason.length > 0 && !!bl012 && bl012.category === '双肩背包', `LP2136.category=${lp2136 && lp2136.category}`);
  }

  // ---------- 快速审核动作：复用既有状态接口 ----------
  {
    // public/hidden 无原因必须 400（服务端双重校验）
    const res = await fetch(`${base}/api/admin/products/BL012/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'public' }) });
    record('快速公开无原因返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/BL012/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'pending', displayReason: '测试：待审核' }) });
    const data = await res.json();
    record('快速设待审核成功（复用既有状态接口）', res.status === 200 && data.ok && data.displayStatus === 'pending', `status=${res.status}, displayStatus=${data.displayStatus}`);
  }
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: adminHeaders() });
    const data = await res.json();
    const bl012 = (data.models || []).find((m) => m.model === 'BL012');
    record('工作台反映快速设待审核（覆盖标记为真）', res.status === 200 && !!bl012 && bl012.displayStatus === 'pending' && bl012.statusOverridden === true, JSON.stringify(bl012 && { displayStatus: bl012.displayStatus, statusOverridden: bl012.statusOverridden }));
  }
  {
    // 清除覆盖：回落到数据源默认状态（internal）与原因
    const res = await fetch(`${base}/api/admin/products/BL012/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: null }) });
    const data = await res.json();
    record('快速清除覆盖成功并回落到数据源', res.status === 200 && data.ok && data.displayStatus === 'internal' && data.overrideCleared === true, `status=${res.status}, displayStatus=${data.displayStatus}`);
  }
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: adminHeaders() });
    const data = await res.json();
    const bl012 = (data.models || []).find((m) => m.model === 'BL012');
    record('清除覆盖后工作台覆盖标记为假', res.status === 200 && !!bl012 && bl012.statusOverridden === false, JSON.stringify(bl012 && { displayStatus: bl012.displayStatus, statusOverridden: bl012.statusOverridden }));
  }
  {
    const res = await fetch(`${base}/api/admin/audit`, { headers: adminHeaders() });
    const data = await res.json();
    const statusEntries = (data.audit || []).filter((e) => e.action === 'status' && e.model === 'BL012');
    record('快速审核动作审计留痕', statusEntries.length >= 2, `status 条目=${statusEntries.length}`);
  }

  // ---------- 公开目录随之更新（快速公开 → 公开目录新增；清除 → 回落） ----------
  {
    const res = await fetch(`${base}/api/admin/products/BL012/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'public', displayReason: '测试：快速公开' }) });
    const data = await res.json();
    record('快速公开成功（带原因）', res.status === 200 && data.ok && data.displayStatus === 'public', `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    const inPublic = (data.products || []).some((p) => p.model === 'BL012');
    record('快速公开后 BL012 进入公开目录', res.status === 200 && inPublic, `inPublic=${inPublic}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/BL012/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: null }) });
    record('还原：清除 BL012 覆盖', res.status === 200, `status=${res.status}`);
  }

  // ---------- /admin 路由回归 ----------
  {
    const res = await fetch(`${base}/admin`);
    const text = await res.text();
    record('/admin 返回含分类/就绪度筛选的新管理页', res.status === 200 && text.includes('wb-filter-category') && text.includes('wb-filter-readiness') && text.includes('图片补充'), `status=${res.status}`);
  }
}

// ---------- 清理与收尾 ----------
async function cleanup() {
  server.kill();
  await new Promise((resolve) => {
    server.once('exit', resolve);
    setTimeout(resolve, 3000);
  });

  // 还原 admin-store 与目录快照
  for (const file of snapshotFiles) {
    if (snapshot[file] === null) await rm(file, { force: true });
    else await writeFile(file, snapshot[file]);
  }
}

let failed = false;
try {
  await staticChecks();
  readinessUnitChecks();
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
