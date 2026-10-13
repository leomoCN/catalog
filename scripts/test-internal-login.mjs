// 内部只读登录/会话（Step 1）集成测试：spawn 服务器实例，覆盖默认密码与环境变量密码登录、
// 会话可用与短 TTL 过期、登出、401/429 边界（内部会话不能访问 /api/admin）、公开路由回归，
// 以及 data/.internal-password 只持久化 SHA-256 哈希（不含明文）与日志不泄令牌/密码；
// 结束后还原快照、删除测试文件、重跑校验，不留测试产物。
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const internalPasswordFile = path.join(root, 'data', '.internal-password');
const adminStoreFile = path.join(root, 'data', 'admin-store.json');
const catalogFile = path.join(root, 'data', 'catalog.json');
const publicCatalogFile = path.join(root, 'data', 'catalog.public.json');

const port = Number(process.env.TEST_PORT || 5201);
const base = (p) => `http://127.0.0.1:${p}`;
const adminToken = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
const DEFAULT_PASSWORD = 'huang123456';
const ENV_PASSWORD = 'internal-test-secret-2026';

const hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const results = [];
function record(name, passed, detail) { results.push({ name, passed, detail }); }

// ---------- 测试现场快照（结束后完全复原） ----------
const snapshotFiles = [internalPasswordFile, adminStoreFile, `${adminStoreFile}.bak`, catalogFile, `${catalogFile}.bak`, publicCatalogFile, `${publicCatalogFile}.bak`];
const snapshot = {};
for (const file of snapshotFiles) snapshot[file] = await readFile(file, 'utf8').catch(() => null);

// ---------- 服务器 ----------
function startServer(extraEnv, p) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(p), HOST: '127.0.0.1', ADMIN_TOKEN: adminToken, ...extraEnv },
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

