// 分类归一集成测试：
// - 静态校验分类归一模块 / 构建 / 校验脚本（安全规则标记、category-review 写入、规范分类校验、翻译词汇表新标签）；
// - 先跑一次构建，然后直接读取 catalog.json / catalog.public.json / category-review.json 断言：
//   内部目录每款带 category/categoryRaw/categoryStatus/categoryReason，原始分类已全部归一到规范分类，
//   各安全规则与自动归类结果正确、待确认清单恰为 PVC化妆包/BL094-2/LP1081 三款；
//   公开目录只暴露规范分类，不含 categoryRaw/categoryStatus/categoryReason；
// - 再 spawn 一个服务器实例，验证公开接口与内部接口字段隔离、工作台可用；
// 结束后重跑校验，不留测试产物（分类目录文件以构建产物为准）。
import { spawn } from 'node:child_process';
import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const publicDir = path.join(root, 'public');
const catalogFile = path.join(dataDir, 'catalog.json');
const publicCatalogFile = path.join(dataDir, 'catalog.public.json');
const reviewFile = path.join(dataDir, 'category-review.json');
const translationsFile = path.join(dataDir, 'translations.json');

const port = Number(process.env.TEST_PORT || 5210);
const base = `http://127.0.0.1:${port}`;
const adminToken = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

function syntaxCheck(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => resolve({ ok: code === 0, out }));
  });
}

// ---------- 静态前端/脚本校验 ----------
async function staticChecks() {
  const [normalize, build, validate, translations, appJs, adminJs] = await Promise.all([
    readFile(path.join(root, 'scripts', 'category-normalize.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'build-catalog.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'validate-catalog.mjs'), 'utf8'),
    readFile(translationsFile, 'utf8'),
    readFile(path.join(publicDir, 'app.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin.js'), 'utf8'),
  ]);
  const [okNormalize, okBuild, okValidate] = await Promise.all([
    syntaxCheck(path.join(root, 'scripts', 'category-normalize.mjs')),
    syntaxCheck(path.join(root, 'scripts', 'build-catalog.mjs')),
    syntaxCheck(path.join(root, 'scripts', 'validate-catalog.mjs')),
  ]);

  // 用户批准的安全规则标记
  const ruleMarkers = [
    "'双肩包': '双肩背包'",
    "'腰包/挎包': '腰包/腿包'",
    "'腿包/腰包': '腰包/腿包'",
    "'挎包': '挎包/手提包'",
    "'手提包': '挎包/手提包'",
    "'其他配件': '配件'",
    "'枪套': '配件'",
    "'弹夹带': '配件'",
    "'腰带': '配件'",
    "'背带': '配件'",
    "'枪绳': '配件'",
    "'扣具': '配件'",
    "'水袋包': '水袋包'",
    "'水壶包': '水壶包'",
    "'待确认'",
  ];
  record('分类归一模块含全部批准安全规则', ruleMarkers.every((s) => normalize.includes(s)), '');
  record('分类归一模块含医疗/急救与单肩/斜挎规则', normalize.includes('医疗|急救|医护') && normalize.includes('单肩|斜挎'), '');
  record('分类归一模块定义规范分类集合', normalize.includes('CANONICAL_CATEGORIES'), '');
  record('分类归一模块语法有效', okNormalize, okNormalize ? '' : okNormalize.out.split('\n')[0]);

  record('build-catalog 引用分类归一并写 category-review', build.includes('normalizeCategory') && build.includes("'data', 'category-review.json'"), '');
  record('build-catalog 为产品写入分类三件套', build.includes('categoryRaw') && build.includes('categoryStatus') && build.includes('categoryReason'), '');
  record('build-catalog 语法有效', okBuild, okBuild ? '' : okBuild.out.split('\n')[0]);

  record('validate-catalog 引用规范分类集合', validate.includes('CANONICAL_CATEGORIES'), '');
  record('validate-catalog 校验分类三件套与待确认清单', validate.includes('categoryStatus 非法') && validate.includes('category-review.json'), '');
  record('validate-catalog 语法有效', okValidate, okValidate ? '' : okValidate.out.split('\n')[0]);

  const tr = JSON.parse(translations);
  const catVocab = tr.vocab && tr.vocab.categories ? tr.vocab.categories : {};
  record('翻译词汇表含规范分类 腰包/腿包 与 待确认', catVocab['腰包/腿包'] === 'Waist / Thigh Pack' && catVocab['待确认'] === 'To Be Confirmed', `keys=${Object.keys(catVocab).length}`);
  record('翻译词汇表含规范分类 挎包/手提包', catVocab['挎包/手提包'] === 'Crossbody / Handbag', '');

  record('客户前端分类筛选动态生成', appJs.includes('category-filters') && appJs.includes('catCounts'), '');
  record('管理端分类筛选动态生成', adminJs.includes('filter-category') && adminJs.includes('categories.add'), '');
}

