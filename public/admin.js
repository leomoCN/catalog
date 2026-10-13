'use strict';

/* ============================================================
   路普产品图片库 · 管理页（产品资料 / 图片巡检 / 审计日志）
   仅使用既有管理 API：auth-check / internal/catalog / products / images/upload / audit / rebuild。
   令牌保存在 sessionStorage，页面与脚本均强制 no-store，避免缓存。
   ============================================================ */

const TOKEN_KEY = 'adminToken';
const IMAGE_REQ = { width: 1200, height: 1500, maxBytes: 20 * 1024 * 1024 };

const STATUS_ORDER = ['public', 'internal', 'pending', 'hidden'];
const STATUS_LABELS = { public: '公开', internal: '内部', pending: '待审核', hidden: '隐藏' };
// 审核就绪度分级（与 scripts/review-readiness.mjs 保持一致：图片完整 + 分类状态）
const READINESS_ORDER = ['ready', 'needs-images', 'needs-category', 'needs-both'];
const READINESS_LABELS = { ready: '就绪', 'needs-images': '待补图', 'needs-category': '待确认分类', 'needs-both': '待补图+分类' };
// 产品图片固定四视角（与服务端 build-catalog viewOrder 保持一致）
const VIEW_ORDER = ['正面', '45度', '侧面', '背面'];

// 产品资料可编辑字段（与服务端白名单 EDITABLE_FIELDS 保持一致）
const FIELD_DEFS = [
  { key: 'name', label: '品名', type: 'text' },
  { key: 'category', label: '分类', type: 'text' },
  { key: 'brand', label: '品牌', type: 'text' },
  { key: 'materials', label: '材质', type: 'text' },
  { key: 'dimensions', label: '尺寸', type: 'text' },
  { key: 'capacity', label: '容量', type: 'text' },
  { key: 'weight', label: '重量', type: 'text' },
  { key: 'sellingPoints', label: '卖点', type: 'textarea' },
  { key: 'launchDate', label: '上市时间', type: 'text' },
];

// 客户展示英文翻译可编辑字段（与服务端 TR_ALLOWED_KEYS 保持一致；仅已批准英文字段，绝不机翻）
const TR_FIELD_DEFS = [
  { key: 'name', label: '品名（EN）', type: 'text' },
  { key: 'category', label: '分类（EN）', type: 'text' },
  { key: 'brand', label: '品牌（EN）', type: 'text' },
  { key: 'materials', label: '材质（EN）', type: 'text' },
  { key: 'dimensions', label: '尺寸（EN）', type: 'text' },
  { key: 'capacity', label: '容量（EN）', type: 'text' },
  { key: 'weight', label: '重量（EN）', type: 'text' },
  { key: 'sellingPoints', label: '卖点（EN，每行一条）', type: 'textarea' },
];

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
function setToken(token) { sessionStorage.setItem(TOKEN_KEY, token); }
function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

let catalog = null;
let pendingSlot = null;
let productsFilter = { q: '', model: '', category: '', brand: '', status: '', sortField: 'model', sortDir: 1 };
let currentEditing = { model: null, product: null, override: null, translation: null };

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  let data = null;
  try { data = await response.json(); } catch { /* 非 JSON 响应 */ }
  if (!response.ok) throw new Error((data && data.error) || `请求失败（HTTP ${response.status}）`);
  return data;
}

/* ---------- 登录 / 鉴权 ---------- */
async function checkAuth() {
  const token = getToken();
  if (!token) return false;
  const { authenticated } = await api('/api/admin/auth-check');
  return authenticated;
}

function showLogin(message) {
  $('login-panel').classList.remove('hidden');
  $('admin-panel').classList.add('hidden');
  if (message) {
    $('login-error').textContent = message;
    $('login-error').classList.remove('hidden');
  }
}

function showAdmin() {
  $('login-panel').classList.add('hidden');
  $('admin-panel').classList.remove('hidden');
  $('login-error').classList.add('hidden');
  $('auth-state').textContent = '已登录';
  $('logout').classList.remove('hidden');
  loadCatalog();
  loadWorkbench();
  loadAudit();
}

/* ---------- 数据加载：内部目录（图片槽位 + 产品资料共用） ---------- */
async function loadCatalog() {
  const status = $('status');
  status.classList.remove('hidden');
  status.textContent = '正在加载目录…';
  $('upload-error').classList.add('hidden');
  try {
    const internal = await api('/api/internal/catalog');
    catalog = internal;
    renderSlots();
    renderProducts();
    status.classList.add('hidden');
  } catch (error) {
    status.textContent = `加载失败：${error.message}`;
  }
}

/* ---------- 标签页切换 ---------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `tab-${name}`));
  if (name === 'products') renderProducts();
  if (name === 'workbench') loadWorkbench();
  if (name === 'audit') loadAudit();
}

/* ---------- 槽位列表（图片巡检 · 只读） ---------- */
function renderSlots() {
  const bust = Date.now(); // 缓存破坏：重建/替换后强制刷新缩略图
  const byModel = new Map();
  for (const image of catalog.images || []) {
    if (!byModel.has(image.model)) byModel.set(image.model, []);
    byModel.get(image.model).push(image);
  }
  const viewOrder = (catalog && catalog.viewOrder) || VIEW_ORDER;
  const html = [...byModel.entries()].map(([model, list]) => {
    const byColor = new Map();
    for (const image of list) {
      if (!byColor.has(image.color)) byColor.set(image.color, []);
      byColor.get(image.color).push(image);
    }
    const colorHTML = [...byColor.entries()].map(([color, views]) => `
      <div class="color-group">
        <h3>${esc(color)} <span class="view-count">${views.length}/${viewOrder.length} 视角</span></h3>
        <div class="view-grid">
          ${views.map((image) => inspectionSlotHTML(image, bust)).join('')}
        </div>
      </div>`).join('');
    return `<section class="model-group"><h2>${esc(model)} <small>${list.length} 张</small></h2>${colorHTML}</section>`;
  }).join('');
  $('slots').innerHTML = html || '<p class="empty-note">暂无已拍摄图片槽位。</p>';
}

function inspectionSlotHTML(image, bust) {
  const thumbUrl = `/api/internal/image/${encodeURIComponent(image.file)}?v=${bust}`;
  return `<div class="slot">
    <div class="slot-thumb"><img src="${esc(thumbUrl)}" alt="" loading="lazy"></div>
    <div class="slot-info">
      <b>${esc(image.view)}</b>
      <small>${esc(image.file)}</small>
    </div>
  </div>`;
}

/* ---------- 客户端预检 + 上传 ---------- */
function precheckFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('未选择文件'));
    if (file.size > IMAGE_REQ.maxBytes) return reject(new Error(`文件超过 20MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`));
    if (!/\.jpe?g$/i.test(file.name) && file.type !== 'image/jpeg') return reject(new Error('仅支持 JPEG 图片'));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取文件'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      const magic = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!magic) return reject(new Error('不是有效的 JPEG 文件（缺少 JPEG 标识）'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        if (img.naturalWidth !== IMAGE_REQ.width || img.naturalHeight !== IMAGE_REQ.height) {
          return reject(new Error(`图片尺寸应为 ${IMAGE_REQ.width}×${IMAGE_REQ.height}，实际为 ${img.naturalWidth}×${img.naturalHeight}`));
        }
        resolve(true);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法解码')); };
      img.src = url;
    };
    reader.readAsArrayBuffer(file.slice(0, 3));
  });
}

