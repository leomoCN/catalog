import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from './scripts/build-catalog.mjs';
import { writeJsonAtomic } from './scripts/atomic-write.mjs';
import { jpegSize, isJpegMagic } from './scripts/jpeg-size.mjs';
import { assessReadiness, buildReadinessCounts, buildCategoryCounts } from './scripts/review-readiness.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const imageDir = path.join(root, 'data', 'images');
const imageBackupDir = path.join(root, 'data', 'images-backup');
const catalogFile = path.join(root, 'data', 'catalog.json');
const publicCatalogFile = path.join(root, 'data', 'catalog.public.json');
const adminStoreFile = path.join(root, 'data', 'admin-store.json');
const adminTokenFile = path.join(root, 'data', '.admin-token');

// 图片上传：替换式，仅允许替换既有槽位；最大 20MB，必须是 1200×1500 的 JPEG
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const REQUIRED_IMAGE = { width: 1200, height: 1500 };

// catalog：对外公开目录（/api/catalog、/api/products、/api/image 均基于它）
// internalCatalog：内部完整目录（/api/internal/catalog，需令牌），构建后两者一起重载
let catalog = JSON.parse(await readFile(publicCatalogFile, 'utf8'));
let internalCatalog = JSON.parse(await readFile(catalogFile, 'utf8'));
let imageByFile = new Map(catalog.images.map((image) => [image.file, image]));
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';

const DISPLAY_STATUSES = new Set(['public', 'internal', 'pending', 'hidden']);
// 产品图片固定四视角（与服务端 build-catalog viewOrder 保持一致）
const VIEW_ORDER = ['正面', '45度', '侧面', '背面'];

// 管理端可新增颜色的名称校验：仅中英文/数字，长度 ≤24，不含空格、下划线或路径分隔符等特殊字符
//（保证生成的文件名安全、且能从文件名稳定映射回颜色）
function isValidColorName(color) {
  return typeof color === 'string' && /^[一-龥A-Za-z0-9]{1,24}$/.test(color.trim());
}