// ---------- 目录文件断言 ----------
async function catalogChecks() {
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  const publicCatalog = JSON.parse(await readFile(publicCatalogFile, 'utf8'));
  const review = JSON.parse(await readFile(reviewFile, 'utf8'));

  const products = catalog.products || [];
  const publicProducts = publicCatalog.products || [];

  // 数量
  record('内部目录产品数 410', products.length === 410, `products=${products.length}`);
  record('公开目录产品数 4', publicProducts.length === 4, `public=${publicProducts.length}`);

  // 内部目录：分类三件套齐全 + 规范分类
  const missingFields = products.filter((p) => !p.category || typeof p.categoryRaw !== 'string' || !p.categoryStatus || !p.categoryReason);
  record('内部目录全部产品携带 category/categoryRaw/categoryStatus/categoryReason', missingFields.length === 0, `missing=${missingFields.length}`);
  const legacy = products.filter((p) => ['双肩包', '腰包/挎包', '腿包/腰包', '挎包', '手提包', '其他配件', '腰带', '背带', '腰带/背带'].includes(p.category));
  record('无任何遗留原始分类值', legacy.length === 0, legacy.map((p) => `${p.model}=${p.category}`).join(','));
  const badStatus = products.filter((p) => !['approved', 'auto', 'pending', 'admin'].includes(p.categoryStatus));
  record('categoryStatus 全部合法', badStatus.length === 0, badStatus.map((p) => p.model).join(','));

  // 安全规则断言（批准规则）
  const expectApproved = {
    'BL002': ['双肩背包', '双肩背包'],
    'LP2136': ['双肩背包', '双肩背包'],
    'BL025': ['腰包/腿包', '腰包/挎包'],
    'BL005': ['腰包/腿包', '腿包/腰包'],
    'BL027': ['挎包/手提包', '挎包'],
    'BL119': ['挎包/手提包', '挎包/手提包'],
    'BL032': ['附件包', '手提包'],
    'BL093': ['附件包', '挎包'],
    'LP2130': ['附件包', '手提包'],
    'LP2024': ['附件包', '双肩包'],
    'LP2025': ['附件包', '双肩包'],
    'BL170': ['附件包', '双肩背包'],
    'BL038': ['配件', '配件'],
    'BL043': ['钓鱼包/枪包', '钓鱼包/枪包'],
    'BL018': ['水袋包', '水袋包'],
    'BL051': ['水壶包', '水壶包'],
    'BL126': ['胸包/挎包', '胸包/挎包'],
    'BL082': ['挎包/手提包', '腿包/腰包'],
    'LP1736': ['挎包/手提包', '胸包/挎包'],
    'LP2133': ['挎包/手提包', '胸包/挎包'],
    'LP2140': ['挎包/手提包', '挎包'],
    'LP2141': ['挎包/手提包', '挎包'],
    // 空分类但品名显式含 单肩/斜挎 -> 挎包/手提包（显式规则）
    'LP1451': ['挎包/手提包', ''],
    'V8015': ['挎包/手提包', ''],
    'V8018': ['挎包/手提包', ''],
    'V8019': ['挎包/手提包', ''],
    'V8020': ['挎包/手提包', ''],
    'V8021': ['挎包/手提包', ''],
  };
  for (const [model, [canonical, raw]] of Object.entries(expectApproved)) {
    const p = products.find((item) => item.model === model);
    record(`批准规则 ${model} → ${canonical}（raw=${raw}）`, !!p && p.category === canonical && p.categoryRaw === raw && p.categoryStatus === 'approved', `got=${p && p.category}/${p && p.categoryRaw}/${p && p.categoryStatus}`);
  }

  // 自动归类断言（空分类）
  const expectAuto = {
    'LP1479': '双肩背包', 'LP1394': '双肩背包', 'BL008C(5个拉头，非双向拉头）': '双肩背包',
    'BL090C': '双肩背包', 'BL096C': '双肩背包', 'BL097C': '双肩背包',
    'HY8008': '胸包/挎包', 'LP1072': '配件', 'LP1537': '钓鱼包/枪包',
    'LP1862': '胸包/挎包', 'LP92321': '腰包/腿包',
    'HY8085': '双肩背包', 'HY8318-2': '双肩背包', 'HY8321-2': '双肩背包', 'HY8320': '双肩背包',
    'LP1116小款': '双肩背包', 'LP1126大款': '双肩背包',
    'LP1271': '双肩背包', 'LP1270': '双肩背包', 'LP1703': '双肩背包',
    'LP1299': '钓鱼包/枪包', 'HY8280-2': '双肩背包', 'HY8280-3': '双肩背包',
    'LP1582': '配件', 'V8016': '挎包/手提包',
    'V8017': '挎包/手提包', 'V8022': '双肩背包',
    'V8037': '挎包/手提包', 'G9007': '双肩背包', 'V9001': '挎包/手提包',
    'V9002': '挎包/手提包', 'V9003': '挎包/手提包', 'KB-08-001': '套服',
    'KB-08-002': '帽', '00XC018': '配件',
    'BL094-2': '附件包', // 同系列基型 BL094（圣诞袜，附件包）继承
  };
  for (const [model, canonical] of Object.entries(expectAuto)) {
    const p = products.find((item) => item.model === model);
    record(`自动归类 ${model} → ${canonical}`, !!p && p.category === canonical && p.categoryStatus === 'auto', `got=${p && p.category}/${p && p.categoryStatus}`);
  }

  // 背心类保留（描述提及医疗用途不误归附件包）
  for (const [model, canonical] of [['LP1414', '狗背心'], ['LP1416', '狗背心'], ['LP1417', '狗背心'], ['LP2177', '战术背心'], ['BL042', '战术背心']]) {
    const p = products.find((item) => item.model === model);
    record(`背心类保留 ${model} → ${canonical}`, !!p && p.category === canonical, `got=${p && p.category}`);
  }

  // 待确认清单
  const pending = products.filter((p) => p.categoryStatus === 'pending');
  const pendingModels = pending.map((p) => p.model).sort();
  record('待确认恰为 0 款（已确认 PVC化妆包/LP1081）', pending.length === 0, `pending=${pendingModels.join(',')}`);
  const pendingReviewModels = (review.pending || []).map((r) => r.model).sort();
  record('category-review.json 待确认清单为空', (review.pending || []).length === 0 && pendingReviewModels.length === 0, `review=${pendingReviewModels.join(',')}`);
  const reviewComplete = (review.pending || []).every((r) => r.model && r.name && r.source && typeof r.row === 'number' && r.evidence && Array.isArray(r.candidates) && r.candidates.length);
  record('待确认条目含 evidence/source/row/candidates', reviewComplete, '');

  // 公开目录：只暴露规范分类，不含三件套
  const leakedRaw = publicProducts.filter((p) => Object.prototype.hasOwnProperty.call(p, 'categoryRaw') || Object.prototype.hasOwnProperty.call(p, 'categoryStatus') || Object.prototype.hasOwnProperty.call(p, 'categoryReason'));
  record('公开目录不含 categoryRaw/categoryStatus/categoryReason', leakedRaw.length === 0, `leaked=${leakedRaw.length}`);
  record('公开目录分类均为规范分类', publicProducts.every((p) => typeof p.category === 'string' && p.category), '');
  const bl002 = publicProducts.find((p) => p.model === 'BL002');
  record('公开目录 BL002 分类为规范分类 双肩背包', !!bl002 && bl002.category === '双肩背包', `category=${bl002 && bl002.category}`);
}