async function uploadFile(file) {
  // 替换入口现在位于产品编辑弹窗；若弹窗仍打开且为同一型号，进度/错误显示在弹窗图片区域并刷新弹窗
  const fromDialog = !$('product-dialog').classList.contains('hidden') && currentEditing.model === pendingSlot.model;
  const status = $('status');
  const error = $('upload-error');
  const note = $('dialog-image-note');
  const setProgress = (text) => {
    if (fromDialog) { note.textContent = text; note.classList.remove('is-error'); note.classList.remove('hidden'); }
    else { error.classList.add('hidden'); status.classList.remove('hidden'); status.textContent = text; }
  };
  const setError = (text) => {
    if (fromDialog) { note.textContent = text; note.classList.add('is-error'); note.classList.remove('hidden'); }
    else { status.classList.add('hidden'); error.textContent = text; error.classList.remove('hidden'); }
  };
  setProgress(`正在上传 ${pendingSlot.model}/${pendingSlot.color}/${pendingSlot.view} …`);
  try {
    const query = `model=${encodeURIComponent(pendingSlot.model)}&color=${encodeURIComponent(pendingSlot.color)}&view=${encodeURIComponent(pendingSlot.view)}`;
    const response = await fetch(`/api/admin/images/upload?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/jpeg' },
      body: file,
    });
    let data = null;
    try { data = await response.json(); } catch { /* 忽略 */ }
    if (!response.ok) throw new Error((data && data.error) || `上传失败（HTTP ${response.status}）`);
    setProgress(data.created
      ? `新增成功：${data.model}/${data.color}/${data.view}（文件：${data.file}）`
      : `替换成功：${data.model}/${data.color}/${data.view}（备份：${data.backup}，文件：${data.file}）`);
    if (fromDialog) await openProductDialog(currentEditing.model); // 重新读取产品并刷新弹窗缩略图
    await loadCatalog();
    loadAudit();
  } catch (err) {
    setError(err.message);
  }
}

/* ============================================================
   图片补充工作台（批量补齐四视角：解析文件名 → 预检 → 预览 →
   批量新增颜色/上传 → 进度 → 失败自动回滚 → 成功可手动撤销）
   仅使用既有管理 API：workbench 统计 / backup 备份读取 / colors / images/upload / images/remove。
   ============================================================ */

// 文件名解析：<型号>_<颜色>_<视角>.jpg（视角固定为 正面/45度/侧面/背面；
// 型号与颜色不允许含下划线，故从右向左切分即可安全还原）
function parseFileName(name) {
  if (typeof name !== 'string') return null;
  const match = /^(.*?)_(.+)_(正面|45度|侧面|背面)\.jpe?g$/i.exec(name.trim());
  if (!match) return null;
  const [, model, color, view] = match;
  if (!model || !color) return null;
  return { model: model.trim(), color: color.trim(), view };
}

// 批量预检（零依赖）：直接扫描 JPEG 标记解析 SOF0 尺寸，避免为每张图解码整图
function readJpegDimensions(bytes) {
  const n = bytes.length;
  let i = 2;
  while (i + 4 <= n) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > n) return null;
      return { width: (bytes[i + 7] << 8) | bytes[i + 8], height: (bytes[i + 5] << 8) | bytes[i + 6] };
    }
    if (i + 4 > n) return null;
    const len = ((bytes[i + 2] << 8) | bytes[i + 3]);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function preflightFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('未选择文件'));
    if (file.size > IMAGE_REQ.maxBytes) return reject(new Error(`文件超过 20MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`));
    if (!/\.jpe?g$/i.test(file.name) && file.type !== 'image/jpeg') return reject(new Error('仅支持 JPEG 图片'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取文件'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        return reject(new Error('不是有效的 JPEG 文件（缺少 JPEG 标识）'));
      }
      const dims = readJpegDimensions(bytes);
      if (!dims) return reject(new Error('无法解析 JPEG 尺寸'));
      if (dims.width !== IMAGE_REQ.width || dims.height !== IMAGE_REQ.height) {
        return reject(new Error(`图片尺寸应为 ${IMAGE_REQ.width}×${IMAGE_REQ.height}，实际为 ${dims.width}×${dims.height}`));
      }
      resolve({ ok: true });
    };
    reader.readAsArrayBuffer(file);
  });
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let workbench = null;
let workbenchFilter = { q: '', series: '', status: '', category: '', readiness: 'all', completeness: 'all' };
let batchItems = [];
let batchRunning = false;
let completedBatches = [];
let batchIdCounter = 0;

async function loadWorkbench() {
  const statsBox = $('workbench-stats');
  try {
    workbench = await api('/api/admin/workbench');
    renderWorkbench();
  } catch (error) {
    statsBox.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

function renderWorkbench() {
  if (!workbench) return;
  const totals = workbench.totals || {};
  const stat = (label, value, cls) => `<span class="wb-stat${cls ? ` ${cls}` : ''}"><b>${Number(value) || 0}</b>${esc(label)}</span>`;
  const readiness = totals.readinessCounts || {};
  const readinessChips = READINESS_ORDER.map((key) => `<span class="wb-stat wb-readiness-stat readiness-${key}"><b>${Number(readiness[key]) || 0}</b>${esc(READINESS_LABELS[key] || key)}</span>`).join('');
  const catEntries = Object.entries(totals.byCategory || {});
  const catChips = catEntries.length
    ? `<div class="wb-stats wb-category-stats"><span class="wb-stat-label">分类分布</span>${catEntries
        .sort((a, b) => b[1] - a[1])
        .map(([cat, n]) => `<button type="button" class="wb-stat wb-cat-chip${workbenchFilter.category === cat ? ' is-active' : ''}" data-wb-cat="${esc(cat)}"><b>${Number(n) || 0}</b>${esc(cat)}</button>`).join('')}</div>`
    : '';
  $('workbench-stats').innerHTML = `<div class="wb-stats">
    ${stat('款产品', totals.products)}
    ${stat('有图', totals.imageProducts)}
    ${stat('无图', totals.noImageProducts)}
    ${stat('颜色组合', totals.colors)}
    ${stat('4/4 完整', totals.completeColors)}
    ${stat('部分完整', totals.partialColors)}
    ${stat('缺图', totals.missingColors)}
    ${stat('图片总数', totals.images)}
  </div>
  <div class="wb-stats wb-readiness-stats"><span class="wb-stat-label">审核就绪</span>${readinessChips}</div>
  ${catChips}`;
  populateWorkbenchFilters();
  renderWorkbenchModels();
  renderUndoBar();
}

function populateWorkbenchFilters() {
  const series = new Set();
  const categories = new Set();
  for (const m of workbench.models || []) {
    if (m.source) series.add(m.source);
    if (m.category) categories.add(m.category);
  }
  $('wb-filter-series').innerHTML = `<option value="">全部系列</option>${[...series].sort().map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}`;
  $('wb-filter-status').innerHTML = `<option value="">全部状态</option>${STATUS_ORDER.map((s) => `<option value="${s}">${STATUS_LABELS[s]}（${s}）</option>`).join('')}`;
  $('wb-filter-category').innerHTML = `<option value="">全部分类</option>${[...categories].sort().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}`;
  $('wb-filter-readiness').innerHTML = `<option value="all">全部就绪度</option>${READINESS_ORDER.map((r) => `<option value="${r}">${esc(READINESS_LABELS[r] || r)}（${r}）</option>`).join('')}`;
  $('wb-filter-series').value = workbenchFilter.series;
  $('wb-filter-status').value = workbenchFilter.status;
  $('wb-filter-category').value = workbenchFilter.category;
  $('wb-filter-readiness').value = workbenchFilter.readiness;
  $('wb-filter-completeness').value = workbenchFilter.completeness;
}

function workbenchModelsFiltered() {
  const q = workbenchFilter.q.trim().toLowerCase();
  return (workbench.models || []).filter((m) => {
    if (workbenchFilter.series && m.source !== workbenchFilter.series) return false;
    if (workbenchFilter.status && m.displayStatus !== workbenchFilter.status) return false;
    if (workbenchFilter.category && m.category !== workbenchFilter.category) return false;
    if (workbenchFilter.readiness !== 'all' && m.readiness !== workbenchFilter.readiness) return false;
    if (workbenchFilter.completeness === 'complete' && !(m.images > 0 && m.missingColors === 0)) return false;
    if (workbenchFilter.completeness === 'partial' && !(m.images > 0 && m.missingColors > 0)) return false;
    if (workbenchFilter.completeness === 'missing' && !(m.images === 0)) return false;
    if (q && !`${m.model} ${m.name} ${m.category}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderWorkbenchModels() {
  const filtered = workbenchModelsFiltered();
  $('workbench-count').innerHTML = `共 <b>${workbench.models.length}</b> 款产品，筛选后 <b>${filtered.length}</b> 款`;
  if (!filtered.length) { $('workbench-models').innerHTML = '<p class="empty-note">没有符合筛选条件的产品。</p>'; return; }
  $('workbench-models').innerHTML = filtered.map((m) => {
    const totalSlots = m.colorCount * 4;
    const pct = totalSlots ? Math.round((m.images / totalSlots) * 100) : 0;
    const chips = m.colors.map((c) => {
      const cls = c.complete ? 'is-full' : (c.present > 0 ? 'is-partial' : 'is-missing');
      const title = c.present > 0 && !c.complete ? `缺：${c.missingViews.join('、')}` : (c.complete ? '四视角齐备' : '缺图');
      return `<span class="wb-color-chip ${cls}" title="${esc(title)}">${esc(c.color)} <b>${c.present}/${c.total}</b></span>`;
    }).join('');
    const catBadge = m.category
      ? `<span class="wb-cat" title="分类状态：${esc(m.categoryStatus || '')}">${esc(m.category)}${m.categoryStatus === 'pending' ? '<i class="cat-status pending">待确认</i>' : ''}${m.categoryStatus === 'admin' ? '<i class="cat-status admin">管理覆盖</i>' : ''}</span>`
      : '';
    const overrideBadge = m.statusOverridden ? '<span class="override-badge" title="展示状态已被管理端覆盖">已覆盖</span>' : '';
    const reasonLine = m.displayReason ? `<div class="wb-reason" title="${esc(m.displayReason)}">原因：${esc(m.displayReason)}</div>` : '';
    const quickActions = `
      <div class="wb-quick-actions">
        <button type="button" class="quiet" data-wb-set-status="public">公开</button>
        <button type="button" class="quiet" data-wb-set-status="pending">待审核</button>
        <button type="button" class="quiet" data-wb-set-status="hidden">隐藏</button>
        <button type="button" class="quiet" data-wb-clear-status>清除覆盖</button>
        <button type="button" class="quiet" data-wb-edit>编辑</button>
      </div>`;
    return `<section class="wb-model" data-model="${esc(m.model)}">
      <div class="wb-model-head">
        <b class="mono">${esc(m.model)}</b>
        <span class="wb-name">${esc(m.name)}</span>
        <span class="status-badge status-${esc(m.displayStatus)}">${esc(STATUS_LABELS[m.displayStatus] || m.displayStatus)}</span>
        ${catBadge}
        <span class="wb-readiness readiness-${esc(m.readiness)}" title="审核就绪度：${esc(READINESS_LABELS[m.readiness] || m.readiness)}">${esc(READINESS_LABELS[m.readiness] || m.readiness)}</span>
        ${overrideBadge}
        <span class="wb-source">${esc(m.source)}</span>
      </div>
      <div class="wb-progress" title="${m.completeColors} 色完整 / ${m.partialColors} 色部分 / ${m.missingColors} 色缺图">
        <div class="wb-progress-bar" style="width:${pct}%"></div>
        <span class="wb-progress-label">${m.images}/${totalSlots} 张　·　${m.completeColors} 完整 / ${m.partialColors} 部分 / ${m.missingColors} 缺图</span>
      </div>
      <div class="wb-color-row">${chips}</div>
      ${reasonLine}
      ${quickActions}
    </section>`;
  }).join('');
}

/* ---------- 工作台快速审核动作（复用既有状态接口 POST /api/admin/products/{model}/status） ---------- */
// 设置展示状态：public / hidden 必须携带非空审核原因（复用服务端双重校验）；internal / pending 保留当前原因。
// 成功后重新加载工作台、产品列表与审计日志。
async function setWorkbenchStatus(model, status) {
  const m = workbench.models.find((x) => x.model === model);
  const currentReason = (m && typeof m.displayReason === 'string' && m.displayReason) || '';
  const body = { displayStatus: status };
  if (status === 'public' || status === 'hidden') {
    const reason = window.prompt(`将 ${model} 设为「${STATUS_LABELS[status]}（${status}）」，请填写非空审核原因：`, currentReason);
    if (reason === null) return; // 用户取消
    const trimmed = String(reason).trim();
    if (!trimmed) { showFormNote('batch-note', '公开（public）/ 隐藏（hidden）必须填写非空审核原因。', true); return; }
    body.displayReason = trimmed;
  } else if (currentReason) {
    body.displayReason = currentReason; // 切换为内部/待审核时保留已有原因
  }
  try {
    await api(`/api/admin/products/${encodeURIComponent(model)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    showFormNote('batch-note', `已设置 ${model} 为「${STATUS_LABELS[status]}（${status}）」。`, false);
    await loadWorkbench();
    loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('batch-note', `设置状态失败：${error.message}`, true);
  }
}

// 清除展示状态覆盖（回落到数据源默认状态与原因）
async function clearWorkbenchStatus(model) {
  if (!confirm(`确定清除 ${model} 的展示状态覆盖吗？将回落到数据源默认状态与原因。`)) return;
  try {
    await api(`/api/admin/products/${encodeURIComponent(model)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayStatus: null }),
    });
    showFormNote('batch-note', `已清除 ${model} 的展示状态覆盖。`, false);
    await loadWorkbench();
    loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('batch-note', `清除覆盖失败：${error.message}`, true);
  }
}

/* ---------- 批量队列：添加 / 预检 / 预览 / 上传 / 回滚 / 撤销 ---------- */
function addBatchFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && typeof f.size === 'number');
  if (!files.length) return;
  hideFormNote('batch-note');
  for (const file of files) {
    const parsed = parseFileName(file.name);
    batchItems.push({
      id: ++batchIdCounter,
      file,
      name: file.name,
      objectUrl: URL.createObjectURL(file),
      model: parsed ? parsed.model : '',
      color: parsed ? parsed.color : '',
      view: parsed ? parsed.view : '',
      parsedOk: !!parsed,
      preflight: { ok: false, error: '', done: false },
      status: 'pending',
      note: '',
      uploadResult: null,
      colorAdded: false,
    });
  }
  renderBatchQueue();
  void preflightAllPending();
}

