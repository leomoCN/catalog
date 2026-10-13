// 客户展示产品英文翻译（Phase 2）集成测试：
// - 静态校验 public 三件套：产品翻译助手（pTr/pEn/colorEn/viewEn）、管理端翻译编辑表单与接口、
//   翻译覆盖 API 引用、脚本语法有效、既有双语/内部模式标记回归；
// - 模拟前端/管理端调用链：公开目录含已批准英文字段 en、内部目录不含 en（内部固定中文）、
//   翻译覆盖 API 的 404/400 校验（非法字段/HTML/不存在的颜色/空数组）、合法写入热更新公开目录、
//   清除翻译后中文回落、英文关键词搜索命中、审计留痕；
// 结束后还原 translations/admin-store/目录/.internal-password 快照并重跑校验，不留测试产物。
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const translationFile = path.join(dataDir, 'translations.json');
const internalPasswordFile = path.join(dataDir, '.internal-password');
const adminStoreFile = path.join(dataDir, 'admin-store.json');
const catalogFile = path.join(dataDir, 'catalog.json');
const publicCatalogFile = path.join(dataDir, 'catalog.public.json');

const port = Number(process.env.TEST_PORT || 5208);
const base = `http://127.0.0.1:${port}`;
const adminToken = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
// 内部查询密码：随机生成并仅注入本次测试服务器实例（不硬编码任何固定密码）
const testInternalPassword = crypto.randomBytes(12).toString('hex');
const INTERNAL_ONLY_KEYS = ['wholesalePrice', 'retailPrice', 'onlinePrice', 'moq', 'cartonSize', 'cartonQty', 'cartonWeight', 'notes', 'source', 'displayStatus', 'displayReason'];
const PUBLIC_MODELS = ['BL002', 'LP2136', 'LP2135', 'LP2145'];
const FULL_TR_FIELDS = ['name', 'materials', 'dimensions', 'capacity', 'weight', 'category', 'brand'];

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 测试现场快照（结束后完全复原） ----------
const snapshotFiles = [translationFile, `${translationFile}.bak`, internalPasswordFile, adminStoreFile, `${adminStoreFile}.bak`, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);

// ---------- 服务器 ----------
function startServer(p) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(p), HOST: '127.0.0.1', ADMIN_TOKEN: adminToken, INTERNAL_PASSWORD: testInternalPassword },
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

// ---------- 静态前端校验 ----------
async function staticChecks() {
  const [html, js, adminJs, adminHtml, adminCss] = await Promise.all([
    readFile(path.join(publicDir, 'index.html'), 'utf8'),
    readFile(path.join(publicDir, 'app.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin.html'), 'utf8'),
    readFile(path.join(publicDir, 'admin.css'), 'utf8'),
  ]);

  // app.js：产品资料翻译助手与公开目录 en 使用
  record('app.js 定义产品翻译助手 pTr/pEn/colorEn/viewEn', ['pTr(', 'pEn(', 'colorEn(', 'viewEn('].every((s) => js.includes(s)), '');
  record('app.js 读取公开目录已批准英文字段 en 与 viewLabels', js.includes('product.en') && js.includes('viewLabels'), '');
  record('app.js 无英文翻译回落到中文原文', js.includes('hasValue(en)') && js.includes('state.mode !== \'public\'') && js.includes('return zh'), '');
  record('app.js 英文关键词并入搜索串', js.includes('p.en') && js.includes('haystackFor'), '');
  record('app.js 既有翻译/模式/筛选标记回归', ['const I18N', 'state.mode === \'public\'', 'renderFilterPanel', 'applyLanguage'].every((s) => js.includes(s)), '');
  record('app.js 不含明文内部密码', !js.includes(testInternalPassword), '');
  record('app.js 语法有效', (() => { try { new Function(js); return true; } catch { return false; } })(), '');

  // admin.js：翻译覆盖编辑表单与接口
  record('admin.js 弹窗含英文翻译表单与清除按钮', adminJs.includes('dialog-translations-form') && adminJs.includes('dialog-translations-clear'), '');
  record('admin.js 翻译字段/颜色输入标记', adminJs.includes('data-tr-field') && adminJs.includes('data-tr-color-input'), '');
  record('admin.js 翻译覆盖接口引用', adminJs.includes('/api/admin/translations/'), '');
  record('admin.js 保存/清除翻译函数', adminJs.includes('saveProductTranslations') && adminJs.includes('clearProductTranslations'), '');
  record('admin.js 产品详情读取 translation', adminJs.includes('currentEditing.translation'), '');
  record('admin.js 语法有效', (() => { try { new Function(adminJs); return true; } catch { return false; } })(), '');

  // admin.html / admin.css
  record('admin.css 含翻译颜色网格样式', adminCss.includes('.tr-color-grid') && adminCss.includes('.tr-subtitle'), '');
}