// 为新增槽位生成安全的图片文件名（型号可能包含括号/加号/中文等复杂字符，一律清洗后用于文件名）
function safeImageFileName(model, color, view) {
  const modelToken = String(model).replace(/[\\/:*?"<>|\x00-\x1f_]/g, ' ').replace(/\s+/g, '-').trim().replace(/^\.+|\.+$/g, '') || 'model';
  const colorToken = String(color).replace(/[\\/:*?"<>|\x00-\x1f_]/g, ' ').replace(/\s+/g, '-').trim().replace(/^\.+|\.+$/g, '') || 'color';
  return `${modelToken}_${colorToken}_${view}.jpg`;
}
// 管理端可编辑的白名单字段（仅产品展示字段，不含价格/物流/审核字段与派生的 variants/colors）
const EDITABLE_FIELDS = new Set(['name', 'category', 'brand', 'materials', 'dimensions', 'capacity', 'weight', 'sellingPoints', 'launchDate']);
const FIELD_KIND = {
  name: 'string', category: 'string', brand: 'string', materials: 'string',
  dimensions: 'string', capacity: 'string', weight: 'string',
  sellingPoints: 'stringArray', launchDate: 'string',
};

const headers = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

// ---------- 管理令牌：ADMIN_TOKEN 环境变量，否则使用 data/.admin-token；两者都没有则首次启动时生成 ----------
let adminToken = process.env.ADMIN_TOKEN ? String(process.env.ADMIN_TOKEN).trim() : '';
if (!adminToken) {
  try { adminToken = (await readFile(adminTokenFile, 'utf8')).trim(); } catch { /* 尚无令牌文件 */ }
}
if (!adminToken) {
  adminToken = crypto.randomBytes(24).toString('hex');
  await writeFile(adminTokenFile, `${adminToken}\n`);
}

// 零依赖的计时安全比较：固定比较 32 字节 SHA-256 摘要，避免长度与内容侧信道
function tokenEquals(provided) {
  if (!provided || !adminToken) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(adminToken).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return !!match && tokenEquals(match[1].trim());
}

// ---------- 内部只读会话（Step 1）：生产环境必须通过 INTERNAL_PASSWORD 配置 ----------
// 只把 SHA-256 哈希持久化到 data/.internal-password（按需写入，文件绝不含明文）；
// 会话令牌仅存内存；密码与令牌不写入日志、不入审计。
const INTERNAL_PASSWORD = String(process.env.INTERNAL_PASSWORD || '').trim();
if (!INTERNAL_PASSWORD) throw new Error('请设置 INTERNAL_PASSWORD 环境变量后再启动服务');
const INTERNAL_PASSWORD_HASH = sha256(INTERNAL_PASSWORD);
const internalPasswordFile = path.join(root, 'data', '.internal-password');
try {
  const existing = (await readFile(internalPasswordFile, 'utf8')).trim();
  if (existing !== INTERNAL_PASSWORD_HASH) {
    const tmp = `${internalPasswordFile}.tmp-${process.pid}`;
    await writeFile(tmp, `${INTERNAL_PASSWORD_HASH}\n`);
    await rename(tmp, internalPasswordFile);
  }
} catch {
  const tmp = `${internalPasswordFile}.tmp-${process.pid}`;
  await writeFile(tmp, `${INTERNAL_PASSWORD_HASH}\n`);
  await rename(tmp, internalPasswordFile);
}

const internalSessions = new Map(); // token -> { expiresAt }
const INTERNAL_SESSION_TTL_MS = Math.max(1, Number(process.env.INTERNAL_SESSION_TTL_MS) || 8 * 60 * 60 * 1000);
const INTERNAL_LOGIN_FAIL_LIMIT = Math.max(1, Number(process.env.INTERNAL_LOGIN_FAIL_LIMIT) || 5);
const INTERNAL_LOGIN_LOCK_MS = Math.max(1, Number(process.env.INTERNAL_LOGIN_LOCK_MS) || 60 * 1000);
let internalLoginFailures = 0;
let internalLoginLockUntil = 0;

// 内部接口鉴权：管理 Bearer 或有效内部会话；内部会话不得访问 /api/admin/*
function internalAuth(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { ok: false };
  const token = match[1].trim();
  if (tokenEquals(token)) return { ok: true, source: 'admin', token };
  const session = internalSessions.get(token);
  if (session) {
    if (session.expiresAt > Date.now()) return { ok: true, source: 'internal', token, expiresAt: session.expiresAt };
    internalSessions.delete(token);
  }
  return { ok: false, token };
}

// ---------- 管理存储（admin-store.json）：产品字段覆盖 + displayStatus/displayReason + 审计 ----------
const EMPTY_ADMIN_STORE = () => ({ schemaVersion: 1, updatedAt: null, products: {}, audit: [] });
let adminStore = await loadAdminStore();

async function loadAdminStore() {
  try {
    return JSON.parse(await readFile(adminStoreFile, 'utf8'));
  } catch {
    return EMPTY_ADMIN_STORE();
  }
}

// ---------- 客户展示翻译模型（data/translations.json）：hand-curated 词汇表 + 产品级英文翻译 ----------
// 仅影响公开目录的 en 块（已批准英文字段）；内部目录/管理/内部界面固定中文。
// 管理端翻译覆盖接口（/api/admin/translations/*）经严格校验后原子落盘。
const translationFile = path.join(root, 'data', 'translations.json');
let translationsData = await loadTranslations();

async function loadTranslations() {
  try {
    const data = JSON.parse(await readFile(translationFile, 'utf8'));
    if (!data.products || typeof data.products !== 'object') data.products = {};
    return data;
  } catch {
    return { schemaVersion: 1, updatedAt: null, vocab: {}, products: {} };
  }
}

async function saveTranslations() {
  translationsData.updatedAt = new Date().toISOString();
  await writeJsonAtomic(translationFile, translationsData);
}

// 可翻译字段：固定枚举字段由词汇表覆盖，产品自由文本（品名/材质/尺寸/容量/重量/卖点/颜色）由管理端维护
const TR_STRING_KEYS = ['name', 'category', 'brand', 'materials', 'dimensions', 'capacity', 'weight'];
const TR_ALLOWED_KEYS = new Set([...TR_STRING_KEYS, 'sellingPoints', 'colors']);
const MAX_TR_STRING = 2000;
const MAX_TR_POINT = 500;
const MAX_TR_POINTS = 20;
const MAX_TR_COLOR = 200;
const MAX_TR_COLOR_ENTRIES = 200;

function badTranslationString(value) {
  if (typeof value !== 'string') return '必须是非空字符串';
  const s = value.trim();
  if (!s) return '必须是非空字符串';
  if (s.length > MAX_TR_STRING) return `长度不能超过 ${MAX_TR_STRING} 字符`;
  if (/[<>]/.test(s)) return '不允许包含 HTML 标签字符（< 或 >）';
  if (/[\x00-\x1F\x7F]/.test(s)) return '不允许包含控制字符';
  return null;
}

// 校验一次翻译覆盖请求体（translations 对象）；返回错误文案或 null
function validTranslationsPayload(model, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return 'translations 必须是 JSON 对象';
  const keys = Object.keys(incoming);
  if (!keys.length) return 'translations 不能为空';
  for (const key of keys) {
    if (!TR_ALLOWED_KEYS.has(key)) return `字段不可翻译：${key}`;
    const value = incoming[key];
    if (value === null || value === '') continue; // 空值表示清除该字段翻译
    if (TR_STRING_KEYS.includes(key)) {
      const err = badTranslationString(value);
      if (err) return `${key}：${err}`;
    } else if (key === 'sellingPoints') {
      if (!Array.isArray(value)) return 'sellingPoints 必须是非空字符串数组';
      if (value.length > MAX_TR_POINTS) return `sellingPoints 最多 ${MAX_TR_POINTS} 条`;
      for (const point of value) {
        if (typeof point !== 'string' || !point.trim()) return 'sellingPoints 每条必须是非空字符串';
        if (point.trim().length > MAX_TR_POINT) return `sellingPoints 每条不能超过 ${MAX_TR_POINT} 字符`;
        if (/[<>]/.test(point)) return 'sellingPoints 不允许包含 HTML 标签字符（< 或 >）';
      }
    } else if (key === 'colors') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'colors 必须是对象';
      const colorNames = Object.keys(value);
      if (colorNames.length > MAX_TR_COLOR_ENTRIES) return `colors 最多 ${MAX_TR_COLOR_ENTRIES} 项`;
      const product = internalCatalog.products.find((item) => item.model === model);
      const colors = product ? product.colors : [];
      for (const [color, val] of Object.entries(value)) {
        if (val === null || val === '') continue; // 空值表示清除该颜色翻译
        if (!colors.includes(color)) return `颜色「${color}」不在 ${model} 的颜色列表中`;
        const err = badTranslationString(val);
        if (err) return `colors.${color}：${err}`;
        if (val.trim().length > MAX_TR_COLOR) return `colors.${color} 长度不能超过 ${MAX_TR_COLOR} 字符`;
      }
    }
  }
  return null;
}

function audit(action, model, note, before, after) {
  adminStore.audit.push({
    ts: new Date().toISOString(),
    action,
    model: model || null,
    note: note || null,
    before: before ?? null,
    after: after ?? null,
  });
  if (adminStore.audit.length > 500) adminStore.audit = adminStore.audit.slice(-500);
}

async function saveAdminStore() {
  adminStore.updatedAt = new Date().toISOString();
  await writeJsonAtomic(adminStoreFile, adminStore);
}

// ---------- 原子重建 + 重载 ----------
async function rebuildAndReload() {
  const summary = await buildCatalog();
  const [internalText, publicText] = await Promise.all([
    readFile(catalogFile, 'utf8'),
    readFile(publicCatalogFile, 'utf8'),
  ]);
  internalCatalog = JSON.parse(internalText);
  catalog = JSON.parse(publicText);
  imageByFile = new Map(catalog.images.map((image) => [image.file, image]));
  return summary;
}

function summaryOf(summary) {
  return {
    generatedAt: summary.generatedAt,
    images: summary.images.length,
    products: summary.products.length,
    public: summary.publicProducts.length,
    byStatus: summary.byStatus,
  };
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// 原始二进制请求体（图片上传），读取到 limitBytes 为止，超出即中止
async function readRawBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Windows 下目标文件可能被短暂占用（如静态图片流、杀毒扫描）导致 rename 触发 EPERM/EBUSY；
// 有限次短退避重试，避免图片写流程偶发 500。重试用尽仍失败时原样抛出。
async function renameWithRetry(from, to, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EBUSY') && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        continue;
      }
      throw error;
    }
  }
}

// 查找可替换的既有图片槽位（仅内部目录中的既有 model/color/view 组合；新槽位一律拒绝）
function findImageSlot(model, color, view) {
  return internalCatalog.images.find((image) => image.model === model && image.color === color && image.view === view) || null;
}

function sendJson(res, status, data) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendUnauthorized(res) {
  res.writeHead(401, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: '未授权：需要有效的管理令牌' }));
}