async function preflightAllPending() {
  for (const item of batchItems) {
    if (item.preflight.done || item.status !== 'pending') continue;
    item.preflight = { ok: false, error: '', done: true };
    try {
      await preflightFile(item.file);
      item.preflight = { ok: true, error: '', done: true };
      item.status = 'ready';
    } catch (e) {
      item.preflight = { ok: false, error: e.message, done: true };
      item.status = 'failed';
      item.note = `预检未通过：${e.message}`;
    }
    renderBatchQueue();
  }
}

function batchStatusText(item) {
  if (item.status === 'uploading') return '<span class="wb-badge">上传中…</span>';
  if (item.status === 'undoing') return '<span class="wb-badge">撤销中…</span>';
  if (item.status === 'done') {
    const extra = item.uploadResult
      ? (item.uploadResult.created ? `新增 ${esc(item.uploadResult.file)}` : `替换（备份 ${esc(item.uploadResult.backup || '')}）`)
      : '';
    return `<span class="wb-badge is-ok">成功 · ${extra}</span>`;
  }
  if (item.status === 'failed') return `<span class="wb-badge is-error">失败：${esc(item.note || '未知错误')}</span>`;
  if (item.status === 'rolledback') return '<span class="wb-badge">已回滚</span>';
  if (item.status === 'undone') return '<span class="wb-badge">已撤销</span>';
  return '';
}