// ---------- 模拟前端/管理端调用链 ----------
async function serverFlow(srv) {
  // 公开目录：已批准英文字段 en + 无内部字段
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    const leaked = (data.products || []).filter((product) => INTERNAL_ONLY_KEYS.some((k) => Object.prototype.hasOwnProperty.call(product, k)));
    const withEn = (data.products || []).filter((p) => p.en && typeof p.en === 'object' && Object.keys(p.en).length);
    record('公开目录 4 款全部携带已批准英文字段 en', res.status === 200 && leaked.length === 0 && withEn.length === 4 && (data.products || []).length === 4, `products=${(data.products || []).length}, en=${withEn.length}, leaked=${leaked.length}`);
  }
  // 覆盖统计：4 款公开产品英文展示字段完整
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    const complete = (data.products || []).filter((p) => FULL_TR_FIELDS.every((k) => typeof (p.en || {})[k] === 'string' && p.en[k].trim()));
    record('公开目录英文覆盖完整（品名/分类/品牌/材质/尺寸/容量/重量）', complete.length === 4, `complete=${complete.length}`);
  }
  // 内部目录：登录后 410 款，不含 en（内部/管理界面固定中文）
  {
    const res = await fetch(`${base}/api/internal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: testInternalPassword }) });
    const data = await res.json();
    const token = data.token;
    const res2 = await fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    const data2 = await res2.json();
    const withEn = (data2.products || []).filter((p) => Object.prototype.hasOwnProperty.call(p, 'en'));
    record('内部目录 410 款且不含英文字段 en', res2.status === 200 && (data2.products || []).length === 410 && withEn.length === 0, `products=${(data2.products || []).length}, withEn=${withEn.length}`);
  }
  // 未认证翻译接口 401
  {
    const res = await fetch(`${base}/api/admin/translations`);
    record('翻译接口未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  // 404：不存在的型号
  {
    const res = await fetch(`${base}/api/admin/translations/NOPE999`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ translations: { name: 'X' } }) });
    record('翻译覆盖不存在的型号返回 404', res.status === 404, `status=${res.status}`);
  }
  // 400 校验：空对象 / 非法字段 / HTML / 不存在的颜色 / 空卖点数组
  const invalidCases = [
    ['空 translations', { translations: {} }],
    ['非白名单字段', { translations: { notes: 'X' } }],
    ['HTML 字符', { translations: { name: '<script>' } }],
    ['不存在的颜色', { translations: { colors: { '紫色': 'Purple' } } }],
    ['空卖点', { translations: { sellingPoints: [''] } }],
  ];
  for (const [label, body] of invalidCases) {
    const res = await fetch(`${base}/api/admin/translations/LP2136`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    record(`翻译校验 400：${label}`, res.status === 400, `status=${res.status}`);
  }
  // 合法写入：改品名 + 按型号覆盖颜色 → 公开目录热更新
  {
    const res = await fetch(`${base}/api/admin/translations/LP2136`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ translations: { name: 'Backpack (LUOPU) — Test Override', colors: { '黑色': 'Jet Black' } } }) });
    const data = await res.json();
    record('翻译覆盖合法写入成功', res.status === 200 && data.ok && data.translation.name === 'Backpack (LUOPU) — Test Override', `status=${res.status}`);
    const res2 = await fetch(`${base}/api/catalog`);
    const data2 = await res2.json();
    const lp2136 = (data2.products || []).find((p) => p.model === 'LP2136');
    record('公开目录热更新英文品名与颜色覆盖', !!lp2136 && lp2136.en.name === 'Backpack (LUOPU) — Test Override' && lp2136.en.colors['黑色'] === 'Jet Black', `name=${lp2136 && lp2136.en && lp2136.en.name}`);
  }
  // 审计留痕
  {
    const res = await fetch(`${base}/api/admin/audit`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const data = await res.json();
    const trans = (data.audit || []).filter((e) => e.action === 'translate' && e.model === 'LP2136');
    record('审计含 translate 记录', res.status === 200 && trans.length >= 1, `translate=${trans.length}`);
  }
  // 英文关键词搜索命中（服务端 /api/products 与前端一致）
  {
    const res = await fetch(`${base}/api/products?q=Backpack`);
    const data = await res.json();
    const models = new Set((data.products || []).map((img) => img.product && img.product.model));
    record('英文关键词 Backpack 检索命中公开 LUOPU 背包', res.status === 200 && models.has('LP2136') && models.has('LP2135') && models.has('LP2145'), `models=${[...models].join(',')}`);
  }
  // 清除单字段翻译：name 置 null → 公开目录该字段回落到中文原文
  {
    const res = await fetch(`${base}/api/admin/translations/LP2136`, { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ translations: { name: null } }) });
    const data = await res.json();
    record('置空清除单个字段翻译成功', res.status === 200 && data.ok && !Object.prototype.hasOwnProperty.call(data.translation, 'name'), `name=${data.translation && data.translation.name}`);
  }
  // 清空整个翻译：DELETE → 公开目录 en 回落到词汇表（分类/品牌/颜色仍在，自由文本回落中文）
  {
    const res = await fetch(`${base}/api/admin/translations/LP2136`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    const data = await res.json();
    record('DELETE 清空型号翻译成功', res.status === 200 && data.ok && data.translation === null, `status=${res.status}`);
    const res2 = await fetch(`${base}/api/catalog`);
    const data2 = await res2.json();
    const lp2136 = (data2.products || []).find((p) => p.model === 'LP2136');
    const en = lp2136 ? lp2136.en || {} : {};
    const hasName = typeof en.name === 'string';
    const vocabKept = en.category === 'Backpack' && en.brand === 'LUOPU' && en.colors && en.colors['黑色'] === 'Black';
    record('清除后安全回落到词汇表翻译（自由文本回落中文）', !!lp2136 && !hasName && vocabKept, `hasName=${hasName}, vocab=${vocabKept}`);
  }
}

// ---------- 清理与收尾 ----------
async function cleanup() {
  for (const file of snapshotFiles) {
    if (snapshot[file] === null) await rm(file, { force: true });
    else await writeFile(file, snapshot[file]);
  }
}

let failed = false;
let srv = null;
try {
  await staticChecks();
  srv = startServer(port);
  await waitForServer(srv, port);
  await serverFlow(srv);
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