async function login(p, password) {
  return fetch(`${base(p)}/api/internal/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

// ---------- 阶段一：默认密码（无 INTERNAL_PASSWORD），短 TTL 与短锁定期 ----------
async function phaseDefaultPassword() {
  const p = port;
  const srv = startServer({ INTERNAL_SESSION_TTL_MS: '2000', INTERNAL_LOGIN_LOCK_MS: '300' }, p);
  try {
    await waitForServer(srv, p);

    // data/.internal-password 只存默认密码的 SHA-256 哈希，绝不含明文
    {
      const content = (await readFile(internalPasswordFile, 'utf8')).trim();
      record('internal-password 文件只存 SHA-256 哈希（默认密码）', content === hex(DEFAULT_PASSWORD), `content=${content}`);
      record('internal-password 文件不含明文密码', !content.includes(DEFAULT_PASSWORD), `len=${content.length}`);
    }

    // 未认证/无效凭证边界
    {
      const res = await fetch(`${base(p)}/api/internal/catalog`);
      record('内部目录无凭证返回 401', res.status === 401, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/image/${encodeURIComponent('LP2136_黑色_正面.jpg')}`);
      record('内部图片无凭证返回 401', res.status === 401, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/session`);
      const data = await res.json();
      record('session 免鉴权探测 authenticated=false', res.status === 200 && data.authenticated === false, JSON.stringify(data));
    }
    {
      const res = await fetch(`${base(p)}/api/internal/session`, { headers: { Authorization: 'Bearer invalid-token-xyz' } });
      const data = await res.json();
      record('无效令牌 session 探测 authenticated=false', res.status === 200 && data.authenticated === false, JSON.stringify(data));
    }

    // 登录：错误密码 401，正确默认密码 200
    {
      const res = await login(p, 'wrong-password');
      record('错误密码返回 401', res.status === 401, `status=${res.status}`);
    }
    let sessionToken = null;
    {
      const res = await login(p, DEFAULT_PASSWORD);
      const data = await res.json();
      sessionToken = data.token;
      record('默认密码登录成功返回 token+expiresAt', res.status === 200 && !!data.token && typeof data.expiresAt === 'number' && data.expiresAt > Date.now(), JSON.stringify(data));
    }

    // 会话可用：内部目录 / session 探测 / 管理 Bearer 兼容
    {
      const res = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      record('内部会话可访问内部目录', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/image/${encodeURIComponent('LP2136_黑色_正面.jpg')}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      record('内部会话可读取内部图片', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/session`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      const data = await res.json();
      record('session 探测（内部会话）返回 source=internal+expiresAt', res.status === 200 && data.authenticated === true && data.source === 'internal' && typeof data.expiresAt === 'number', JSON.stringify(data));
    }
    {
      const res = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${adminToken}` } });
      record('管理 Bearer 仍可访问内部目录', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/session`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const data = await res.json();
      record('session 探测（管理 Bearer）返回 source=admin', res.status === 200 && data.authenticated === true && data.source === 'admin', JSON.stringify(data));
    }

    // 内部会话不能访问 /api/admin/*
    {
      const res = await fetch(`${base(p)}/api/admin/products/LP2136`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      record('内部会话不能访问管理产品接口（401）', res.status === 401, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/admin/audit`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      record('内部会话不能读取管理审计（401）', res.status === 401, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/admin/auth-check`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      const data = await res.json();
      record('内部会话不是管理令牌（auth-check=false）', res.status === 200 && data.authenticated === false, JSON.stringify(data));
    }
    {
      const res = await fetch(`${base(p)}/api/admin/auth-check`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const data = await res.json();
      record('管理 Bearer 的 auth-check=true', res.status === 200 && data.authenticated === true, JSON.stringify(data));
    }

    // 登出：失效当前内部会话；管理 Bearer 幂等成功；未认证 401
    {
      const res = await fetch(`${base(p)}/api/internal/logout`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
      record('logout 成功返回 200', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      record('logout 后原令牌访问内部目录返回 401', res.status === 401, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/session`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      const data = await res.json();
      record('logout 后 session 探测 authenticated=false', res.status === 200 && data.authenticated === false, JSON.stringify(data));
    }
    {
      const res = await fetch(`${base(p)}/api/internal/logout`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
      record('管理 Bearer logout 幂等成功', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/logout`, { method: 'POST' });
      record('logout 未认证返回 401', res.status === 401, `status=${res.status}`);
    }

    // 短 TTL 过期
    {
      const res = await login(p, DEFAULT_PASSWORD);
      const data = await res.json();
      const ttlToken = data.token;
      record('TTL 测试登录成功', res.status === 200 && !!ttlToken, `status=${res.status}`);
      await new Promise((r) => setTimeout(r, 2500)); // 超过 2000ms TTL
      const res2 = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${ttlToken}` } });
      record('会话过期后访问内部目录返回 401', res2.status === 401, `status=${res2.status}`);
      const res3 = await fetch(`${base(p)}/api/internal/session`, { headers: { Authorization: `Bearer ${ttlToken}` } });
      const data3 = await res3.json();
      record('过期令牌 session 探测 authenticated=false', res3.status === 200 && data3.authenticated === false, JSON.stringify(data3));
    }

    // 暴力破解限流：连续 5 次失败后临时 429，锁定期过后恢复
    {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await login(p, 'wrong-password-again');
        statuses.push(res.status);
      }
      record('连续 5 次错误密码均为 401', statuses.every((s) => s === 401), `statuses=${statuses.join(',')}`);
    }
    {
      const res = await login(p, 'wrong-password-again');
      record('第 6 次错误密码返回 429 锁定', res.status === 429, `status=${res.status}`);
    }
    {
      const res = await login(p, DEFAULT_PASSWORD);
      record('锁定期内正确密码也返回 429', res.status === 429, `status=${res.status}`);
    }
    {
      await new Promise((r) => setTimeout(r, 400)); // 超过 300ms 锁定期
      const res = await login(p, DEFAULT_PASSWORD);
      const data = await res.json();
      record('锁定期过后可正常登录（临时锁定）', res.status === 200 && !!data.token, `status=${res.status}`);
    }

    // 请求体/方法边界
    {
      const res = await fetch(`${base(p)}/api/internal/login`);
      record('login 非 POST 返回 405', res.status === 405, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/session`, { method: 'POST' });
      record('session 非 GET 返回 405', res.status === 405, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/logout`, { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } });
      record('logout 非 POST 返回 405', res.status === 405, `status=${res.status}`);
    }
    {
      const res = await login(p, '');
      record('空密码返回 400', res.status === 400, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json' });
      record('非法 JSON 返回 400', res.status === 400, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/internal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 12345 }) });
      record('非字符串密码返回 400', res.status === 400, `status=${res.status}`);
    }

    // 公开路由回归：无需凭证
    {
      const res = await fetch(`${base(p)}/api/catalog`);
      record('公开目录无需凭证可访问', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/products`);
      record('公开产品接口无需凭证可访问', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/health`);
      record('健康检查无需凭证可访问', res.status === 200, `status=${res.status}`);
    }
    {
      const res = await fetch(`${base(p)}/api/image/${encodeURIComponent('LP2136_黑色_正面.jpg')}`);
      record('公开图片接口无需凭证可访问', res.status === 200, `status=${res.status}`);
    }

    // 服务器日志不含令牌与密码
    {
      const log = srv.log();
      record('服务器日志不含令牌/密码', !log.includes(sessionToken) && !log.includes(DEFAULT_PASSWORD), '');
    }
  } finally {
    await stopServer(srv);
  }
}

// ---------- 阶段二：INTERNAL_PASSWORD 环境变量密码 ----------
async function phaseEnvPassword() {
  const p = port + 1;
  const srv = startServer({ INTERNAL_PASSWORD: ENV_PASSWORD }, p);
  try {
    await waitForServer(srv, p);

    {
      const content = (await readFile(internalPasswordFile, 'utf8')).trim();
      record('internal-password 更新为环境变量密码哈希', content === hex(ENV_PASSWORD), `content=${content}`);
      record('internal-password 仍不含任何明文密码', !content.includes(DEFAULT_PASSWORD) && !content.includes(ENV_PASSWORD), `len=${content.length}`);
    }
    {
      const res = await login(p, DEFAULT_PASSWORD);
      record('环境变量模式下默认密码返回 401', res.status === 401, `status=${res.status}`);
    }
    {
      const res = await login(p, ENV_PASSWORD);
      const data = await res.json();
      record('环境变量密码登录成功', res.status === 200 && !!data.token, `status=${res.status}`);
      if (res.status === 200 && data.token) {
        const res2 = await fetch(`${base(p)}/api/internal/catalog`, { headers: { Authorization: `Bearer ${data.token}` } });
        record('环境变量密码会话可访问内部目录', res2.status === 200, `status=${res2.status}`);
      }
    }
  } finally {
    await stopServer(srv);
  }
}

// ---------- 清理与收尾 ----------
async function cleanup() {
  // 还原 admin-store、目录与 .internal-password 快照
  for (const file of snapshotFiles) {
    if (snapshot[file] === null) await rm(file, { force: true });
    else await writeFile(file, snapshot[file]);
  }
  // 删除测试期间可能残留的 .internal-password 临时文件
  try {
    const entries = await readdir(path.join(root, 'data'));
    for (const name of entries) {
      if (name.startsWith('.internal-password')) {
        const f = path.join(root, 'data', name);
        if (!snapshotFiles.includes(f)) await rm(f, { force: true });
      }
    }
  } catch { /* data 目录不存在 */ }
}

let failed = false;
try {
  await phaseDefaultPassword();
  await phaseEnvPassword();
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