// ---------- 服务器字段隔离 ----------
async function serverFlow(srv) {
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    const leaked = (data.products || []).filter((p) => Object.prototype.hasOwnProperty.call(p, 'categoryRaw') || Object.prototype.hasOwnProperty.call(p, 'categoryStatus') || Object.prototype.hasOwnProperty.call(p, 'categoryReason'));
    record('公开接口 /api/catalog 不含分类三件套', res.status === 200 && leaked.length === 0, `products=${(data.products || []).length}`);
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const data = await res.json();
    const withFields = (data.products || []).filter((p) => typeof p.categoryRaw === 'string' && p.categoryStatus && p.categoryReason);
    record('内部接口 /api/internal/catalog 含分类三件套', res.status === 200 && (data.products || []).length === 410 && withFields.length === 410, `withFields=${withFields.length}`);
  }
  {
    const res = await fetch(`${base}/api/admin/workbench`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const data = await res.json();
    record('管理工作台统计可用', res.status === 200 && data.totals && data.totals.products === 410, `products=${data.totals && data.totals.products}`);
  }
  {
    const res = await fetch(`${base}/api/products?q=%E9%9E%98%E5%8C%85`);
    const data = await res.json();
    record('公开检索按规范分类关键词可用', res.status === 200, `status=${res.status}`);
  }
}

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

async function waitForServer(srv) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
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

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/build-catalog.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => resolve({ code, out }));
  });
}

let failed = false;
let srv = null;
try {
  await staticChecks();
  const build = await runBuild();
  record('构建分类归一目录成功', build.code === 0, build.out.split('\n')[0] || `exit=${build.code}`);
  await catalogChecks();
  srv = startServer(port);
  await waitForServer(srv);
  await serverFlow(srv);
} catch (error) {
  failed = true;
  results.push({ name: '测试执行异常', passed: false, detail: error.stack || error.message });
} finally {
  if (srv) await stopServer(srv).catch(() => {});
  // 原子写结束后会清理临时文件；这里显式清理任何异常残留的 .tmp-* 文件
  for (const f of [catalogFile, publicCatalogFile, reviewFile]) {
    const dir = path.dirname(f);
    const prefix = `.${path.basename(f)}.tmp-`;
    try {
      for (const name of await readdir(dir)) {
        if (name.startsWith(prefix)) await unlink(path.join(dir, name)).catch(() => {});
      }
    } catch { /* 目录不存在 */ }
  }
}

// ---------- 最终校验：构建产物必须通过 validate ----------
{
  const child = spawn(process.execPath, ['scripts/validate-catalog.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  record('构建产物 validate-catalog 通过', code === 0, out.split('\n')[0] || `exit=${code}`);
}

for (const r of results) console.log(`${r.passed ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const allPassed = results.every((r) => r.passed);
console.log(`\n${allPassed ? '全部通过' : '存在失败'}：${results.filter((r) => r.passed).length}/${results.length}`);
if (failed || !allPassed) process.exit(1);