function renderBatchQueue() {
  const queue = $('batch-queue');
  if (!batchItems.length) {
    queue.innerHTML = '<p class="empty-note">尚未选择文件。可多选或拖拽图片到上方区域。</p>';
    updateBatchActions();
    return;
  }
  queue.innerHTML = batchItems.map((item) => {
    const preflightHtml = item.preflight.done
      ? (item.preflight.ok ? '<span class="wb-badge is-ok">预检通过</span>' : `<span class="wb-badge is-error">${esc(item.preflight.error)}</span>`)
      : '<span class="wb-badge">预检中…</span>';
    return `<div class="batch-row" data-id="${item.id}">
      <div class="batch-thumb">${item.objectUrl ? `<img src="${item.objectUrl}" alt="">` : '<span>?</span>'}</div>
      <div class="batch-fields">
        <div class="batch-parse">
          <input class="batch-input model" data-field="model" value="${esc(item.model)}" placeholder="型号">
          <span class="batch-sep">/</span>
          <input class="batch-input color" data-field="color" value="${esc(item.color)}" placeholder="颜色">
          <span class="batch-sep">/</span>
          <select class="batch-input view" data-field="view">
            ${VIEW_ORDER.map((v) => `<option value="${esc(v)}"${item.view === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
            ${!VIEW_ORDER.includes(item.view) && item.view ? `<option value="${esc(item.view)}" selected>${esc(item.view)}</option>` : ''}
          </select>
        </div>
        <div class="batch-meta">${esc(item.name)} · ${esc(formatBytes(item.file.size))}</div>
        <div class="batch-status">${preflightHtml} ${batchStatusText(item)}</div>
      </div>
      <div class="batch-actions-col">
        ${item.status === 'done' ? `<button type="button" class="quiet wb-undo-item" data-undo-item="${item.id}">撤销</button>` : ''}
        ${(item.status === 'pending' || item.status === 'ready' || item.status === 'failed') ? `<button type="button" class="quiet danger wb-remove-item" data-remove-item="${item.id}">移除</button>` : ''}
      </div>
    </div>`;
  }).join('');
  updateBatchActions();
}

function renderBatchProgress() {
  const box = $('batch-progress');
  const total = batchItems.length;
  if (!total) { box.innerHTML = ''; return; }
  const done = batchItems.filter((i) => i.status === 'done').length;
  const failed = batchItems.filter((i) => i.status === 'failed').length;
  const rolledback = batchItems.filter((i) => i.status === 'rolledback').length;
  const undone = batchItems.filter((i) => i.status === 'undone').length;
  const pct = Math.round((done / total) * 100);
  box.innerHTML = `<div class="wb-progress-bar-row"><div class="wb-progress" style="flex:1"><div class="wb-progress-bar" style="width:${pct}%"></div></div><span>${done}/${total} 张</span></div>
    <p class="wb-progress-note">成功 ${done} · 失败 ${failed} · 已回滚 ${rolledback} · 已撤销 ${undone}</p>`;
}

function updateBatchActions() {
  $('batch-start').disabled = batchRunning || !batchItems.some((i) => i.status === 'ready');
  $('batch-clear').disabled = batchRunning || !batchItems.length;
  renderUndoBar();
  renderBatchProgress();
}

function renderUndoBar() {
  const hasDone = batchItems.some((i) => i.status === 'done');
  $('workbench-undo-all').disabled = completedBatches.length === 0;
  $('workbench-undo-all').textContent = `撤销整批${completedBatches.length ? `（${completedBatches.length}）` : ''}`;
  return hasDone;
}

function removeBatchItem(id) {
  const idx = batchItems.findIndex((i) => i.id === id);
  if (idx === -1) return;
  if (batchItems[idx].objectUrl) URL.revokeObjectURL(batchItems[idx].objectUrl);
  batchItems.splice(idx, 1);
  renderBatchQueue();
}

function clearBatch() {
  for (const item of batchItems) if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  batchItems = [];
  renderBatchQueue();
}

// 撤销单项：新增槽位 → 删除；替换槽位 → 读取备份原图并重新上传（恢复上传前状态）
async function undoUploadItem(item) {
  if (!item.uploadResult) return;
  if (item.uploadResult.created) {
    const query = `model=${encodeURIComponent(item.model)}&color=${encodeURIComponent(item.color)}&view=${encodeURIComponent(item.view)}`;
    const response = await fetch(`/api/admin/images/remove?${query}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` } });
    let data = null;
    try { data = await response.json(); } catch { /* 忽略 */ }
    if (!response.ok) throw new Error((data && data.error) || `撤销删除失败（HTTP ${response.status}）`);
    return;
  }
  if (item.uploadResult.backup) {
    const backupRes = await fetch(`/api/admin/backup/${encodeURIComponent(item.uploadResult.backup)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!backupRes.ok) throw new Error(`读取备份失败（HTTP ${backupRes.status}）`);
    const body = await backupRes.arrayBuffer();
    const query = `model=${encodeURIComponent(item.model)}&color=${encodeURIComponent(item.color)}&view=${encodeURIComponent(item.view)}`;
    const response = await fetch(`/api/admin/images/upload?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/jpeg' },
      body,
    });
    let data = null;
    try { data = await response.json(); } catch { /* 忽略 */ }
    if (!response.ok) throw new Error((data && data.error) || `撤销替换失败（HTTP ${response.status}）`);
    return;
  }
}

async function removeAddedColorIfEmpty(model, color) {
  const m = workbench.models.find((x) => x.model === model);
  const c = m && m.colors.find((x) => x.color === color);
  if (c && c.present === 0) {
    await api(`/api/admin/products/${encodeURIComponent(model)}/colors?color=${encodeURIComponent(color)}`, { method: 'DELETE' }).catch(() => { /* 忽略：颜色可能仍有其他图片 */ });
  }
}

async function undoItemById(id) {
  const item = batchItems.find((i) => i.id === id);
  if (!item || item.status !== 'done') return;
  item.status = 'undoing';
  renderBatchQueue();
  try {
    await undoUploadItem(item);
    item.status = 'undone';
    await loadWorkbench();
    if (item.colorAdded) await removeAddedColorIfEmpty(item.model, item.color);
    await loadWorkbench();
    showFormNote('batch-note', `已撤销：${item.model}/${item.color}/${item.view}。`, false);
  } catch (e) {
    item.status = 'done';
    showFormNote('batch-note', `撤销失败：${e.message}`, true);
  }
  renderBatchQueue();
  loadAudit();
}

async function undoLastBatch() {
  const batch = completedBatches[completedBatches.length - 1];
  if (!batch) { showFormNote('batch-note', '暂无已完成的可撤销批次。', true); return; }
  if (!confirm(`确定撤销上一批次的 ${batch.items.length} 项上传吗？新增槽位将被删除，替换槽位将恢复备份原图。`)) return;
  const items = [...batch.items].reverse();
  let failed = 0;
  for (const item of items) {
    item.status = 'undoing';
    renderBatchQueue();
    try {
      await undoUploadItem(item);
      item.status = 'undone';
    } catch (e) {
      failed++;
      item.status = 'done';
    }
  }
  await loadWorkbench();
  for (const item of batch.items) {
    if (item.colorAdded) await removeAddedColorIfEmpty(item.model, item.color);
  }
  await loadWorkbench();
  completedBatches.pop();
  showFormNote('batch-note', failed ? `撤销完成（${failed} 项失败，请人工检查）。` : `已撤销上一批次（${batch.items.length} 项）。`, !!failed);
  renderBatchQueue();
  loadAudit();
}

async function startBatch() {
  if (batchRunning) return;
  const readyItems = batchItems.filter((i) => i.status === 'ready');
  if (!readyItems.length) { showFormNote('batch-note', '没有通过预检的文件可上传，请先选择图片文件。', true); return; }
  batchRunning = true;
  hideFormNote('batch-note');
  updateBatchActions();

  const addedColors = new Set(); // key: JSON.stringify([model, color])
  const ensuredColors = new Set();
  const colorKey = (model, color) => JSON.stringify([model, color]);
  const colorReady = (model, color) => {
    const key = colorKey(model, color);
    if (ensuredColors.has(key)) return true;
    const m = workbench.models.find((x) => x.model === model);
    if (m && m.colors.some((c) => c.color === color)) { ensuredColors.add(key); return true; }
    return false;
  };

  let hadUploadFailure = false;
  for (const item of readyItems) {
    item.status = 'uploading';
    renderBatchQueue();
    if (!item.model) { item.status = 'failed'; item.note = '型号为空，请手动填写'; continue; }
    const modelInfo = workbench.models.find((m) => m.model === item.model);
    if (!modelInfo) { item.status = 'failed'; item.note = `型号「${item.model}」不在目录中`; continue; }
    if (!VIEW_ORDER.includes(item.view)) { item.status = 'failed'; item.note = `视角「${item.view}」非法`; continue; }
    // 批量自动新增颜色（使用既有 colors 接口）
    if (!colorReady(item.model, item.color)) {
      try {
        await api(`/api/admin/products/${encodeURIComponent(item.model)}/colors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ colors: [item.color] }),
        });
        item.colorAdded = true;
        addedColors.add(colorKey(item.model, item.color));
        ensuredColors.add(colorKey(item.model, item.color));
      } catch (e) {
        item.status = 'failed';
        item.note = `新增颜色失败：${e.message}`;
        continue;
      }
    }
    try {
      const query = `model=${encodeURIComponent(item.model)}&color=${encodeURIComponent(item.color)}&view=${encodeURIComponent(item.view)}`;
      const response = await fetch(`/api/admin/images/upload?${query}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/jpeg' },
        body: item.file,
      });
      let data = null;
      try { data = await response.json(); } catch { /* 忽略 */ }
      if (!response.ok) throw new Error((data && data.error) || `上传失败（HTTP ${response.status}）`);
      item.uploadResult = { created: !!data.created, file: data.file, backup: data.backup || null };
      item.status = 'done';
    } catch (e) {
      item.status = 'failed';
      item.note = e.message;
      hadUploadFailure = true;
      break; // 上传中途失败即转入自动回滚
    }
    renderBatchQueue();
  }

  const processedDone = readyItems.filter((i) => i.status === 'done').length;
  const processedFailed = readyItems.filter((i) => i.status === 'failed').length;

  if (hadUploadFailure) {
    // ---- 自动回滚：撤销本批次所有已成功的上传，再移除本批次新增且当前已无图的颜色 ----
    const succeeded = readyItems.filter((i) => i.status === 'done');
    for (const item of succeeded) {
      item.status = 'undoing';
      renderBatchQueue();
      try {
        await undoUploadItem(item);
        item.status = 'rolledback';
      } catch (e) {
        item.note = `回滚失败：${e.message}`;
        item.status = 'failed';
      }
    }
    await loadWorkbench();
    for (const key of addedColors) {
      const [model, color] = JSON.parse(key);
      await removeAddedColorIfEmpty(model, color);
    }
    await loadWorkbench();
    showFormNote('batch-note', `批量上传失败（成功 ${processedDone}，失败 ${processedFailed}），已自动回滚已成功的 ${succeeded.length} 项。`, true);
  } else if (processedFailed > 0) {
    // 仅配置/预检类失败的条目单独标记，不触发整批回滚；已成功项仍可手动撤销
    showFormNote('batch-note', `批量上传完成：成功 ${processedDone} 项，${processedFailed} 项失败（请修正后重试）。已成功项可在「撤销整批」或每行「撤销」回滚。`, false);
    if (processedDone > 0) completedBatches.push({ ts: new Date().toISOString(), items: readyItems.filter((i) => i.status === 'done') });
  } else {
    completedBatches.push({ ts: new Date().toISOString(), items: readyItems.filter((i) => i.status === 'done') });
    showFormNote('batch-note', `批量上传完成：成功 ${processedDone} 项。可在「撤销整批」或每行「撤销」手动回滚。`, false);
  }

  batchRunning = false;
  renderBatchQueue();
  loadWorkbench();
  loadAudit();
}

/* ---------- 产品资料列表 ---------- */
function populateFilterOptions() {
  const categories = new Set();
  const brands = new Set();
  for (const p of catalog.products || []) {
    if (p.category) categories.add(p.category);
    if (p.brand) brands.add(p.brand);
  }
  $('filter-category').innerHTML = `<option value="">全部分类</option>${[...categories].sort().map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
  $('filter-brand').innerHTML = `<option value="">全部品牌</option>${[...brands].sort().map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
  $('filter-status').innerHTML = `<option value="">全部状态</option>${STATUS_ORDER.map((s) => `<option value="${s}">${STATUS_LABELS[s]}（${s}）</option>`).join('')}`;
  // 重建选项后恢复当前筛选值
  $('filter-category').value = productsFilter.category;
  $('filter-brand').value = productsFilter.brand;
  $('filter-status').value = productsFilter.status;
}

function applyProductsFilter() {
  const list = catalog.products || [];
  const q = productsFilter.q.trim().toLowerCase();
  const filtered = list.filter((p) => {
    if (productsFilter.model && !p.model.toLowerCase().includes(productsFilter.model.toLowerCase())) return false;
    if (productsFilter.category && p.category !== productsFilter.category) return false;
    if (productsFilter.brand && p.brand !== productsFilter.brand) return false;
    if (productsFilter.status && p.displayStatus !== productsFilter.status) return false;
    if (q && !`${p.model} ${p.name} ${p.category} ${p.brand} ${p.displayStatus}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const { sortField, sortDir } = productsFilter;
  filtered.sort((a, b) => {
    let av = a[sortField] ?? '';
    let bv = b[sortField] ?? '';
    if (sortField === 'displayStatus') {
      av = STATUS_ORDER.indexOf(a.displayStatus);
      bv = STATUS_ORDER.indexOf(b.displayStatus);
    } else if (typeof av === 'string') {
      av = av.toLowerCase();
      bv = bv.toLowerCase();
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return cmp * sortDir;
  });
  return { filtered, total: list.length };
}

function statusCounts() {
  const counts = {};
  for (const p of catalog.products || []) counts[p.displayStatus] = (counts[p.displayStatus] || 0) + 1;
  return counts;
}

function imageCount(product) {
  const variants = product.variants || [];
  return `${variants.filter((v) => v.complete).length}/${variants.length}`;
}

function renderProducts() {
  if (!catalog) return;
  populateFilterOptions();
  const { filtered, total } = applyProductsFilter();
  const counts = statusCounts();
  const statusChips = STATUS_ORDER.map((s) => `<span class="status-chip">${STATUS_LABELS[s]} <b>${counts[s] || 0}</b></span>`).join('');
  $('product-count').innerHTML = `共 <b>${total}</b> 款产品，筛选后 <b>${filtered.length}</b> 款　·　${statusChips}`;
  if (!filtered.length) {
    $('product-list').innerHTML = '<p class="empty-note">没有符合筛选条件的产品。</p>';
    return;
  }
  const rows = filtered.map((p) => `
    <tr>
      <td class="mono">${esc(p.model)}</td>
      <td>${esc(p.name || '—')}</td>
      <td>${esc(p.category || '—')}</td>
      <td>${esc(p.brand || '—')}</td>
      <td><span class="status-badge status-${esc(p.displayStatus)}">${esc(STATUS_LABELS[p.displayStatus] || p.displayStatus)}</span></td>
      <td class="mono">${imageCount(p)}</td>
      <td><button type="button" class="quiet" data-edit="${esc(p.model)}">编辑</button></td>
    </tr>`).join('');
  $('product-list').innerHTML = `<div class="table-wrap"><table class="product-table">
    <thead><tr><th>型号</th><th>品名</th><th>分类</th><th>品牌</th><th>状态</th><th>图片</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function resetProductsFilter() {
  productsFilter = { q: '', model: '', category: '', brand: '', status: '', sortField: 'model', sortDir: 1 };
  $('filter-q').value = '';
  $('filter-model').value = '';
  $('filter-category').value = '';
  $('filter-brand').value = '';
  $('filter-status').value = '';
  $('sort-field').value = 'model';
  $('sort-dir').textContent = '升序 ↑';
  renderProducts();
}

/* ---------- 产品编辑对话框 ---------- */
async function openProductDialog(model) {
  const dialog = $('product-dialog');
  dialog.classList.remove('hidden');
  $('dialog-title').textContent = `产品资料编辑 · ${model}`;
  $('dialog-body').innerHTML = '<p class="empty-note">正在加载…</p>';
  currentEditing = { model, product: null, override: null, translation: null };
  try {
    const data = await api(`/api/admin/products/${encodeURIComponent(model)}`);
    currentEditing.product = data.product;
    currentEditing.override = data.override;
    currentEditing.translation = data.translation;
    renderProductDialog();
  } catch (error) {
    $('dialog-body').innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

function closeProductDialog() {
  $('product-dialog').classList.add('hidden');
  currentEditing = { model: null, product: null, override: null, translation: null };
}

function fieldValue(def) {
  const override = currentEditing.override;
  if (override && Object.prototype.hasOwnProperty.call(override.fields || {}, def.key)) {
    const v = override.fields[def.key];
    return Array.isArray(v) ? v.join('\n') : String(v ?? '');
  }
  const base = currentEditing.product[def.key];
  return Array.isArray(base) ? base.join('\n') : String(base ?? '');
}

function fieldIsOverridden(def) {
  return !!(currentEditing.override && Object.prototype.hasOwnProperty.call(currentEditing.override.fields || {}, def.key));
}

function fieldRowHTML(def) {
  const overridden = fieldIsOverridden(def);
  const value = fieldValue(def);
  const input = def.type === 'textarea'
    ? `<textarea name="${def.key}" rows="3">${esc(value)}</textarea>`
    : `<input name="${def.key}" type="text" value="${esc(value)}">`;
  return `<label class="field">
    <span class="field-label">
      ${esc(def.label)}
      ${overridden ? '<span class="override-badge">已覆盖</span>' : ''}
      ${overridden ? `<button type="button" class="link-clear" data-clear-field="${esc(def.key)}">清除覆盖</button>` : ''}
    </span>
    ${input}
  </label>`;
}

function statusIsOverridden() {
  const o = currentEditing.override;
  return !!(o && (o.displayStatus !== undefined || o.displayReason !== undefined));
}

function renderProductDialog() {
  const product = currentEditing.product;
  const override = currentEditing.override;
  const overriddenStatus = statusIsOverridden();
  const selectedStatus = (override && override.displayStatus !== undefined) ? override.displayStatus : '__clear__';
  const reason = (override && typeof override.displayReason === 'string' && override.displayReason)
    ? override.displayReason
    : (product.displayReason || '');

  const fieldsHTML = FIELD_DEFS.map(fieldRowHTML).join('');

  $('dialog-body').innerHTML = `
    <div class="dialog-summary">
      <b class="mono">${esc(product.model)}</b>
      <span>${esc(product.source || '')}</span>
      <span class="status-badge status-${esc(product.displayStatus)}">${esc(STATUS_LABELS[product.displayStatus] || product.displayStatus)}</span>
    </div>

    <form id="dialog-fields-form" class="dialog-form">
      <h3>产品资料字段<small>仅编辑展示字段；留空并保存表示清除该字段覆盖</small></h3>
      <div class="form-grid">${fieldsHTML}</div>
      <div class="form-actions">
        <button type="submit" class="primary">保存字段</button>
        <button type="button" class="quiet" id="dialog-fields-reset">放弃未保存修改</button>
      </div>
      <p id="dialog-fields-note" class="form-note hidden"></p>
    </form>

    <form id="dialog-status-form" class="dialog-form">
      <h3>展示审核状态${overriddenStatus ? '<span class="override-badge">已覆盖</span>' : ''}</h3>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">状态${overriddenStatus ? `<button type="button" class="link-clear" data-clear-status>清除覆盖</button>` : ''}</span>
          <select name="displayStatus" id="dialog-status-select">
            <option value="__clear__">清除覆盖（回落到数据源默认状态）</option>
            ${STATUS_ORDER.map((s) => `<option value="${s}">${STATUS_LABELS[s]}（${s}）</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span class="field-label">审核原因</span>
          <textarea name="displayReason" rows="3" placeholder="公开（public）/ 隐藏（hidden）必须填写审核原因">${esc(reason)}</textarea>
        </label>
      </div>
      <div class="form-actions">
        <button type="submit" class="primary">保存状态</button>
      </div>
      <p id="dialog-status-note" class="form-note">当前生效：${esc(STATUS_LABELS[product.displayStatus] || product.displayStatus)}（${esc(product.displayStatus)}）${product.displayReason ? `；原因：${esc(product.displayReason)}` : ''}</p>
    </form>

    <form id="dialog-translations-form" class="dialog-form">
      <h3>英文翻译<small>已批准英文字段（hand-curated，绝不机翻）。仅客户展示模式英文/双语显示；留空并保存表示清除该字段翻译，未翻译字段在英文界面安全回落到中文原文。固定枚举（分类/品牌/颜色）也可由全局词汇表自动提供。</small></h3>
      <div class="form-grid">${TR_FIELD_DEFS.map(translationFieldRowHTML).join('')}</div>
      <h4 class="tr-subtitle">颜色翻译<small>颜色为固定枚举，词汇表已提供常见颜色；如需按型号覆盖可在此填写</small></h4>
      <div id="dialog-translations-colors" class="tr-color-grid">${renderDialogTranslationColors()}</div>
      <div class="form-actions">
        <button type="submit" class="primary">保存翻译</button>
        <button type="button" class="quiet danger" id="dialog-translations-clear">清除翻译</button>
      </div>
      <p id="dialog-translations-note" class="form-note hidden"></p>
    </form>

    <form id="dialog-colors-form" class="dialog-form">
      <h3>颜色管理<small>新增颜色为增量覆盖（叠加在基础颜色之上），先加颜色、再为该颜色的缺失视角上传图片</small></h3>
      <div id="dialog-colors-list" class="color-chips">${renderDialogColors()}</div>
      <div class="color-add-row">
        <input id="dialog-color-input" type="text" placeholder="新颜色名，如 红色（支持 、 分隔多个）" maxlength="72" autocomplete="off">
        <button type="submit" class="primary">添加颜色</button>
      </div>
      <p id="dialog-colors-note" class="form-note hidden"></p>
    </form>

    <section class="dialog-images">
      <h3>产品图片<small>按颜色分组，四视角；缺失视角可「上传」新增，已有视角可「替换」或「删除」（删除会备份原图）；图片必须 1200×1500 JPEG、≤20MB</small></h3>
      <div id="dialog-image-slots" class="dialog-image-slots">${renderDialogImages()}</div>
      <p id="dialog-image-note" class="form-note hidden"></p>
    </section>`;

  $('dialog-status-select').value = selectedStatus;
}

/* ---------- 产品编辑弹窗：按颜色分组的四视角图片槽位（缺失→上传，既有→替换/删除） ---------- */
function renderDialogImages() {
  const product = currentEditing.product;
  const variants = product.variants || [];
  const viewOrder = (catalog && catalog.viewOrder) || VIEW_ORDER;
  if (!variants.length) return '<p class="empty-note">该产品暂无可管理的颜色变体。</p>';
  const bust = Date.now(); // 缓存破坏：替换/新增/删除后强制刷新缩略图
  return variants.map((variant) => {
    const views = variant.views || {};
    const present = viewOrder.filter((view) => views[view]);
    const slots = viewOrder.map((view) => {
      const image = views[view];
      if (!image) {
        // 缺失视角：显示「上传」按钮，可新增该槽位（颜色必须已存在）
        return `<div class="dialog-slot is-missing">
          <div class="slot-thumb slot-thumb-missing"><span>缺图</span></div>
          <div class="slot-info"><b>${esc(view)}</b><small>暂无图片</small></div>
          <button type="button" class="quiet slot-upload" data-dialog-upload data-model="${esc(product.model)}" data-color="${esc(variant.color)}" data-view="${esc(view)}">上传</button>
        </div>`;
      }
      const thumbUrl = `/api/internal/image/${encodeURIComponent(image.file)}?v=${bust}`;
      return `<div class="dialog-slot">
        <div class="slot-thumb"><img src="${esc(thumbUrl)}" alt="${esc(image.view)}" loading="lazy"></div>
        <div class="slot-info">
          <b>${esc(image.view)}</b>
          <small>${esc(image.file)}</small>
        </div>
        <div class="slot-actions">
          <button type="button" class="quiet slot-replace" data-dialog-replace data-model="${esc(product.model)}" data-color="${esc(variant.color)}" data-view="${esc(image.view)}">替换</button>
          <button type="button" class="quiet danger slot-remove" data-dialog-remove data-model="${esc(product.model)}" data-color="${esc(variant.color)}" data-view="${esc(image.view)}">删除</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="dialog-color-group">
      <h4>${esc(variant.color)} <span class="view-count">${present.length}/${viewOrder.length} 视角</span></h4>
      <div class="dialog-view-grid">${slots}</div>
    </div>`;
  }).join('');
}

/* ---------- 产品编辑弹窗：颜色管理（基础颜色 + 管理端新增颜色） ---------- */
function renderDialogColors() {
  const product = currentEditing.product;
  const override = currentEditing.override;
  const added = (override && Array.isArray(override.colors)) ? override.colors : [];
  const merged = Array.isArray(product.colors) ? product.colors : [];
  const base = merged.filter((c) => !added.includes(c));
  const chip = (color, isAdded) => `
    <span class="color-chip${isAdded ? ' is-added' : ''}">
      ${esc(color)}
      ${isAdded
        ? `<button type="button" class="chip-remove" data-color-remove="${esc(color)}" title="移除新增颜色">×</button>`
        : '<i title="基础颜色（来自数据源）">基础</i>'}
    </span>`;
  return `<div class="color-chips">
    ${base.map((c) => chip(c, false)).join('')}
    ${added.map((c) => chip(c, true)).join('')}
  </div>`;
}

async function addProductColors() {
  const input = $('dialog-color-input');
  const raw = String(input.value || '').trim();
  if (!raw) { showFormNote('dialog-colors-note', '请输入要新增的颜色名。', true); return; }
  const colors = raw.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
  try {
    await api(`/api/admin/products/${encodeURIComponent(currentEditing.model)}/colors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ colors }),
    });
    hideFormNote('dialog-colors-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-colors-note', error.message, true);
  }
}

async function removeProductColor(color) {
  if (!confirm(`确定移除新增颜色「${color}」吗？该颜色的图片需先删除。`)) return;
  try {
    await api(`/api/admin/products/${encodeURIComponent(currentEditing.model)}/colors?color=${encodeURIComponent(color)}`, { method: 'DELETE' });
    hideFormNote('dialog-colors-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-colors-note', error.message, true);
  }
}

async function removeSlot() {
  if (!pendingSlot) return;
  if (!confirm(`确定删除 ${pendingSlot.model}/${pendingSlot.color}/${pendingSlot.view} 的图片吗？原图会自动备份到 images-backup。`)) return;
  const status = $('status');
  const error = $('upload-error');
  const note = $('dialog-image-note');
  const fromDialog = !$('product-dialog').classList.contains('hidden') && currentEditing.model === pendingSlot.model;
  try {
    const query = `model=${encodeURIComponent(pendingSlot.model)}&color=${encodeURIComponent(pendingSlot.color)}&view=${encodeURIComponent(pendingSlot.view)}`;
    const response = await fetch(`/api/admin/images/remove?${query}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` } });
    let data = null;
    try { data = await response.json(); } catch { /* 忽略 */ }
    if (!response.ok) throw new Error((data && data.error) || `删除失败（HTTP ${response.status}）`);
    if (fromDialog) {
      note.textContent = `已删除并备份：${data.file}（备份：${data.backup}）`;
      note.classList.remove('is-error');
      note.classList.remove('hidden');
      await openProductDialog(currentEditing.model); // 重新读取产品并刷新弹窗
    }
    await loadCatalog();
    loadAudit();
  } catch (err) {
    if (fromDialog) {
      note.textContent = err.message;
      note.classList.add('is-error');
      note.classList.remove('hidden');
    } else {
      status.classList.add('hidden');
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  }
}

function hideDialogImageNote() {
  const note = $('dialog-image-note');
  note.classList.add('hidden');
  note.classList.remove('is-error');
}

function showFormNote(id, text, isError) {
  const note = $(id);
  note.textContent = text;
  note.classList.toggle('is-error', !!isError);
  note.classList.remove('hidden');
}

function hideFormNote(id) {
  const note = $(id);
  note.classList.add('hidden');
  note.classList.remove('is-error');
}

async function saveProductFields() {
  const form = $('dialog-fields-form');
  const fd = new FormData(form);
  const fields = {};
  for (const def of FIELD_DEFS) {
    const raw = fd.get(def.key);
    let value;
    if (def.type === 'textarea') {
      const arr = String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean);
      value = arr.length ? arr : null;
    } else {
      value = String(raw || '').trim() || null;
    }
    if (value === null) {
      if (fieldIsOverridden(def)) fields[def.key] = null; // 有覆盖才发清除
      continue;
    }
    // 与当前生效值一致时不发（避免产生与基准值相同的无意义覆盖）
    if (fieldValue(def) === (Array.isArray(value) ? value.join('\n') : value)) continue;
    fields[def.key] = value;
  }
  if (!Object.keys(fields).length) {
    showFormNote('dialog-fields-note', '没有需要保存的修改。', false);
    return;
  }
  try {
    await api(`/api/admin/products/${encodeURIComponent(currentEditing.model)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    hideFormNote('dialog-fields-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-fields-note', error.message, true);
  }
}

async function clearFieldOverride(key) {
  try {
    await api(`/api/admin/products/${encodeURIComponent(currentEditing.model)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [key]: null } }),
    });
    hideFormNote('dialog-fields-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-fields-note', error.message, true);
  }
}

async function saveProductStatus() {
  const form = $('dialog-status-form');
  const fd = new FormData(form);
  const status = fd.get('displayStatus');
  const reason = String(fd.get('displayReason') || '').trim();
  const body = {};
  if (status === '__clear__') {
    body.displayStatus = null;
  } else {
    body.displayStatus = status;
    if (reason) body.displayReason = reason;
    if ((status === 'public' || status === 'hidden') && !reason) {
      showFormNote('dialog-status-note', '公开（public）/ 隐藏（hidden）状态必须填写非空审核原因。', true);
      return;
    }
  }
  try {
    await api(`/api/admin/products/${encodeURIComponent(currentEditing.model)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    hideFormNote('dialog-status-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-status-note', error.message, true);
  }
}

async function clearStatusOverride() {
  try {
    await api(`/api/admin/products/${encodeURIComponent(currentEditing.model)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayStatus: null }),
    });
    hideFormNote('dialog-status-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-status-note', error.message, true);
  }
}

/* ---------- 英文翻译（已批准英文字段，仅客户展示模式使用；内部/管理界面固定中文） ---------- */
function translationFieldValue(def) {
  const tr = currentEditing.translation;
  if (!tr) return '';
  const v = tr[def.key];
  return Array.isArray(v) ? v.join('\n') : String(v ?? '');
}

function translationFieldRowHTML(def) {
  const value = translationFieldValue(def);
  const input = def.type === 'textarea'
    ? `<textarea name="${def.key}" rows="3" data-tr-field="${def.key}" placeholder="English ${def.label.replace(/（EN）/, '')}">${esc(value)}</textarea>`
    : `<input name="${def.key}" type="text" data-tr-field="${def.key}" value="${esc(value)}" placeholder="English ${def.label.replace(/（EN）/, '')}">`;
  return `<label class="field">
    <span class="field-label">${esc(def.label)}</span>
    ${input}
  </label>`;
}

function renderDialogTranslationColors() {
  const product = currentEditing.product;
  const tr = currentEditing.translation;
  const colors = Array.isArray(product.colors) ? product.colors : [];
  if (!colors.length) return '<p class="empty-note">该产品暂无颜色。</p>';
  const colorMap = (tr && tr.colors && typeof tr.colors === 'object') ? tr.colors : {};
  return colors.map((color) => `
    <label class="field tr-color-field">
      <span class="field-label">${esc(color)}</span>
      <input type="text" data-tr-color-input="${esc(color)}" value="${esc(colorMap[color] || '')}" placeholder="English color">
    </label>`).join('');
}

async function saveProductTranslations() {
  const form = $('dialog-translations-form');
  const fd = new FormData(form);
  const translations = {};
  for (const def of TR_FIELD_DEFS) {
    const raw = fd.get(def.key);
    const value = def.type === 'textarea'
      ? String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean)
      : String(raw || '').trim();
    translations[def.key] = Array.isArray(value) ? (value.length ? value : null) : (value || null);
  }
  const colors = {};
  document.querySelectorAll('[data-tr-color-input]').forEach((input) => {
    const v = String(input.value || '').trim();
    if (v) colors[input.dataset.trColorInput] = v;
  });
  translations.colors = Object.keys(colors).length ? colors : null;

  // 只提交发生变化的字段：与服务端合并语义一致（空值清除该字段翻译，避免误清未编辑字段）
  const tr = currentEditing.translation || {};
  const payload = {};
  const sameArray = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameValue = (key, val) => {
    const cur = tr[key];
    if (Array.isArray(val)) return Array.isArray(cur) ? sameArray(val, cur) : val.length === 0 && cur === undefined;
    return val === (cur ?? '');
  };
  for (const def of TR_FIELD_DEFS) {
    const val = translations[def.key];
    if (!sameValue(def.key, val)) payload[def.key] = val;
  }
  const colorKeys = Object.keys(translations.colors || {});
  const curColors = (tr.colors && typeof tr.colors === 'object') ? tr.colors : {};
  // 颜色翻译 diff：仅提交有变化的项（未改动的预填值不重复提交，输入清空视为清除该颜色翻译）
  const changedColors = {};
  for (const key of Object.keys(curColors)) {
    const v = colorKeys.includes(key) ? translations.colors[key] : undefined;
    if (v === undefined) changedColors[key] = null;                 // 输入清空 → 清除
    else if (v !== curColors[key]) changedColors[key] = v;          // 值有变化 → 覆盖
  }
  for (const key of colorKeys) {
    if (!Object.prototype.hasOwnProperty.call(curColors, key) && translations.colors[key]) changedColors[key] = translations.colors[key]; // 新增
  }
  if (Object.keys(changedColors).length) payload.colors = changedColors;

  if (!Object.keys(payload).length) {
    showFormNote('dialog-translations-note', '没有需要保存的翻译修改。', false);
    return;
  }
  try {
    await api(`/api/admin/translations/${encodeURIComponent(currentEditing.model)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ translations: payload }),
    });
    hideFormNote('dialog-translations-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-translations-note', error.message, true);
  }
}

async function clearProductTranslations() {
  if (!currentEditing.translation) { showFormNote('dialog-translations-note', '该型号当前没有翻译覆盖，无需清除。', true); return; }
  if (!confirm(`确定清除 ${currentEditing.model} 的全部英文翻译吗？公开目录将回落到词汇表翻译/中文原文。`)) return;
  try {
    await api(`/api/admin/translations/${encodeURIComponent(currentEditing.model)}`, { method: 'DELETE' });
    hideFormNote('dialog-translations-note');
    await openProductDialog(currentEditing.model);
    await loadCatalog();
    loadAudit();
  } catch (error) {
    showFormNote('dialog-translations-note', error.message, true);
  }
}

/* ---------- 审计日志 ---------- */
async function loadAudit() {
  const box = $('audit');
  try {
    const { audit } = await api('/api/admin/audit');
    if (!audit || !audit.length) { box.innerHTML = '<p class="empty-note">暂无审计记录。</p>'; return; }
    box.innerHTML = `<table>
      <thead><tr><th>时间</th><th>动作</th><th>型号</th><th>说明</th></tr></thead>
      <tbody>${audit.slice().reverse().map((entry) => `
        <tr>
          <td class="mono">${esc(entry.ts)}</td>
          <td>${esc(entry.action)}</td>
          <td>${esc(entry.model || '—')}</td>
          <td>${esc(entry.note || '')}</td>
        </tr>`).join('')}</tbody>
    </table>`;
  } catch (error) {
    box.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('token-input').value.trim();
    if (!token) return;
    setToken(token);
    $('token-input').value = '';
    const authed = await checkAuth();
    if (authed) {
      showAdmin();
    } else {
      clearToken();
      $('auth-state').textContent = '未登录';
      $('logout').classList.add('hidden');
      showLogin('令牌无效，请重新输入。');
    }
  });

  $('logout').addEventListener('click', () => {
    clearToken();
    $('auth-state').textContent = '未登录';
    $('logout').classList.add('hidden');
    showLogin();
  });

  $('refresh').addEventListener('click', loadCatalog);
  $('audit-refresh').addEventListener('click', loadAudit);
  $('product-refresh').addEventListener('click', loadCatalog);

  $('rebuild').addEventListener('click', async () => {
    const status = $('status');
    status.classList.remove('hidden');
    status.textContent = '正在重建目录…';
    try {
      const res = await api('/api/admin/rebuild', { method: 'POST' });
      status.textContent = `重建完成：${res.summary.products} 个产品 / ${res.summary.images} 张图片 / 公开 ${res.summary.public} 款`;
      loadCatalog();
      loadAudit();
    } catch (error) {
      status.textContent = `重建失败：${error.message}`;
    }
  });

  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !pendingSlot) return;
    try {
      await precheckFile(file);
      await uploadFile(file);
    } catch (error) {
      const fromDialog = !$('product-dialog').classList.contains('hidden') && currentEditing.model === pendingSlot.model;
      if (fromDialog) {
        const note = $('dialog-image-note');
        note.textContent = `预检未通过：${error.message}`;
        note.classList.add('is-error');
        note.classList.remove('hidden');
      } else {
        $('status').classList.add('hidden');
        $('upload-error').textContent = `预检未通过：${error.message}`;
        $('upload-error').classList.remove('hidden');
      }
    } finally {
      e.target.value = '';
    }
  });

  // 标签页
  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));

  // 产品筛选与排序
  $('filter-q').addEventListener('input', () => { productsFilter.q = $('filter-q').value; renderProducts(); });
  $('filter-model').addEventListener('input', () => { productsFilter.model = $('filter-model').value; renderProducts(); });
  $('filter-category').addEventListener('change', () => { productsFilter.category = $('filter-category').value; renderProducts(); });
  $('filter-brand').addEventListener('change', () => { productsFilter.brand = $('filter-brand').value; renderProducts(); });
  $('filter-status').addEventListener('change', () => { productsFilter.status = $('filter-status').value; renderProducts(); });
  $('sort-field').addEventListener('change', () => { productsFilter.sortField = $('sort-field').value; renderProducts(); });
  $('sort-dir').addEventListener('click', () => {
    productsFilter.sortDir = -productsFilter.sortDir;
    $('sort-dir').textContent = productsFilter.sortDir > 0 ? '升序 ↑' : '降序 ↓';
    renderProducts();
  });
  $('product-reset').addEventListener('click', resetProductsFilter);

  // 图片补充/审核工作台：刷新 / 撤销整批 / 筛选 / 快速审核 / 批量上传
  $('workbench-refresh').addEventListener('click', loadWorkbench);
  $('workbench-undo-all').addEventListener('click', undoLastBatch);
  $('wb-filter-q').addEventListener('input', () => { workbenchFilter.q = $('wb-filter-q').value; renderWorkbenchModels(); });
  $('wb-filter-series').addEventListener('change', () => { workbenchFilter.series = $('wb-filter-series').value; renderWorkbenchModels(); });
  $('wb-filter-status').addEventListener('change', () => { workbenchFilter.status = $('wb-filter-status').value; renderWorkbenchModels(); });
  $('wb-filter-category').addEventListener('change', () => { workbenchFilter.category = $('wb-filter-category').value; renderWorkbenchModels(); });
  $('wb-filter-readiness').addEventListener('change', () => { workbenchFilter.readiness = $('wb-filter-readiness').value; renderWorkbenchModels(); });
  $('wb-filter-completeness').addEventListener('change', () => { workbenchFilter.completeness = $('wb-filter-completeness').value; renderWorkbenchModels(); });
  $('wb-filter-reset').addEventListener('click', () => {
    workbenchFilter = { q: '', series: '', status: '', category: '', readiness: 'all', completeness: 'all' };
    $('wb-filter-q').value = '';
    renderWorkbench();
  });
  // 分类分布芯片：点击按分类筛选（再点一次取消）
  $('workbench-stats').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-wb-cat]');
    if (!chip) return;
    workbenchFilter.category = workbenchFilter.category === chip.dataset.wbCat ? '' : chip.dataset.wbCat;
    renderWorkbench();
  });
  // 工作台产品卡：快速审核动作（公开 / 待审核 / 隐藏 / 清除覆盖 / 编辑）
  $('workbench-models').addEventListener('click', (e) => {
    const card = e.target.closest('.wb-model');
    if (!card) return;
    const model = card.dataset.model;
    const setBtn = e.target.closest('[data-wb-set-status]');
    if (setBtn) { setWorkbenchStatus(model, setBtn.dataset.wbSetStatus); return; }
    if (e.target.closest('[data-wb-clear-status]')) { clearWorkbenchStatus(model); return; }
    if (e.target.closest('[data-wb-edit]')) { openProductDialog(model); }
  });
  $('batch-pick').addEventListener('click', () => { $('batch-file-input').value = ''; $('batch-file-input').click(); });
  $('batch-file-input').addEventListener('change', (e) => { addBatchFiles(e.target.files); e.target.value = ''; });
  $('batch-start').addEventListener('click', startBatch);
  $('batch-clear').addEventListener('click', clearBatch);
  $('batch-dropzone').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    $('batch-file-input').value = '';
    $('batch-file-input').click();
  });
  ['dragover', 'dragenter'].forEach((ev) => {
    $('batch-dropzone').addEventListener(ev, (e) => { e.preventDefault(); $('batch-dropzone').classList.add('is-drag'); });
  });
  $('batch-dropzone').addEventListener('dragleave', () => $('batch-dropzone').classList.remove('is-drag'));
  $('batch-dropzone').addEventListener('drop', (e) => {
    e.preventDefault();
    $('batch-dropzone').classList.remove('is-drag');
    addBatchFiles(e.dataTransfer.files);
  });
  $('batch-queue').addEventListener('input', (e) => {
    const input = e.target.closest('.batch-input');
    if (!input) return;
    const row = e.target.closest('.batch-row');
    const id = row ? Number(row.dataset.id) : NaN;
    const item = batchItems.find((i) => i.id === id);
    if (!item) return;
    const field = input.dataset.field;
    if (field === 'model') item.model = input.value.trim();
    else if (field === 'color') item.color = input.value.trim();
    else if (field === 'view') item.view = input.value;
  });
  $('batch-queue').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove-item]');
    if (removeBtn) { removeBatchItem(Number(removeBtn.dataset.removeItem)); return; }
    const undoBtn = e.target.closest('[data-undo-item]');
    if (undoBtn) { undoItemById(Number(undoBtn.dataset.undoItem)); }
  });

  // 产品列表 → 打开编辑
  $('product-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-edit]');
    if (button) openProductDialog(button.dataset.edit);
  });

  // 对话框
  $('dialog-close').addEventListener('click', closeProductDialog);
  $('product-dialog').addEventListener('click', (e) => {
    if (e.target === $('product-dialog')) closeProductDialog();
  });
  $('dialog-body').addEventListener('click', (e) => {
    const clearField = e.target.closest('[data-clear-field]');
    if (clearField) { clearFieldOverride(clearField.dataset.clearField); return; }
    if (e.target.closest('[data-clear-status]')) { clearStatusOverride(); return; }
    if (e.target.closest('#dialog-fields-reset')) { openProductDialog(currentEditing.model); }
    const upload = e.target.closest('[data-dialog-upload]');
    if (upload) {
      pendingSlot = { model: upload.dataset.model, color: upload.dataset.color, view: upload.dataset.view };
      hideDialogImageNote();
      $('file-input').value = '';
      $('file-input').click();
      return;
    }
    const replace = e.target.closest('[data-dialog-replace]');
    if (replace) {
      pendingSlot = { model: replace.dataset.model, color: replace.dataset.color, view: replace.dataset.view };
      hideDialogImageNote();
      $('file-input').value = '';
      $('file-input').click();
      return;
    }
    const remove = e.target.closest('[data-dialog-remove]');
    if (remove) {
      pendingSlot = { model: remove.dataset.model, color: remove.dataset.color, view: remove.dataset.view };
      removeSlot();
      return;
    }
    const colorRemove = e.target.closest('[data-color-remove]');
    if (colorRemove) { removeProductColor(colorRemove.dataset.colorRemove); return; }
    if (e.target.closest('#dialog-translations-clear')) { clearProductTranslations(); return; }
  });
  $('dialog-body').addEventListener('submit', (e) => {
    if (e.target.id === 'dialog-fields-form') { e.preventDefault(); saveProductFields(); return; }
    if (e.target.id === 'dialog-status-form') { e.preventDefault(); saveProductStatus(); return; }
    if (e.target.id === 'dialog-colors-form') { e.preventDefault(); addProductColors(); return; }
    if (e.target.id === 'dialog-translations-form') { e.preventDefault(); saveProductTranslations(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('product-dialog').classList.contains('hidden')) closeProductDialog();
  });
}

/* ---------- 初始化 ---------- */
async function init() {
  bindEvents();
  const authed = await checkAuth();
  if (authed) {
    showAdmin();
  } else {
    $('auth-state').textContent = '未登录';
    $('logout').classList.add('hidden');
    showLogin();
  }
}

init();