function sendUnauthorizedInternal(res) {
  res.writeHead(401, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: '未授权：需要有效的内部会话或管理令牌' }));
}

function methodNotAllowed(res) {
  res.writeHead(405, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: '方法不允许' }));
}

function validFieldValue(key, value) {
  const kind = FIELD_KIND[key];
  if (kind === 'string') return typeof value === 'string' && value.trim().length > 0;
  if (kind === 'stringArray') return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim().length > 0);
  return false;
}

function filteredProducts(url) {
  const query = url.searchParams;
  const q = (query.get('q') || '').trim().toLowerCase();
  const model = query.get('model');
  const color = query.get('color');
  const view = query.get('view');
  const matches = (product, variant, image) => {
    if (model && product.model !== model) return false;
    if (color && variant.color !== color && variant.colorKey !== color) return false;
    if (view && image.view !== view && image.viewKey !== view) return false;
    if (!q) return true;
    const haystack = [product.model, product.name, product.category, product.brand, variant.color, product.materials, product.dimensions, product.capacity, ...(product.sellingPoints || [])].join(' ').toLowerCase();
    // 已批准英文字段（公开目录 en）并入搜索串，支持客户英文检索
    if (product.en) {
      const en = product.en;
      const enParts = [en.name, en.category, en.brand, en.materials, en.dimensions, en.capacity, en.weight];
      if (Array.isArray(en.sellingPoints)) enParts.push(...en.sellingPoints);
      if (en.colors) enParts.push(...Object.values(en.colors));
      return haystack.includes(q) || enParts.filter(Boolean).join(' ').toLowerCase().includes(q);
    }
    return haystack.includes(q);
  };
  return catalog.images.filter((image) => {
    const product = catalog.products.find((item) => item.model === image.model);
    const variant = product.variants.find((item) => item.color === image.color);
    return matches(product, variant, image);
  }).map((image) => ({ ...image, product: catalog.products.find((item) => item.model === image.model) }));
}

