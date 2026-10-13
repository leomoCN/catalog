// 图片标准化集成测试：
// - 静态校验后台扩展：standardize 标签、面板控件（含网格显示开关）、脚本/样式引用、package 脚本、README 文档；
// - 行为校验：clamp / baseScale / computeCrop / downloadName / alignOffset / drawStdGrid 纯函数（与渲染/导出同源，避免逻辑漂移），
//   并校验导出画布不绘制网格（exportStdItem 不含 drawStdGrid 调用，导出与预览取景一致且不含网格）；
// - 回归：既有 admin 标签与上传/编辑标记仍在、admin-standardize.js 不含 fetch/API/上传调用、语法有效；
// - 服务器路由：/admin 返回含标准化的新管理页，/static/admin-standardize.js|css 200 且内容正确；
// 结束后仅杀服务器，不写任何数据文件，不留测试产物。
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const port = Number(process.env.TEST_PORT || 5212);
const base = `http://127.0.0.1:${port}`;
const token = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// 从 admin-standardize.js 提取纯函数（IIFE 内缩进 2 空格，闭合花括号前允许空白）
function extractFn(js, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s*\\}`);
  const m = js.match(re);
  if (!m) return null;
  try { return eval(`(${m[0]})`); } catch { return null; }
}

// ---------- 静态前端校验 ----------
async function staticChecks() {
  const [html, adminJs, stdJs, stdCss, pkg, readme] = await Promise.all([
    readFile(path.join(publicDir, 'admin.html'), 'utf8'),
    readFile(path.join(publicDir, 'admin.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin-standardize.js'), 'utf8'),
    readFile(path.join(publicDir, 'admin-standardize.css'), 'utf8'),
    readFile(path.join(root, 'package.json'), 'utf8'),
    readFile(path.join(root, 'README.md'), 'utf8'),
  ]);

  record('admin.html 含图片标准化标签与面板', html.includes('data-tab="standardize"') && html.includes('图片标准化') && html.includes('id="tab-standardize"'), '');
  record('admin.html 标准化面板含选择/网格/质量/导出控件', html.includes('id="std-file-input"') && html.includes('multiple') && html.includes('id="std-dropzone"') && html.includes('id="std-grid"') && html.includes('id="std-quality"') && html.includes('id="std-export"') && html.includes('id="std-clear"') && html.includes('id="std-grid-toggle"'), '');
  record('admin.html 引用 standardize 脚本与样式', html.includes('/static/admin-standardize.js') && html.includes('/static/admin-standardize.css'), '');
  record('admin.html 既有标签/上传/脚本回归', html.includes('data-tab="products"') && html.includes('data-tab="workbench"') && html.includes('data-tab="images"') && html.includes('data-tab="audit"') && html.includes('id="file-input"') && html.includes('/static/admin.js'), '');

  record('admin-standardize.js 含纯函数（clamp/baseScale/computeCrop/downloadName/alignOffset/drawStdGrid）', stdJs.includes('function clamp') && stdJs.includes('function baseScale') && stdJs.includes('function computeCrop') && stdJs.includes('function downloadName') && stdJs.includes('function alignOffset') && stdJs.includes('function drawStdGrid'), '');
  record('admin-standardize.js 含对齐网格/居中/重置逻辑', stdJs.includes('stdGridVisible') && stdJs.includes('data-std-align') && stdJs.includes('网格'), '');
  record('admin-standardize.js 含 Canvas 渲染与导出实现', stdJs.includes('canvas') && stdJs.includes('getContext') && stdJs.includes('drawImage') && stdJs.includes('toBlob') && stdJs.includes('exportSelected'), '');
  record('admin-standardize.js 不含 fetch / API / 上传调用', !stdJs.includes('fetch(') && !stdJs.includes('/api/') && !stdJs.includes('XMLHttpRequest') && !stdJs.includes('upload'), '');
  record('admin-standardize.js 语法有效', (() => { try { new Function(stdJs); return true; } catch { return false; } })(), '');

  record('admin-standardize.css 含卡片/预览/模式/缩放/对齐/拖拽样式', stdCss.includes('.std-grid') && stdCss.includes('.std-card') && stdCss.includes('.std-preview') && stdCss.includes('.std-mode-btn') && stdCss.includes('.std-scale-row') && stdCss.includes('.std-align-btn') && stdCss.includes('.std-dropzone') && stdCss.includes('.std-drag-hint'), '');

  record('admin.html 标准化面板含上一张/下一张/进度/当前位置控件', html.includes('id="std-prev"') && html.includes('id="std-next"') && html.includes('id="std-position"') && html.includes('id="std-progress-bar"') && html.includes('id="std-progress-text'), '');
  record('admin-standardize.js 含微调/文件名/前后切换/已处理逻辑', stdJs.includes('data-std-nudge') && stdJs.includes('data-std-name') && stdJs.includes('sanitizeFilename') && stdJs.includes('moveOffset') && stdJs.includes('std-prev') && stdJs.includes('std-next') && stdJs.includes('std-done'), '');
  record('admin-standardize.css 含微调/文件名/进度/当前位置样式', stdCss.includes('.std-nudge-btn') && stdCss.includes('.std-name-input') && stdCss.includes('.std-progress-bar') && stdCss.includes('.std-position') && stdCss.includes('.is-current'), '');

  record('package.json 含 test-standardize 脚本', JSON.parse(pkg).scripts && JSON.parse(pkg).scripts['test-standardize'] === 'node scripts/test-standardize.mjs', '');

  record('README 含图片标准化文档与测试说明', readme.includes('图片标准化') && readme.includes('test-standardize') && readme.includes('1200×1500') && readme.includes('对齐网格') && readme.includes('居中'), '');

  record('admin.js 既有实现回归（语法有效 + 上传/工作台标记）', (() => { try { new Function(adminJs); return true; } catch { return false; } })() && adminJs.includes('precheckFile') && adminJs.includes('startBatch'), '');

  // ---------- 行为校验：纯函数 ----------
  const clamp = extractFn(stdJs, 'clamp');
  const baseScale = extractFn(stdJs, 'baseScale');
  const computeCrop = extractFn(stdJs, 'computeCrop');
  const downloadName = extractFn(stdJs, 'downloadName');

  record('clamp 行为正确（上下限 + 上下界反转）', !!clamp && clamp(5, 0, 10) === 5 && clamp(-3, 0, 10) === 0 && clamp(12, 0, 10) === 10 && clamp(7, 10, 5) === 10, '');
  record('baseScale cover/fit 正确', !!baseScale
    && Math.abs(baseScale(3000, 2000, 1200, 1500, 'cover') - 0.75) < 1e-9
    && Math.abs(baseScale(3000, 2000, 1200, 1500, 'fit') - 0.4) < 1e-9
    && Math.abs(baseScale(1000, 2000, 1200, 1500, 'cover') - 1.2) < 1e-9
    && Math.abs(baseScale(1000, 2000, 1200, 1500, 'fit') - 0.75) < 1e-9
    && baseScale(0, 0, 1200, 1500, 'cover') === 1, '');

  // cover（填充裁切）：源裁切区域铺满目标，偏移被钳制
  const c1 = computeCrop(3000, 2000, 1200, 1500, 'cover', 1, 200, -50);
  record('computeCrop cover 裁切区域覆盖目标且偏移钳制', !!c1 && c1.srcW === 1600 && c1.srcH === 2000 && c1.srcX === 200 && c1.srcY === 0 && c1.destX === 0 && c1.destY === 0 && c1.destW === 1200 && c1.destH === 1500, JSON.stringify(c1));
  const c2 = computeCrop(3000, 2000, 1200, 1500, 'cover', 2, 5000, -10);
  record('computeCrop cover 放大 2x 且偏移钳到上限', !!c2 && c2.srcW === 800 && c2.srcH === 1000 && c2.srcX === 2200 && c2.srcY === 0, JSON.stringify(c2));

  // fit（完整适配）：整张源等比放进目标，四周留白、矩形居中
  const c3 = computeCrop(3000, 2000, 1200, 1500, 'fit', 1, 0, 0);
  record('computeCrop fit 横图完整适配并垂直居中', !!c3 && c3.srcX === 0 && c3.srcY === 0 && c3.srcW === 3000 && c3.srcH === 2000 && Math.abs(c3.destW - 1200) < 1e-9 && Math.abs(c3.destH - 800) < 1e-9 && c3.destX === 0 && Math.abs(c3.destY - 350) < 1e-9, JSON.stringify(c3));
  const c4 = computeCrop(1000, 2000, 1200, 1500, 'fit', 1, 0, 0);
  record('computeCrop fit 竖图水平居中', !!c4 && Math.abs(c4.destW - 750) < 1e-9 && Math.abs(c4.destH - 1500) < 1e-9 && Math.abs(c4.destX - 225) < 1e-9 && c4.destY === 0, JSON.stringify(c4));

  record('downloadName 追加 1200x1500 后缀', !!downloadName && downloadName('LP2136_黑色_正面.jpg') === 'LP2136_黑色_正面_1200x1500.jpg' && downloadName('img.PNG') === 'img_1200x1500.jpg' && downloadName('noext') === 'noext_1200x1500.jpg', '');

  // ---------- 行为校验：对齐网格 / 居中 ----------
  const alignOffset = extractFn(stdJs, 'alignOffset');
  const drawStdGrid = extractFn(stdJs, 'drawStdGrid');

  record('alignOffset 居中偏移正确（窗口大于源图时为 0）', !!alignOffset
    && alignOffset(3000, 1600) === 700
    && alignOffset(3000, 3200) === 0
    && alignOffset(1200, 800) === 200
    && alignOffset(0, 100) === 0, '');

  // drawStdGrid 用最小假 ctx 完整跑一遍，不应抛错（三分网格 + 中心十字可绘制）
  const fakeCtx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeStyle: '', lineWidth: 1 };
  let gridThrew = false;
  try { if (drawStdGrid) drawStdGrid(fakeCtx, 240, 300); } catch { gridThrew = true; }
  record('drawStdGrid 可绘制（三分网格 + 中心十字不抛错）', !!drawStdGrid && !gridThrew, '');

  // 导出画布只画图片、不画网格：exportStdItem 与 exportSelected 之间不得出现 drawStdGrid 调用
  const exportFn = stdJs.slice(stdJs.indexOf('function exportStdItem'), stdJs.indexOf('function exportSelected'));
  record('导出不绘制网格（exportStdItem 不含 drawStdGrid 调用）', exportFn.length > 0 && !exportFn.includes('drawStdGrid'), '');

  // ---------- 行为校验：拖动方向 / 箭头微调 / 导出文件名 ----------
  const moveOffset = extractFn(stdJs, 'moveOffset');
  record('moveOffset 图随指针（拖右减偏移、拖左加偏移，钳制边界）', !!moveOffset
    && moveOffset(200, 50, 1400) === 150
    && moveOffset(200, -50, 1400) === 250
    && moveOffset(20, 200, 1400) === 0
    && moveOffset(1500, -500, 1400) === 1400, '');

  const nudgeOffset = extractFn(stdJs, 'nudgeOffset');
  record('nudgeOffset 箭头微调（同向增量 + 边界钳制）', !!nudgeOffset
    && nudgeOffset(100, 20, 1400) === 120
    && nudgeOffset(100, -20, 1400) === 80
    && nudgeOffset(1390, 30, 1400) === 1400
    && nudgeOffset(10, -30, 1400) === 0, '');

  const sanitizeFilename = extractFn(stdJs, 'sanitizeFilename');
  record('sanitizeFilename 清理非法字符并保证 .jpg 扩展名', !!sanitizeFilename
    && sanitizeFilename('LP2136_黑色_正面.jpg') === 'LP2136_黑色_正面.jpg'
    && sanitizeFilename('img.PNG') === 'img.jpg'
    && sanitizeFilename('a/b\\c:d*e?f.jpg') === 'a_b_c_d_e_f.jpg'
    && sanitizeFilename('') === 'image.jpg'
    && sanitizeFilename('   ') === 'image.jpg', '');

  // 导出与预览取景一致性：exportStdItem 复用与预览同源的 computeCrop（同一 item.mode/scale/offset），
  // 且导出文件名走 stdExportName（可编辑文件名 → sanitizeFilename）
  record('导出复用同一取景计算且文件名可编辑（stdExportName/sanitizeFilename）', stdJs.includes('function stdExportName') && stdJs.slice(stdJs.indexOf('function stdExportName'), stdJs.indexOf('function exportStdItem')).includes('sanitizeFilename'), '');
}

// ---------- 服务器路由 ----------
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

async function main() {
  await waitForServer();
  {
    const res = await fetch(`${base}/admin`);
    const text = await res.text();
    record('/admin 返回含图片标准化标签的新管理页', res.status === 200 && text.includes('data-tab="standardize"') && text.includes('id="tab-standardize"') && text.includes('/static/admin-standardize.js') && text.includes('/static/admin-standardize.css'), `status=${res.status}`);
    record('/admin 既有标签/脚本回归', text.includes('data-tab="products"') && text.includes('data-tab="workbench"') && text.includes('data-tab="images"') && text.includes('data-tab="audit"') && text.includes('/static/admin.js'), '');
  }
  {
    const res = await fetch(`${base}/static/admin-standardize.js`);
    const text = await res.text();
    record('/static/admin-standardize.js 可访问且含实现', res.status === 200 && text.includes('function computeCrop') && text.includes('toBlob'), `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/static/admin-standardize.css`);
    const text = await res.text();
    record('/static/admin-standardize.css 可访问且含样式', res.status === 200 && text.includes('.std-grid'), `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/`);
    const text = await res.text();
    record('客户首页回归（不引用 admin 资源）', res.status === 200 && !text.includes('admin-standardize'), `status=${res.status}`);
  }
}

async function cleanup() {
  server.kill();
  await new Promise((resolve) => {
    server.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
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

for (const r of results) console.log(`${r.passed ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const allPassed = results.every((r) => r.passed);
console.log(`\n${allPassed ? '全部通过' : '存在失败'}：${results.filter((r) => r.passed).length}/${results.length}`);
if (failed || !allPassed) process.exit(1);
