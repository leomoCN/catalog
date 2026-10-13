// 产品资料管理集成测试：spawn 一个服务器实例，覆盖产品详情、白名单字段编辑、覆盖清除、
// 审核状态（public/hidden 必须带原因、displayStatus:null 清除覆盖）与审计记录，
// 并确认既有图片替换接口与只读图片巡检不受影响；结束后还原 admin-store 与目录快照，重跑校验，不留测试产物。
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminStoreFile = path.join(root, 'data', 'admin-store.json');
const internalPasswordFile = path.join(root, 'data', '.internal-password');
const catalogFile = path.join(root, 'data', 'catalog.json');
const publicCatalogFile = path.join(root, 'data', 'catalog.public.json');

const port = Number(process.env.TEST_PORT || 5200);
const base = `http://127.0.0.1:${port}`;
const token = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 测试现场快照（结束后完全复原） ----------
const snapshotFiles = [adminStoreFile, `${adminStoreFile}.bak`, internalPasswordFile, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);

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

const jsonHeaders = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const targetModel = 'LP2136';

async function main() {
  await waitForServer();

  // ---------- 认证与内部目录 ----------
  {
    const res = await fetch(`${base}/api/internal/catalog`);
    record('内部目录未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`);
    record('产品详情未认证返回 401', res.status === 401, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const target = (data.products || []).find((p) => p.model === targetModel);
    record('内部目录含目标型号', res.status === 200 && !!target, `status=${res.status}, products=${(data.products || []).length}`);
  }

  // ---------- 产品详情 / 白名单字段编辑 ----------
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    // 实测现场 admin-store 可能已有覆盖（如 LP2136 已设为 public），仅校验返回结构
    record('产品详情返回 product + override', res.status === 200 && data.product && data.product.model === targetModel && (data.override === null || (typeof data.override === 'object' && !Array.isArray(data.override))), JSON.stringify(data.override ?? null));
  }
  {
    const res = await fetch(`${base}/api/admin/products/NOPE999`, { headers: { Authorization: `Bearer ${token}` } });
    record('不存在的型号返回 404', res.status === 404, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ fields: { name: '测试品名覆盖' } }) });
    const data = await res.json();
    record('PUT 白名单字段成功', res.status === 200 && data.ok && data.product.name === '测试品名覆盖', `status=${res.status}, name=${data.product && data.product.name}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    record('覆盖写入后 GET 返回 override', res.status === 200 && data.override && data.override.fields && data.override.fields.name === '测试品名覆盖', JSON.stringify(data.override && data.override.fields));
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const target = (data.products || []).find((p) => p.model === targetModel);
    record('内部目录热更新覆盖后的品名', !!target && target.name === '测试品名覆盖', `name=${target && target.name}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ fields: { wholesalePrice: '10' } }) });
    record('非白名单字段返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ fields: {} }) });
    record('空 fields 返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ fields: { sellingPoints: ['卖点A', '卖点B'] } }) });
    const data = await res.json();
    record('数组字段（卖点）写入成功', res.status === 200 && data.product.sellingPoints.length === 2, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ fields: { name: null, sellingPoints: null } }) });
    const data = await res.json();
    const cleared = data.override && data.override.fields && data.override.fields.name === undefined && data.override.fields.sellingPoints === undefined;
    record('null 清除字段覆盖成功', res.status === 200 && cleared, JSON.stringify(data.override && data.override.fields));
  }
  {
    const res = await fetch(`${base}/api/admin/audit`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const edits = (data.audit || []).filter((e) => e.action === 'edit' && e.model === targetModel);
    record('审计含 edit 记录', res.status === 200 && edits.length >= 3, `edits=${edits.length}`);
  }

  // ---------- 审核状态（服务端加固） ----------
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'public' }) });
    record('public 无原因返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'hidden' }) });
    record('hidden 无原因返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'banana', displayReason: 'x' }) });
    record('非法状态返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayReason: '只有原因没有状态' }) });
    record('缺 displayStatus 返回 400', res.status === 400, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'public', displayReason: '审核通过，对外展示' }) });
    const data = await res.json();
    record('public + 原因成功', res.status === 200 && data.displayStatus === 'public', `status=${res.status}, displayStatus=${data.displayStatus}`);
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const target = (data.products || []).find((p) => p.model === targetModel);
    record('目录状态已更新为 public', !!target && target.displayStatus === 'public', `displayStatus=${target && target.displayStatus}`);
  }
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    record('公开目录包含新公开型号', (data.products || []).some((p) => p.model === targetModel), `public=${(data.products || []).length}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: 'hidden', displayReason: '内部返工' }) });
    const data = await res.json();
    record('hidden + 原因成功', res.status === 200 && data.displayStatus === 'hidden', `status=${res.status}, displayStatus=${data.displayStatus}`);
  }
  {
    const res = await fetch(`${base}/api/catalog`);
    const data = await res.json();
    record('公开目录已移除隐藏型号', !(data.products || []).some((p) => p.model === targetModel), `public=${(data.products || []).length}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}/status`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ displayStatus: null }) });
    const data = await res.json();
    record('displayStatus:null 清除覆盖成功', res.status === 200 && data.overrideCleared === true, `status=${res.status}, cleared=${data.overrideCleared}`);
  }
  {
    const res = await fetch(`${base}/api/internal/catalog`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const target = (data.products || []).find((p) => p.model === targetModel);
    record('清除覆盖后回落到数据源默认状态', !!target && target.displayStatus === 'pending', `displayStatus=${target && target.displayStatus}`);
  }
  {
    const res = await fetch(`${base}/api/admin/products/${targetModel}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const noStatus = !data.override || (data.override.displayStatus === undefined && data.override.displayReason === undefined);
    record('清除覆盖后 override 不再含状态', res.status === 200 && noStatus, JSON.stringify(data.override ?? null));
  }
  {
    const res = await fetch(`${base}/api/admin/audit`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const statuses = (data.audit || []).filter((e) => e.action === 'status' && e.model === targetModel);
    record('审计含 status 记录', res.status === 200 && statuses.length >= 3, `statuses=${statuses.length}`);
  }

  // ---------- 既有图片替换接口与只读图片巡检不受影响 ----------
  {
    const res = await fetch(`${base}/api/internal/image/${encodeURIComponent('LP2136_黑色_正面.jpg')}`, { headers: { Authorization: `Bearer ${token}` } });
    record('内部图片接口仍可用', res.status === 200, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/admin`);
    const text = await res.text();
    record('/admin 含图片巡检标签', res.status === 200 && text.includes('图片巡检'), `status=${res.status}`);
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