function safeImageName(encoded) {
  try {
    const file = decodeURIComponent(encoded);
    if (file.includes('\\') || file.includes('/') || file.includes('..') || file !== path.basename(file)) return null;
    return imageByFile.has(file) ? file : null;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    // ---- 鉴权边界 ----
    // /api/admin/*：仅接受管理 Bearer（/api/admin/auth-check 除外，用于探测是否已登录）
    // /api/internal/*：接受管理 Bearer 或有效内部只读会话（/api/internal/login、/api/internal/session 除外）
    const isAdminRoute = pathname.startsWith('/api/admin/');
    const isInternalRoute = pathname.startsWith('/api/internal/');
    if (isAdminRoute && pathname !== '/api/admin/auth-check' && !isAuthorized(req)) {
      return sendUnauthorized(res);
    }
    if (isInternalRoute && pathname !== '/api/internal/login' && pathname !== '/api/internal/session' && !internalAuth(req).ok) {
      return sendUnauthorizedInternal(res);
    }

    if (pathname === '/api/admin/auth-check') {
      return sendJson(res, 200, { authenticated: isAuthorized(req) });
    }

    // ---- 内部只读登录/会话（Step 1） ----
    if (pathname === '/api/internal/login') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.password !== 'string' || !body.password.trim()) {
        return sendJson(res, 400, { error: '请求体必须是含非空 password 的 JSON 对象' });
      }
      if (Date.now() < internalLoginLockUntil) {
        return sendJson(res, 429, { error: '登录尝试过多，请稍后再试' });
      }
      const ok = crypto.timingSafeEqual(
        crypto.createHash('sha256').update(body.password).digest(),
        Buffer.from(INTERNAL_PASSWORD_HASH, 'hex')
      );
      if (!ok) {
        internalLoginFailures += 1;
        if (internalLoginFailures >= INTERNAL_LOGIN_FAIL_LIMIT) {
          internalLoginFailures = 0;
          internalLoginLockUntil = Date.now() + INTERNAL_LOGIN_LOCK_MS;
        }
        return sendJson(res, 401, { error: '密码错误' });
      }
      internalLoginFailures = 0;
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + INTERNAL_SESSION_TTL_MS;
      internalSessions.set(token, { expiresAt });
      return sendJson(res, 200, { ok: true, token, expiresAt });
    }

    if (pathname === '/api/internal/session') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const auth = internalAuth(req);
      if (!auth.ok) return sendJson(res, 200, { authenticated: false });
      if (auth.source === 'admin') return sendJson(res, 200, { authenticated: true, source: 'admin', expiresAt: null });
      return sendJson(res, 200, { authenticated: true, source: 'internal', expiresAt: auth.expiresAt });
    }

    if (pathname === '/api/internal/logout') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const auth = internalAuth(req);
      if (!auth.ok) return sendUnauthorizedInternal(res);
      if (auth.source === 'internal') internalSessions.delete(auth.token);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/internal/catalog') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return sendJson(res, 200, internalCatalog);
    }

    // 管理端内部图片读取（仅限内部目录中既有图片文件，需令牌；管理页缩略图使用）
    if (pathname.startsWith('/api/internal/image/')) {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const file = decodeURIComponent(pathname.slice('/api/internal/image/'.length));
      if (file.includes('\\') || file.includes('/') || file.includes('..') || file !== path.basename(file)) {
        return sendJson(res, 404, { error: '图片不存在' });
      }
      if (!internalCatalog.images.some((image) => image.file === file)) {
        return sendJson(res, 404, { error: '图片不存在' });
      }
      const filePath = path.join(imageDir, file);
      const info = await stat(filePath);
      res.writeHead(200, { ...headers, 'Content-Type': 'image/jpeg', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
      return createReadStream(filePath).pipe(res);
    }

    if (pathname === '/api/admin/rebuild') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const summary = await rebuildAndReload();
      audit('rebuild', null, '管理端触发重建');
      await saveAdminStore();
      return sendJson(res, 200, { ok: true, model: null, summary: summaryOf(summary) });
    }

    const statusMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)\/status$/);
    if (statusMatch) {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const model = safeDecode(statusMatch[1]);
      const product = internalCatalog.products.find((item) => item.model === model);
      if (!product) return sendJson(res, 404, { error: '型号不存在' });
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });

      const entry = adminStore.products[model] || { fields: {} };
      const before = { displayStatus: entry.displayStatus || null, displayReason: entry.displayReason || null };

      // 服务端加固：displayStatus 为 null 表示清除审核状态覆盖（回落到数据源默认状态/原因）
      if (body.displayStatus === null) {
        delete entry.displayStatus;
        delete entry.displayReason;
        adminStore.products[model] = entry;
        audit('status', model, '清除审核状态覆盖', before, { displayStatus: null, displayReason: null });
        await saveAdminStore();
        const summary = await rebuildAndReload();
        const updated = internalCatalog.products.find((item) => item.model === model);
        return sendJson(res, 200, {
          ok: true, model,
          displayStatus: updated.displayStatus,
          displayReason: updated.displayReason,
          overrideCleared: true,
          summary: summaryOf(summary),
        });
      }

      const displayStatus = body.displayStatus;
      if (!DISPLAY_STATUSES.has(displayStatus)) return sendJson(res, 400, { error: `displayStatus 非法，应为 ${[...DISPLAY_STATUSES].join('/')}` });
      if (body.displayReason !== undefined && body.displayReason !== null && typeof body.displayReason !== 'string') {
        return sendJson(res, 400, { error: 'displayReason 必须是非空字符串' });
      }
      const displayReason = typeof body.displayReason === 'string' && body.displayReason.trim() ? body.displayReason.trim() : null;
      // 服务端加固：public / hidden 状态必须携带非空审核原因
      if ((displayStatus === 'public' || displayStatus === 'hidden') && !displayReason) {
        return sendJson(res, 400, { error: `displayStatus=${displayStatus} 必须提供非空的 displayReason` });
      }
      entry.displayStatus = displayStatus;
      if (displayReason) entry.displayReason = displayReason;
      else delete entry.displayReason;
      adminStore.products[model] = entry;
      audit('status', model, `设置 displayStatus=${displayStatus}`, before, { displayStatus, displayReason });
      await saveAdminStore();
      const summary = await rebuildAndReload();
      const updated = internalCatalog.products.find((item) => item.model === model);
      return sendJson(res, 200, {
        ok: true, model,
        displayStatus: updated.displayStatus,
        displayReason: updated.displayReason,
        summary: summaryOf(summary),
      });
    }

    // ---- 颜色管理（新增/移除管理端新增颜色；基础颜色来自数据源，不可移除） ----
    const colorsMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)\/colors$/);
    if (colorsMatch) {
      const model = safeDecode(colorsMatch[1]);
      const product = internalCatalog.products.find((item) => item.model === model);
      if (!product) return sendJson(res, 404, { error: '型号不存在' });

      if (req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const incoming = Array.isArray(body.colors) ? body.colors : (typeof body.color === 'string' ? [body.color] : null);
        if (!Array.isArray(incoming) || !incoming.length) return sendJson(res, 400, { error: '缺少 colors 数组（至少一个颜色）' });

        const entry = adminStore.products[model] || { fields: {} };
        const added = Array.isArray(entry.colors) ? [...entry.colors] : [];
        const baseColors = product.colors.filter((c) => !added.includes(c)); // 数据源/资料基础颜色
        const before = { colors: [...added] };
        const addedList = [];
        for (const raw of incoming) {
          if (typeof raw !== 'string') return sendJson(res, 400, { error: '颜色必须是字符串' });
          const color = raw.trim();
          if (!isValidColorName(color)) {
            return sendJson(res, 400, { error: `颜色名非法：${color}（仅支持中英文/数字，长度≤24，不含空格与特殊字符）` });
          }
          if (baseColors.includes(color) || added.includes(color)) continue; // 基础颜色或已存在，跳过
          added.push(color);
          addedList.push(color);
        }
        if (!addedList.length) {
          return sendJson(res, 400, { error: '没有需要新增的颜色（颜色已存在或与基础颜色重复）' });
        }
        entry.colors = added;
        adminStore.products[model] = entry;
        audit('color-add', model, `新增颜色：${addedList.join('、')}`, before, { colors: added });
        await saveAdminStore();
        const summary = await rebuildAndReload();
        const updated = internalCatalog.products.find((item) => item.model === model);
        return sendJson(res, 200, { ok: true, model, added: addedList, colors: updated.colors, override: adminStore.products[model] || null, summary: summaryOf(summary) });
      }

      if (req.method === 'DELETE') {
        const color = requestUrl.searchParams.get('color') || '';
        if (!color) return sendJson(res, 400, { error: '缺少 color 查询参数' });
        const entry = adminStore.products[model];
        const added = (entry && Array.isArray(entry.colors)) ? [...entry.colors] : [];
        if (!added.includes(color)) return sendJson(res, 400, { error: `颜色「${color}」不是该型号的新增颜色，无法移除` });
        // 该颜色已有图片时禁止移除（先删图再删颜色，避免产生孤立图片）
        if (internalCatalog.images.some((image) => image.model === model && image.color === color)) {
          return sendJson(res, 409, { error: `颜色「${color}」已有图片，请先删除该颜色的图片后再移除颜色` });
        }
        const before = { colors: [...added] };
        const next = added.filter((c) => c !== color);
        if (next.length) entry.colors = next; else delete entry.colors;
        adminStore.products[model] = entry;
        audit('color-remove', model, `移除新增颜色：${color}`, before, { colors: next });
        await saveAdminStore();
        const summary = await rebuildAndReload();
        const updated = internalCatalog.products.find((item) => item.model === model);
        return sendJson(res, 200, { ok: true, model, removed: color, colors: updated.colors, override: adminStore.products[model] || null, summary: summaryOf(summary) });
      }

      return methodNotAllowed(res);
    }

    const productMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
    if (productMatch) {
      const model = safeDecode(productMatch[1]);
      const product = internalCatalog.products.find((item) => item.model === model);
      if (!product) return sendJson(res, 404, { error: '型号不存在' });
      if (req.method === 'GET') {
        return sendJson(res, 200, { model, product, override: adminStore.products[model] || null, translation: translationsData.products[model] || null });
      }
      if (req.method !== 'PUT') return methodNotAllowed(res);
      const body = await readJsonBody(req).catch(() => null);
      const incoming = body && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : null;
      if (!incoming) return sendJson(res, 400, { error: '缺少 fields 对象（仅支持白名单字段）' });
      const keys = Object.keys(incoming);
      if (!keys.length) return sendJson(res, 400, { error: 'fields 不能为空' });
      for (const key of keys) {
        if (!EDITABLE_FIELDS.has(key)) return sendJson(res, 400, { error: `字段不可编辑：${key}` });
        const value = incoming[key];
        if (value === null || value === '') continue; // 空值表示清除该字段覆盖
        if (!validFieldValue(key, value)) return sendJson(res, 400, { error: `字段值非法：${key}` });
      }
      const entry = adminStore.products[model] || { fields: {} };
      if (!entry.fields || typeof entry.fields !== 'object') entry.fields = {};
      const before = { ...entry.fields };
      for (const key of keys) {
        const value = incoming[key];
        if (value === null || value === '') delete entry.fields[key];
        else entry.fields[key] = value;
      }
      adminStore.products[model] = entry;
      audit('edit', model, `编辑字段：${keys.join('、')}`, before, { ...entry.fields });
      await saveAdminStore();
      const summary = await rebuildAndReload();
      const updated = internalCatalog.products.find((item) => item.model === model);
      return sendJson(res, 200, { ok: true, model, product: updated, override: adminStore.products[model] || null, summary: summaryOf(summary) });
    }

    // ---- 图片上传（替换既有槽位 / 新增缺失槽位）与审计查询 ----
    // 新增槽位仅当该颜色已存在（基础颜色或管理端新增颜色）时才允许；型号/视角固定取自目录。
    if (pathname === '/api/admin/images/upload') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const model = requestUrl.searchParams.get('model') || '';
      const color = requestUrl.searchParams.get('color') || '';
      const view = requestUrl.searchParams.get('view') || '';
      if (!model || !color || !view) return sendJson(res, 400, { error: '缺少 model/color/view 查询参数' });
      const product = internalCatalog.products.find((item) => item.model === model);
      if (!product) return sendJson(res, 404, { error: '型号不存在' });
      if (!product.colors.includes(color)) {
        return sendJson(res, 409, { error: `颜色「${color}」不在 ${model} 的颜色列表中，请先在颜色管理中新增该颜色` });
      }
      if (!VIEW_ORDER.includes(view)) return sendJson(res, 400, { error: `view 非法，应为 ${VIEW_ORDER.join('/')}` });
      const slot = findImageSlot(model, color, view);

      let body;
      try {
        body = await readRawBody(req, MAX_UPLOAD_BYTES);
      } catch (error) {
        return sendJson(res, 400, { error: error && error.message === '请求体过大' ? '图片超过 20MB 上限' : '请求体读取失败' });
      }
      if (!body.length) return sendJson(res, 400, { error: '请求体为空' });
      if (!isJpegMagic(body)) return sendJson(res, 400, { error: '不是有效的 JPEG 文件（缺少 JPEG 标识）' });
      const size = jpegSize(body);
      if (!size) return sendJson(res, 400, { error: '无法解析 JPEG 尺寸' });
      if (size.width !== REQUIRED_IMAGE.width || size.height !== REQUIRED_IMAGE.height) {
        return sendJson(res, 400, { error: `图片尺寸应为 ${REQUIRED_IMAGE.width}×${REQUIRED_IMAGE.height}，实际为 ${size.width}×${size.height}` });
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await mkdir(imageBackupDir, { recursive: true });

      if (slot) {
        // ---- 替换既有槽位：沿用既有文件名原地替换，先备份到 data/images-backup/<时间戳>_<文件名> ----
        const file = slot.file;
        const target = path.join(imageDir, file);
        const beforeBytes = (await stat(target).catch(() => null))?.size || 0;
        const beforeHash = sha256(await readFile(target).catch(() => Buffer.alloc(0)));
        const backup = path.join(imageBackupDir, `${stamp}_${file}`);
        await copyFile(target, backup);

        // 原子替换：先写同目录临时文件，再 rename 覆盖（Windows 下对 EPERM/EBUSY 有限重试）
        const tmp = path.join(imageDir, `.${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
        await writeFile(tmp, body);
        let summary;
        try {
          await renameWithRetry(tmp, target);
          summary = await rebuildAndReload();
        } catch (error) {
          // 失败即回滚：恢复备份原图，重建并重载目录，清理临时文件后向上抛出
          await copyFile(backup, target).catch(() => {});
          await rebuildAndReload().catch(() => {});
          await rm(tmp, { force: true }).catch(() => {});
          throw error;
        }

        const after = { file, bytes: body.length, sha256: sha256(body), backup: path.basename(backup) };
        audit('image-upload', model, `替换图片：${color}/${view}`, { file, bytes: beforeBytes, sha256: beforeHash }, after);
        await saveAdminStore();
        return sendJson(res, 200, { ok: true, model, color, view, created: false, ...after, summary: summaryOf(summary) });
      }

      // ---- 新增缺失槽位（颜色必须已存在；写文件 + 管理端注册表，原子落盘后重建，失败回滚） ----
      let file = safeImageFileName(model, color, view);
      const fileExists = (name) => stat(path.join(imageDir, name)).then(() => true).catch(() => false);
      if (await fileExists(file)) file = file.replace(/\.jpe?g$/i, `-${crypto.randomBytes(3).toString('hex')}.jpg`);
      const target = path.join(imageDir, file);
      const tmp = path.join(imageDir, `.${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      try {
        await writeFile(tmp, body);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      const entry = adminStore.products[model] || { fields: {} };
      if (!Array.isArray(entry.images)) entry.images = [];
      entry.images = entry.images.filter((mi) => !(mi.color === color && mi.view === view));
      entry.images.push({ color, view, file });
      adminStore.products[model] = entry;
      await saveAdminStore(); // 注册表先落盘，供重建读取
      let summary;
      try {
        await renameWithRetry(tmp, target);
        summary = await rebuildAndReload();
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        await rm(target, { force: true }).catch(() => {});
        entry.images = entry.images.filter((mi) => mi.file !== file);
        adminStore.products[model] = entry;
        await saveAdminStore();
        throw error;
      }

      const after = { file, bytes: body.length, sha256: sha256(body) };
      audit('image-create', model, `新增图片：${color}/${view}`, null, after);
      await saveAdminStore();
      return sendJson(res, 200, { ok: true, model, color, view, created: true, ...after, summary: summaryOf(summary) });
    }

    // ---- 图片删除：备份原图后删除文件（管理端新增槽位同步移除注册表条目），审计留痕 ----
    if (pathname === '/api/admin/images/remove') {
      if (req.method !== 'DELETE') return methodNotAllowed(res);
      const model = requestUrl.searchParams.get('model') || '';
      const color = requestUrl.searchParams.get('color') || '';
      const view = requestUrl.searchParams.get('view') || '';
      if (!model || !color || !view) return sendJson(res, 400, { error: '缺少 model/color/view 查询参数' });
      const slot = findImageSlot(model, color, view);
      if (!slot) return sendJson(res, 404, { error: `不存在该图片槽位：${model}/${color}/${view}` });
      const file = slot.file;
      const target = path.join(imageDir, file);
      const beforeBytes = (await stat(target).catch(() => null))?.size || 0;
      const beforeHash = sha256(await readFile(target).catch(() => Buffer.alloc(0)));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(imageBackupDir, `${stamp}_${file}`);
      await mkdir(imageBackupDir, { recursive: true });
      await copyFile(target, backup);

      // 若该槽位由管理端新增（注册表条目），先移除注册表并落盘，再删除文件重建
      const entry = adminStore.products[model];
      if (entry && Array.isArray(entry.images)) {
        entry.images = entry.images.filter((mi) => !(mi.color === color && mi.view === view));
        if (!entry.images.length) delete entry.images;
        adminStore.products[model] = entry;
      }
      await saveAdminStore();
      let summary;
      try {
        await rm(target, { force: true });
        summary = await rebuildAndReload();
      } catch (error) {
        // 回滚：恢复备份文件与注册表条目
        await copyFile(backup, target).catch(() => {});
        if (entry) {
          if (!Array.isArray(entry.images)) entry.images = [];
          entry.images.push({ color, view, file });
          adminStore.products[model] = entry;
          await saveAdminStore();
        }
        await rebuildAndReload().catch(() => {});
        throw error;
      }

      const after = { file, bytes: beforeBytes, sha256: beforeHash, backup: path.basename(backup) };
      audit('image-remove', model, `删除图片：${color}/${view}`, { file, bytes: beforeBytes, sha256: beforeHash }, after);
      await saveAdminStore();
      return sendJson(res, 200, { ok: true, model, color, view, ...after, summary: summaryOf(summary) });
    }

    if (pathname === '/api/admin/audit') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const limit = Math.min(Number(requestUrl.searchParams.get('limit')) || 200, 500);
      return sendJson(res, 200, { audit: adminStore.audit.slice(-limit) });
    }

    // ---- 图片补充/审核工作台：只读统计（每产品/每颜色 0/4–4/4 完整度 + 系列/展示状态 +
    //      分类/分类状态/审核原因/是否覆盖/图片完整/审核就绪度；前端基于此渲染筛选与进度） ----
    if (pathname === '/api/admin/workbench') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const viewOrder = internalCatalog.viewOrder || VIEW_ORDER;
      const models = (internalCatalog.products || []).map((product) => {
        const variants = Array.isArray(product.variants) ? product.variants : [];
        const colors = variants.map((variant) => {
          const views = variant.views && typeof variant.views === 'object' ? variant.views : {};
          const present = viewOrder.filter((view) => views[view]);
          return {
            color: variant.color,
            complete: !!variant.complete,
            present: present.length,
            total: viewOrder.length,
            missingViews: Array.isArray(variant.missingViews) ? variant.missingViews : viewOrder.filter((view) => !views[view]),
          };
        });
        const completeColors = colors.filter((c) => c.complete).length;
        const partialColors = colors.filter((c) => c.present > 0 && !c.complete).length;
        const missingColors = colors.filter((c) => c.present === 0).length;
        const entry = adminStore.products[product.model] || null;
        const readinessInfo = assessReadiness(product);
        return {
          model: product.model,
          name: product.name || '',
          source: product.source || '',
          displayStatus: product.displayStatus || '',
          displayReason: product.displayReason || '',
          statusOverridden: !!(entry && (entry.displayStatus !== undefined || entry.displayReason !== undefined)),
          category: product.category || '',
          categoryStatus: product.categoryStatus || '',
          imageComplete: readinessInfo.imageComplete,
          readiness: readinessInfo.readiness,
          colorCount: colors.length,
          completeColors,
          partialColors,
          missingColors,
          images: colors.reduce((n, c) => n + c.present, 0),
          colors,
        };
      });
      const totals = {
        products: models.length,
        imageProducts: models.filter((m) => m.images > 0).length,
        noImageProducts: models.filter((m) => m.images === 0).length,
        colors: models.reduce((n, m) => n + m.colorCount, 0),
        completeColors: models.reduce((n, m) => n + m.completeColors, 0),
        partialColors: models.reduce((n, m) => n + m.partialColors, 0),
        missingColors: models.reduce((n, m) => n + m.missingColors, 0),
        images: (internalCatalog.images || []).length,
        readinessCounts: buildReadinessCounts(models),
        byCategory: buildCategoryCounts(models),
      };
      return sendJson(res, 200, { generatedAt: internalCatalog.generatedAt || null, viewOrder, totals, models });
    }

    // ---- 安全备份读取：仅可读取 data/images-backup 下的既有 JPEG 备份（批量撤销/还原用），路径严格校验 ----
    if (pathname.startsWith('/api/admin/backup/')) {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const name = safeDecode(pathname.slice('/api/admin/backup/'.length));
      if (!name || name.includes('\\') || name.includes('/') || name.includes('..') || name !== path.basename(name) || !/\.jpe?g$/i.test(name)) {
        return sendJson(res, 404, { error: '备份不存在' });
      }
      const filePath = path.join(imageBackupDir, name);
      const info = await stat(filePath).catch(() => null);
      if (!info || !info.isFile()) return sendJson(res, 404, { error: '备份不存在' });
      res.writeHead(200, { ...headers, 'Content-Type': 'image/jpeg', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
      return createReadStream(filePath).pipe(res);
    }

    // ---- 客户展示翻译（管理端翻译覆盖：仅写 translations.json；重建后公开目录携带已批准英文字段 en） ----
    if (pathname === '/api/admin/translations') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return sendJson(res, 200, translationsData);
    }

    const translationsMatch = pathname.match(/^\/api\/admin\/translations\/([^/]+)$/);
    if (translationsMatch) {
      const model = safeDecode(translationsMatch[1]);
      const product = internalCatalog.products.find((item) => item.model === model);
      if (!product) return sendJson(res, 404, { error: '型号不存在' });

      if (req.method === 'DELETE') {
        const before = translationsData.products[model] || null;
        delete translationsData.products[model];
        audit('translate-clear', model, '清除英文翻译', before, null);
        await saveTranslations();
        const summary = await rebuildAndReload();
        return sendJson(res, 200, { ok: true, model, translation: null, summary: summaryOf(summary) });
      }

      if (req.method !== 'PUT') return methodNotAllowed(res);
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
      const incoming = body.translations;
      const validationError = validTranslationsPayload(model, incoming);
      if (validationError) return sendJson(res, 400, { error: validationError });
      const entry = translationsData.products[model] || {};
      const before = { ...entry };
      const isEmptyValue = (value) => value === null || value === ''
        || (Array.isArray(value) && value.length === 0)
        || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
      for (const key of Object.keys(incoming)) {
        const value = incoming[key];
        if (isEmptyValue(value)) delete entry[key]; // 空值/空数组/空对象表示清除该字段翻译
        else entry[key] = value;
      }
      if (!Object.keys(entry).length) delete translationsData.products[model];
      else translationsData.products[model] = entry;
      audit('translate', model, '编辑英文翻译', before, entry);
      await saveTranslations();
      const summary = await rebuildAndReload();
      return sendJson(res, 200, { ok: true, model, translation: translationsData.products[model] || null, summary: summaryOf(summary) });
    }

    // ---- 原有公开 API（行为保持不变） ----
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, images: catalog.images.length, products: catalog.products.length });
    if (pathname === '/api/catalog') return sendJson(res, 200, catalog);
    if (pathname === '/api/products') return sendJson(res, 200, { products: filteredProducts(requestUrl), imageStandard: catalog.imageStandard });
    if (pathname.startsWith('/api/image/')) {
      const file = safeImageName(pathname.slice('/api/image/'.length));
      if (!file) return sendJson(res, 404, { error: '图片不存在' });
      const filePath = path.join(imageDir, file);
      const info = await stat(filePath);
      res.writeHead(200, { ...headers, 'Content-Type': 'image/jpeg', 'Content-Length': info.size, 'Cache-Control': 'private, max-age=86400' });
      return createReadStream(filePath).pipe(res);
    }
    const isAdminPage = pathname === '/admin' || pathname === '/admin.html';
    const relative = isAdminPage ? 'admin.html' : (pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, ''));
    if (!isAdminPage && pathname !== '/' && !pathname.startsWith('/static/')) return sendJson(res, 404, { error: '未找到' });
    const filePath = path.resolve(publicDir, relative);
    if (!filePath.startsWith(publicDir + path.sep)) return sendJson(res, 403, { error: '禁止访问' });
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) return sendJson(res, 404, { error: '未找到' });
    const ext = path.extname(filePath).toLowerCase();
    const contentType = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[ext] || 'application/octet-stream';
    // 管理页与 admin 资源强制 no-store，避免浏览器缓存旧版页面/脚本
    const isAdminAsset = isAdminPage || pathname === '/static/admin.js' || pathname === '/static/admin.css' || pathname === '/static/admin-standardize.js' || pathname === '/static/admin-standardize.css';
    res.writeHead(200, { ...headers, 'Content-Type': contentType, 'Cache-Control': isAdminAsset ? 'no-store' : 'no-cache' });
    return createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(port, host, () => console.log(`产品图片库已启动：http://${host}:${port}`));
