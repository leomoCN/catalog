'use strict';

/* ============================================================
   路普户外 · 产品展示中心
   纯前端实现：无第三方依赖。客户展示 / 内部查询共用同一套筛选 / 网格 / 图库。
   - 客户展示模式：只加载公开目录、只显示 displayStatus=public 的产品，绝不渲染内部字段。
   - 内部查询模式：加载完整内部目录，额外提供高级筛选（来源系列 / 审核状态 / 精确品牌 /
     业务属性开关 / 容量与批发价区间 / 内部关键词搜索）、分页（每页 50 条）、更多排序、
     产品 / 颜色 / 表格视图切换。全部输出经 esc() 转义。
   ============================================================ */

const GALLERY_VIEWS = ['正面', '45度', '侧面', '背面'];
const GALLERY_EASE = 'transform .34s cubic-bezier(.25,.8,.25,1)';
const PAGE_SIZE = 50; // 每页条数（产品/颜色/表格视图通用）

// 内部查询模式：会话令牌仅保存在当前标签页 sessionStorage（键 internalToken）
const INTERNAL_TOKEN_KEY = 'internalToken';
const INTERNAL_MODE_KEY = 'internalMode';
const STATUS_LABELS = { public: '公开', internal: '内部', pending: '待审核', hidden: '隐藏' };

const MEDIA_META = {
  no:       { label: '暂无实拍图', cls: 'none' },
  partial:  { label: '部分有图', cls: 'warn' },
  complete: { label: '四视角齐全', cls: 'ok' },
};

const SERIES_LABELS = {
  baipai:    '白牌',
  luopu:     '路普',
  heiyin:    '黑鹰',
  veelisi:   '威丽诗 (veelisi)',
  gerannur:  '格朗奴 (Gerannur)',
  unlabelled:'品牌未标注',
  other:     '其他',
};

// 筛选项 -> state 集合字段名
const GROUP_STATE = {
  series: 'series', category: 'categories', color: 'colors', media: 'media',
  source: 'sources', status: 'statuses', brand: 'brands',
};
// 业务属性开关 -> state 布尔字段名
const FLAG_STATE = {
  'has-wholesale': 'hasWholesale',
  'has-moq': 'hasMoq',
  'has-carton': 'hasCarton',
  'has-sizechart': 'hasSizeChart',
  'has-admin-override': 'hasAdminOverride',
};
// 面状计数分组：提取键的函数（用于筛选面板计数与 chip 渲染）
const FACET_GROUPS = [
  { key: 'series',  extract: (p) => [seriesOf(p.brand).key] },
  { key: 'category', extract: (p) => [p.category || '未分类'] },
  { key: 'color',   extract: (p) => p.colors },
  { key: 'media',   extract: (p) => [mediaStatus(p)] },
  { key: 'source',  extract: (p) => [p.source || '未标注'] },
  { key: 'status',  extract: (p) => [p.displayStatus || ''] },
  { key: 'brand',   extract: (p) => [p.brand || '未标注'] },
];

const COLOR_DOT = {
  black: '#242424', white: '#f4f4f4', gray: '#9aa0a6', khaki: '#a98b5f', olive: '#5f6248',
  cp: '#8a8678', acu: '#b3a777', 'black-cp': '#3a3a3a', 'jungle-digital': '#4a5d3a',
  jungle: '#3f5a33', 'sand-digital': '#c2a878', 'three-tone-sand': '#c8a980',
  'ruin-green': '#5c6344', 'russian-camo': '#7c8274', 'python-black': '#232323',
  red: '#c0392b', 'green-cp': '#4e6b3d', 'python-khaki': '#9c8257', 'maple-camo': '#8c4b3f',
  blue: '#2f5d9e', fg: '#5a6b57', 'royal-blue': '#2a4f8f', purple: '#6d4c9e', navy: '#1f2d4d',
  mc: '#6a6f5c', 'tiger-camo': '#7c6a4f', orange: '#d07a2a', camo: '#6b7a52',
  'cp-camo': '#5f6b57', 'grass-green': '#4f7a3a', green: '#3e7d3c', yellow: '#d9b13a',
  pink: '#d49ab0', apricot: '#e5a078', 'star-green': '#3f5f46',
};

/* ============================================================
   客户展示界面国际化（仅客户展示模式生效；内部查询模式与管理页保持中文）
   - 固定 UI 文案与枚举走下方 I18N 字典。
   - 产品资料（品名/分类/品牌/材质/尺寸/容量/重量/卖点/颜色/视角）走「已批准英文字段」
     product.en（公开目录构建时依据 hand-curated 翻译模型生成），仅客户模式按语言显示；
     无英文翻译的产品安全回落到中文原文，绝不机翻。
   - 三种语言：zh=中文 / en=English / bilingual=双语（中文 / English 并列）。
   ============================================================ */
const I18N = {
  zh: {
    'document.title': '路普户外 · 产品展示中心',
    'brand.note': '探索实用设计，发现适合您的户外装备',
    'mode.public': '客户展示',
    'health.connecting': '正在连接…',
    'health.online': '在线展示',
    'health.failed': '连接失败',
    'units.products': '款产品',
    'units.images': '张实拍图',
    'units.colors': '个颜色组合',
    'units.variants': '个颜色变体',
    'units.similarImages': '张相似图片',
    'color.count': '个颜色',
    'search.label': '搜索产品',
    'search.placeholder': '型号、品名、材质、颜色、容量…',
    'filters.aria': '筛选面板',
    'filters.series': '品牌 / 系列',
    'filters.category': '分类',
    'filters.color': '颜色',
    'filters.media': '图片状态',
    'filters.clearGroup': '清除本组筛选',
    'drawer.title': '筛选',
    'drawer.close': '关闭',
    'drawer.apply': '应用',
    'drawer.clear': '清除筛选',
    'media.no': '暂无实拍图',
    'media.partial': '部分有图',
    'media.complete': '四视角齐全',
    'series.baipai': '白牌',
    'series.luopu': '路普',
    'series.heiyin': '黑鹰',
    'series.veelisi': '威丽诗 (veelisi)',
    'series.gerannur': '格朗奴 (Gerannur)',
    'series.unlabelled': '品牌未标注',
    'series.other': '其他',
    'category.fallback': '未分类',
    'brand.fallback': '未标注',
    'image.missing': '暂无图片',
    'image.complete': '四视角齐全',
    'image.partialViews': '缺 {n} 个角度',
    'similar.title': '以图搜相似',
    'similar.desc': '上传参考图片，快速发现外观相近的产品。',
    'similar.upload': '选择参考图片',
    'similar.exit': '退出相似检索',
    'similar.searching': '正在计算相似款式…',
    'similar.results': '以「{ref}」为参考，展示最相近的 {n} 张图片。',
    'similar.failed': '相似检索失败，请更换图片后重试。',
    'similar.none': '未找到相似图片。',
    'similar.score': '{n}% 相似',
    'toolbar.toggleShow': '显示筛选',
    'toolbar.toggleHide': '隐藏筛选',
    'toolbar.filter': '筛选',
    'toolbar.clear': '清除筛选',
    'title.all': '全部产品',
    'title.variant': '颜色视图',
    'title.table': '表格视图',
    'title.similar': '相似款式',
    'view.aria': '视图切换',
    'view.product': '产品视图',
    'view.variant': '颜色视图',
    'view.table': '表格视图',
    'sort.label': '排序方式',
    'sort.default': '默认排序',
    'sort.modelAsc': '型号 A→Z',
    'sort.modelDesc': '型号 Z→A',
    'sort.name': '按品名',
    'sort.category': '按分类',
    'sort.media': '按图片完整度',
    'sort.capacity': '按容量',
    'result.count': '共 {n} 款产品 · {v} 个颜色组合',
    'result.countSimple': '共 {n} 款产品',
    'result.countVariants': '共 {n} 个颜色变体',
    'result.countSimilar': '共 {n} 张相似图片',
    'empty.noMatch': '未找到匹配产品。',
    'empty.noSimilar': '未找到相似图片。',
    'empty.reset': '清除筛选',
    'chips.search': '搜索「{q}」',
    'chips.series': '品牌：{v}',
    'chips.category': '分类：{v}',
    'chips.color': '颜色：{v}',
    'chips.media': '图片：{v}',
    'chips.clearAll': '清除全部',
    'chips.remove': '移除筛选',
    'page.info': '第 {cur} / {pages} 页 · 共 {total} 条',
    'page.prev': '上一页',
    'page.next': '下一页',
    'gallery.aria': '产品图库',
    'gallery.close': '关闭',
    'gallery.prev': '上一张',
    'gallery.next': '下一张',
    'gallery.noImage': '暂无图片',
    'gallery.hint': '左右滑动或使用键盘 ← → 切换视角',
    'gallery.hintNoImage': '该颜色暂无实拍图，点击下方颜色切换',
    'gallery.viewMissing': '{view} · 该视角暂无实拍图',
    'gallery.colorNoImage': '该颜色暂无实拍图',
    'gallery.emptyNote': '实物细节请以样品或线下确认为准',
    'gallery.currentColor': '当前颜色：{c}',
    'gallery.colors': '颜色',
    'gallery.launch': '上市时间：{d}',
    'gallery.similar': '以图搜相似',
    'specs.materials': '材质',
    'specs.dimensions': '尺寸',
    'specs.capacity': '容量',
    'specs.weight': '重量',
    'specs.colorNoteComplete': '四视角齐全',
    'specs.colorNotePartial': '图片不完整',
    'specs.colorNoteNone': '暂无图片',
    'table.model': '型号',
    'table.name': '品名',
    'table.category': '分类',
    'table.brand': '品牌',
    'table.capacity': '容量',
    'table.color': '颜色',
    'table.image': '图片',
  },
  en: {
    'document.title': 'LUOPU Outdoor · Product Showroom',
    'brand.note': 'Explore practical design and find outdoor gear that suits you',
    'mode.public': 'Customer View',
    'health.connecting': 'Connecting…',
    'health.online': 'Online',
    'health.failed': 'Connection failed',
    'units.products': 'products',
    'units.images': 'photos',
    'units.colors': 'colorways',
    'units.variants': 'variants',
    'units.similarImages': 'similar images',
    'color.count': 'colors',
    'search.label': 'Search products',
    'search.placeholder': 'Model, name, material, color, capacity…',
    'filters.aria': 'Filter panel',
    'filters.series': 'Brand / Series',
    'filters.category': 'Category',
    'filters.color': 'Color',
    'filters.media': 'Image status',
    'filters.clearGroup': 'Clear this group',
    'drawer.title': 'Filters',
    'drawer.close': 'Close',
    'drawer.apply': 'Apply',
    'drawer.clear': 'Clear filters',
    'media.no': 'No photos yet',
    'media.partial': 'Partial photos',
    'media.complete': 'All 4 views',
    'series.baipai': 'White-label',
    'series.luopu': 'LUOPU',
    'series.heiyin': 'Black Eagle',
    'series.veelisi': 'VEELISI',
    'series.gerannur': 'GERANNUR',
    'series.unlabelled': 'Unbranded',
    'series.other': 'Other',
    'category.fallback': 'Uncategorized',
    'brand.fallback': 'Unspecified',
    'image.missing': 'No images',
    'image.complete': 'All 4 views',
    'image.partialViews': '{n} views missing',
    'similar.title': 'Similar-image search',
    'similar.desc': 'Upload a reference image to quickly find visually similar products.',
    'similar.upload': 'Choose reference image',
    'similar.exit': 'Exit similar search',
    'similar.searching': 'Computing similar styles…',
    'similar.results': 'Using "{ref}" as reference, showing {n} most similar images.',
    'similar.failed': 'Similar search failed. Try another image.',
    'similar.none': 'No similar images found.',
    'similar.score': '{n}% similar',
    'toolbar.toggleShow': 'Show filters',
    'toolbar.toggleHide': 'Hide filters',
    'toolbar.filter': 'Filters',
    'toolbar.clear': 'Clear filters',
    'title.all': 'All products',
    'title.variant': 'Color view',
    'title.table': 'Table view',
    'title.similar': 'Similar styles',
    'view.aria': 'View switch',
    'view.product': 'Product view',
    'view.variant': 'Color view',
    'view.table': 'Table view',
    'sort.label': 'Sort by',
    'sort.default': 'Default',
    'sort.modelAsc': 'Model A→Z',
    'sort.modelDesc': 'Model Z→A',
    'sort.name': 'By name',
    'sort.category': 'By category',
    'sort.media': 'By image completeness',
    'sort.capacity': 'By capacity',
    'result.count': '{n} products · {v} colorways',
    'result.countSimple': '{n} products',
    'result.countVariants': '{n} variants',
    'result.countSimilar': '{n} similar images',
    'empty.noMatch': 'No matching products.',
    'empty.noSimilar': 'No similar images found.',
    'empty.reset': 'Clear filters',
    'chips.search': 'Search "{q}"',
    'chips.series': 'Brand: {v}',
    'chips.category': 'Category: {v}',
    'chips.color': 'Color: {v}',
    'chips.media': 'Images: {v}',
    'chips.clearAll': 'Clear all',
    'chips.remove': 'Remove filter',
    'page.info': 'Page {cur}/{pages} · {total} items',
    'page.prev': 'Prev',
    'page.next': 'Next',
    'gallery.aria': 'Product gallery',
    'gallery.close': 'Close',
    'gallery.prev': 'Previous',
    'gallery.next': 'Next',
    'gallery.noImage': 'No images',
    'gallery.hint': 'Swipe or use ← → to switch views',
    'gallery.hintNoImage': 'No photos for this color. Tap a color below to switch',
    'gallery.viewMissing': '{view}: no photo for this angle yet',
    'gallery.colorNoImage': 'No photos for this color yet',
    'gallery.emptyNote': 'Details subject to physical sample',
    'gallery.currentColor': 'Current color: {c}',
    'gallery.colors': 'Colors',
    'gallery.launch': 'Launch: {d}',
    'gallery.similar': 'Similar search',
    'specs.materials': 'Material',
    'specs.dimensions': 'Dimensions',
    'specs.capacity': 'Capacity',
    'specs.weight': 'Weight',
    'specs.colorNoteComplete': 'All 4 views',
    'specs.colorNotePartial': 'Incomplete photos',
    'specs.colorNoteNone': 'No images',
    'table.model': 'Model',
    'table.name': 'Name',
    'table.category': 'Category',
    'table.brand': 'Brand',
    'table.capacity': 'Capacity',
    'table.color': 'Color',
    'table.image': 'Images',
  },
};
const LANG_MODES = ['zh', 'en', 'bilingual'];

/* 翻译：仅客户展示模式（public）应用；内部查询模式与管理页固定中文。
   双语模式返回「中文 / English」并列。产品资料（型号/品名/颜色/材质等）一律不翻译。
   args 中的 {name} 占位符在翻译模板中替换（数值/搜索词等，渲染前统一经 esc 转义）。 */
function t(key, args) {
  const zh = I18N.zh[key];
  if (zh === undefined) return key;
  let out = zh;
  if (state.mode === 'public') {
    const en = I18N.en[key];
    if (en && en !== zh) {
      if (state.lang === 'en') out = en;
      else if (state.lang === 'bilingual') out = `${zh} / ${en}`;
    }
  }
  if (args) out = out.replace(/\{(\w+)\}/g, (m, k) => (args[k] !== undefined ? String(args[k]) : m));
  return out;
}

/* ============================================================
   产品资料翻译（Phase 2）：只对公开目录中「已批准英文字段」生效。
   - product.en 由构建脚本依据 hand-curated 翻译模型（data/translations.json）生成，
     绝不机翻；内部目录不携带 en（内部/管理界面固定中文）。
   - pTr(zh, en)：按客户界面语言返回 中文 / English / 中文 / English 并列；
     英文缺失或等于中文时安全回落到中文原文。
   - 内部查询模式（state.mode !== 'public'）一律返回中文。
   ============================================================ */
function pTr(zh, en) {
  if (state.mode !== 'public') return zh ?? '';
  if (!hasValue(zh)) return en ?? '';
  if (!hasValue(en) || String(en) === String(zh)) return zh;
  if (state.lang === 'en') return String(en);
  if (state.lang === 'bilingual') return `${zh} / ${en}`;
  return zh;
}

function pEn(product, key) {
  if (!product || !product.en) return null;
  const value = product.en[key];
  return hasValue(value) ? value : null;
}

function colorEn(product, color) {
  const en = product && product.en && product.en.colors;
  if (en && hasValue(en[color])) return String(en[color]);
  return null;
}

function viewEn(view) {
  const labels = state.catalog && state.catalog.viewLabels;
  return labels && hasValue(labels[view]) ? String(labels[view]) : null;
}

/* 筛选面板 / 芯片使用的跨产品枚举翻译：在当前目录中查找任一带 en 的产品做标签；
   找不到时返回 null（前端回落到中文）。仅客户展示模式查询。 */
function enLabelFor(key, zh) {
  if (state.mode !== 'public' || !hasValue(zh)) return null;
  for (const p of state.catalog.products || []) {
    const value = pEn(p, key);
    if (hasValue(value)) return String(value);
  }
  return null;
}

function enColorFor(zh) {
  if (state.mode !== 'public') return null;
  const map = state.enColorByZh;
  return map && hasValue(map[zh]) ? map[zh] : null;
}

/* ---------- 状态 ---------- */
const state = {
  catalog: null,
  mode: 'public', // 'public'（客户展示） | 'internal'（内部查询，需密码登录）
  lang: 'zh',     // 客户展示界面语言：'zh' | 'en' | 'bilingual'（内部模式固定中文）
  q: '',          // 公开字段关键词（型号/品名/材质/颜色/容量…）
  advQ: '',       // 内部关键词（仅内部模式：备注/来源/价格/尺码/箱规/状态…）
  series: new Set(),
  categories: new Set(),
  colors: new Set(),
  media: new Set(),
  sources: new Set(),    // 内部：来源系列（如 01-步狼（白牌））
  statuses: new Set(),   // 内部：displayStatus（public/internal/pending/hidden）
  brands: new Set(),     // 内部：精确品牌
  hasWholesale: false,   // 内部：有批发价
  hasMoq: false,         // 内部：有 MOQ
  hasCarton: false,      // 内部：有箱规（箱规尺寸或装箱数量）
  hasSizeChart: false,   // 内部：有尺码表/尺码
  hasAdminOverride: false, // 内部：有管理端覆盖
  capacityMin: '',       // 内部：容量最小值（L）
  capacityMax: '',       // 内部：容量最大值（L）
  wholesaleMin: '',      // 内部：批发价最低（¥）
  wholesaleMax: '',      // 内部：批发价最高（¥）
  viewMode: 'product',   // 'product' | 'variant' | 'table'
  sort: 'default',
  similar: null,
  page: 1,
  productByModel: null,
  colorKey: new Map(),
  enColorByZh: null,     // 全局颜色中文 -> 英文（公开目录产品 en.colors 汇总，用于筛选面板/芯片）
  viewOrder: GALLERY_VIEWS,
};

const featureCache = new Map(); // image.id|url -> {hist, hash}（相似特征缓存）
let filterEls = null;
let publicCatalog = null;   // 公开目录（仅 displayStatus=public，客户模式使用）
let internalCatalog = null; // 内部完整目录（全部 410 款，内部模式加载后缓存）
let internalToken = sessionStorage.getItem(INTERNAL_TOKEN_KEY) || null;
let lastPages = 1;          // 分页：当前结果总页数（用于翻页事件）
let healthState = 'connecting'; // 'connecting' | 'online' | 'failed'（顶栏连接状态）

/* ---------- 基础工具 ---------- */
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const hasValue = (v) => v !== undefined && v !== null && v !== '';

function seriesOf(brand) {
  const b = String(brand || '').trim();
  if (!b) return { key: 'unlabelled', label: SERIES_LABELS.unlabelled };
  if (b.startsWith('白牌')) return { key: 'baipai', label: SERIES_LABELS.baipai };
  if (b.startsWith('路普')) return { key: 'luopu', label: SERIES_LABELS.luopu };
  if (b.startsWith('黑鹰')) return { key: 'heiyin', label: SERIES_LABELS.heiyin };
  if (b.startsWith('veelisi') || b.includes('威丽诗')) return { key: 'veelisi', label: SERIES_LABELS.veelisi };
  if (b.startsWith('Gerannur') || b.includes('格朗奴')) return { key: 'gerannur', label: SERIES_LABELS.gerannur };
  return { key: 'other', label: SERIES_LABELS.other };
}
const seriesLabel = (key) => SERIES_LABELS[key] || SERIES_LABELS.other;
const colorDot = (colorKey) => COLOR_DOT[colorKey] || '#a7adbb';

function productByModel(model) { return state.productByModel.get(model) || null; }
function variantFor(product, color) { return (product.variants || []).find((v) => v.color === color) || null; }

/* 产品级图片状态：no=无图 / partial=部分有图 / complete=四视角齐全 */
function mediaStatus(p) {
  const variants = p.variants || [];
  const any = variants.some((v) => Object.keys(v.views || {}).length);
  if (!any) return 'no';
  const allOk = variants.every((v) => !Object.keys(v.views || {}).length || v.complete);
  return allOk ? 'complete' : 'partial';
}

/* 公开字段搜索串（客户展示与内部模式共用；不含任何内部字段）
   客户展示模式额外并入已批准英文字段（en），支持英文关键词检索；内部目录不携带 en。 */
function haystackFor(p) {
  const parts = [p.model, p.name, p.category, p.brand, seriesLabel(seriesOf(p.brand).key), p.materials, p.dimensions, p.capacity, p.weight, ...(p.sellingPoints || []), ...p.colors];
  if (state.mode === 'public' && p.en) {
    const en = p.en;
    parts.push(en.name, en.category, en.brand, en.materials, en.dimensions, en.capacity, en.weight);
    if (Array.isArray(en.sellingPoints)) parts.push(...en.sellingPoints);
    if (en.colors) parts.push(...Object.values(en.colors));
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/* 内部字段搜索串（仅内部模式调用；含批发/零售/线上价、MOQ、箱规、来源、备注、尺码、审核等） */
function internalHaystackFor(p) {
  if (state.mode !== 'internal') return haystackFor(p);
  const parts = [
    p.model, p.name, p.category, p.brand, seriesLabel(seriesOf(p.brand).key),
    p.materials, p.dimensions, p.capacity, p.weight, ...(p.sellingPoints || []), ...p.colors,
    p.wholesalePrice, p.retailPrice, p.onlinePrice, p.moq,
    p.cartonSize, p.cartonQty, p.cartonWeight,
    p.source, p.notes, p.size, p.sizeChart, p.launchDate, p.returnDate, p.spec,
    p.displayStatus, p.displayReason,
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/* ---------- 数据索引 ---------- */
function buildIndexes() {
  state.productByModel = new Map(state.catalog.products.map((p) => [p.model, p]));
  state.viewOrder = state.catalog.viewOrder || GALLERY_VIEWS;
  for (const p of state.catalog.products) {
    for (const v of p.variants || []) if (!state.colorKey.has(v.color)) state.colorKey.set(v.color, v.colorKey);
  }
  // 汇总公开目录产品 en.colors，用于筛选面板/芯片的颜色英文标签（仅客户展示模式）
  const colorMap = {};
  for (const p of state.catalog.products) {
    if (p.en && p.en.colors) {
      for (const [zh, en] of Object.entries(p.en.colors)) {
        if (hasValue(en) && !colorMap[zh]) colorMap[zh] = String(en);
      }
    }
  }
  state.enColorByZh = colorMap;
}

/* ---------- 内部查询模式：登录 / 会话 / 401 回退 ---------- */
function internalHeaders() {
  return internalToken ? { Authorization: `Bearer ${internalToken}` } : {};
}

async function internalApi(path) {
  const response = await fetch(path, { headers: internalHeaders() });
  if (response.status === 401) {
    handleInternalUnauthorized();
    throw new Error('内部会话已失效，请重新登录');
  }
  let data = null;
  try { data = await response.json(); } catch { /* 非 JSON 响应 */ }
  if (!response.ok) throw new Error((data && data.error) || `内部请求失败（HTTP ${response.status}）`);
  return data;
}

/* 同步与模式相关的 UI 特性：高级筛选可见性、内部排序项、离开内部模式时清空内部筛选 */
function syncModeFeatures() {
  const isInternal = state.mode === 'internal';
  $('advanced-filters').classList.toggle('hidden', !isInternal);
  document.querySelectorAll('#sort .internal-only').forEach((opt) => { opt.hidden = !isInternal; });
  if (!isInternal) {
    state.advQ = '';
    state.sources.clear();
    state.statuses.clear();
    state.brands.clear();
    state.hasWholesale = state.hasMoq = state.hasCarton = state.hasSizeChart = state.hasAdminOverride = false;
    state.capacityMin = state.capacityMax = state.wholesaleMin = state.wholesaleMax = '';
    if (state.sort === 'wholesale' || state.sort === 'status') state.sort = 'default';
    $('adv-search').value = '';
    ['capacity-min', 'capacity-max', 'wholesale-min', 'wholesale-max'].forEach((id) => { if ($(id)) $(id).value = ''; });
  }
  if ($('sort').value !== state.sort) $('sort').value = state.sort;
}

function updateModeUI() {
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  const stateEl = $('mode-state');
  const logoutBtn = $('internal-logout');
  if (state.mode === 'internal') {
    stateEl.textContent = '内部查询 · 已登录';
    logoutBtn.classList.remove('hidden');
  } else {
    stateEl.textContent = '';
    logoutBtn.classList.add('hidden');
  }
  $('count').textContent = `${state.catalog.products.length} ${t('units.products')} · ${state.catalog.images.length} ${t('units.images')}`;
  updateLangControl();
  syncModeFeatures();
}

function activatePublicMode() {
  state.mode = 'public';
  sessionStorage.removeItem(INTERNAL_MODE_KEY);
  internalCatalog = null; // 切回客户模式时清空内部数据
  if (publicCatalog) {
    state.catalog = publicCatalog;
    buildIndexes();
  }
  applyLanguage(); // 重新绘制语言相关 UI（客户模式恢复所选语言；内部模式固定中文）
  resetFilters();
}

function requestInternalMode() {
  if (!internalToken) { showInternalLoginDialog(); return; }
  activateInternalMode();
}

async function activateInternalMode() {
  state.mode = 'internal';
  sessionStorage.setItem(INTERNAL_MODE_KEY, '1');
  try {
    if (!internalCatalog) internalCatalog = await internalApi('/api/internal/catalog');
  } catch (error) {
    if (state.mode === 'internal') activatePublicMode();
    return;
  }
  state.catalog = internalCatalog;
  buildIndexes();
  applyLanguage(); // 内部查询模式：语言开关隐藏、界面固定中文
  resetFilters();
}

function handleInternalUnauthorized() {
  internalToken = null;
  sessionStorage.removeItem(INTERNAL_TOKEN_KEY);
  sessionStorage.removeItem(INTERNAL_MODE_KEY);
  if (state.mode === 'internal' && publicCatalog) {
    state.mode = 'public';
    state.catalog = publicCatalog;
    buildIndexes();
    applyLanguage(); // 401 回退后同样重建筛选选项并恢复客户界面语言
    resetFilters();
  }
  showInternalLoginDialog();
}

async function logoutInternal() {
  if (internalToken) {
    try { await fetch('/api/internal/logout', { method: 'POST', headers: internalHeaders() }); } catch { /* 忽略网络错误 */ }
  }
  internalToken = null;
  sessionStorage.removeItem(INTERNAL_TOKEN_KEY);
  sessionStorage.removeItem(INTERNAL_MODE_KEY);
  activatePublicMode();
}

function showInternalLoginDialog() {
  const dialog = $('internal-login-dialog');
  $('internal-login-error').classList.add('hidden');
  $('internal-password').value = '';
  dialog.showModal();
  $('internal-password').focus();
}

async function submitInternalLogin(password) {
  const response = await fetch('/api/internal/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429) throw new Error((data && data.error) || '登录尝试过多，请稍后再试');
    throw new Error((data && data.error) || '密码错误');
  }
  internalToken = data.token;
  sessionStorage.setItem(INTERNAL_TOKEN_KEY, data.token);
}

async function restoreInternalSession() {
  if (!internalToken) return;
  const wasInternal = sessionStorage.getItem(INTERNAL_MODE_KEY) === '1';
  try {
    const response = await fetch('/api/internal/session', { headers: internalHeaders() });
    const data = await response.json().catch(() => null);
    if (!data || data.authenticated !== true) {
      internalToken = null;
      sessionStorage.removeItem(INTERNAL_TOKEN_KEY);
      if (wasInternal) showInternalLoginDialog(); // 刷新后会话失效 → 重新登录
      return;
    }
    if (wasInternal) await activateInternalMode();
  } catch { /* 网络异常：保持当前状态 */ }
}

/* ---------- 内部数值工具：容量/价格解析（用于区间过滤与排序） ---------- */
function numericBounds(raw) {
  if (!hasValue(raw)) return null;
  const nums = String(raw).match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const vals = nums.map(Number);
  return { lo: Math.min(...vals), hi: Math.max(...vals) };
}

function capacityInRange(p) {
  const b = numericBounds(p.capacity);
  if (!b) return false;
  if (state.capacityMin !== '' && b.hi < Number(state.capacityMin)) return false;
  if (state.capacityMax !== '' && b.lo > Number(state.capacityMax)) return false;
  return true;
}

function wholesaleInRange(p) {
  const b = numericBounds(p.wholesalePrice);
  if (!b) return false;
  if (state.wholesaleMin !== '' && b.hi < Number(state.wholesaleMin)) return false;
  if (state.wholesaleMax !== '' && b.lo > Number(state.wholesaleMax)) return false;
  return true;
}

/* ---------- 管理端覆盖检测（纯客户端、尽力而为） ----------
   内部目录不携带“是否被覆盖”标记；这里用可复现的构建默认值反推：
   - 有实拍图的型号默认 displayStatus=pending，其余默认 internal；
   - 若实际状态偏离默认值，则判定为管理端覆盖。
   当前 admin-store 全部是审核状态覆盖，因此该判定与实际覆盖完全一致。 */
function photoModels() {
  return state.catalog ? new Set(state.catalog.images.map((img) => img.model)) : new Set();
}
function defaultDisplayStatusFor(p) {
  return photoModels().has(p.model) ? 'pending' : 'internal';
}
function isAdminOverridden(p) {
  return p.displayStatus !== defaultDisplayStatusFor(p);
}

/* ---------- 筛选 ---------- */
function productMatches(p, exclude) {
  const q = state.q.trim().toLowerCase();
  if (q && !haystackFor(p).includes(q)) return false;
  const aq = state.advQ.trim().toLowerCase();
  if (aq && !internalHaystackFor(p).includes(aq)) return false;
  if (exclude !== 'series' && state.series.size && !state.series.has(seriesOf(p.brand).key)) return false;
  if (exclude !== 'category' && state.categories.size && !state.categories.has(p.category || '未分类')) return false;
  if (exclude !== 'color' && state.colors.size && !p.colors.some((c) => state.colors.has(c))) return false;
  if (exclude !== 'media' && state.media.size && !state.media.has(mediaStatus(p))) return false;
  if (exclude !== 'source' && state.sources.size && !state.sources.has(p.source || '')) return false;
  if (exclude !== 'status' && state.statuses.size && !state.statuses.has(p.displayStatus || '')) return false;
  if (exclude !== 'brand' && state.brands.size && !state.brands.has(p.brand || '未标注')) return false;
  if (state.hasWholesale && !hasValue(p.wholesalePrice)) return false;
  if (state.hasMoq && !hasValue(p.moq)) return false;
  if (state.hasCarton && !hasValue(p.cartonSize) && !hasValue(p.cartonQty)) return false;
  if (state.hasSizeChart && !hasValue(p.sizeChart) && !hasValue(p.size)) return false;
  if (state.hasAdminOverride && !isAdminOverridden(p)) return false;
  if ((state.capacityMin !== '' || state.capacityMax !== '') && !capacityInRange(p)) return false;
  if ((state.wholesaleMin !== '' || state.wholesaleMax !== '') && !wholesaleInRange(p)) return false;
  return true;
}

const productMatchesFilters = (p) => productMatches(p, null);

function filterProducts() {
  return state.catalog.products.filter(productMatchesFilters);
}

const byModelSort = (a, b, num) => a.model.localeCompare(b.model, 'zh-Hans-CN', num);
function mediaOrder(s) { return s === 'complete' ? 0 : s === 'partial' ? 1 : 2; }
function statusOrder(s) { return { public: 0, pending: 1, internal: 2, hidden: 3 }[s] ?? 4; }
function loValue(p, field) { const b = numericBounds(p[field]); return b ? b.lo : Number.MAX_VALUE; }

function sortedProducts(products) {
  const arr = [...products];
  const num = { numeric: true };
  switch (state.sort) {
    case 'model-asc': arr.sort((a, b) => byModelSort(a, b, num)); break;
    case 'model-desc': arr.sort((a, b) => -byModelSort(a, b, num)); break;
    case 'name': arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN') || byModelSort(a, b, num)); break;
    case 'category': arr.sort((a, b) => (a.category || '￿').localeCompare(b.category || '￿', 'zh-Hans-CN') || byModelSort(a, b, num)); break;
    case 'media': arr.sort((a, b) => mediaOrder(mediaStatus(a)) - mediaOrder(mediaStatus(b)) || byModelSort(a, b, num)); break;
    case 'capacity': arr.sort((a, b) => loValue(a, 'capacity') - loValue(b, 'capacity') || byModelSort(a, b, num)); break;
    case 'wholesale': arr.sort((a, b) => loValue(a, 'wholesalePrice') - loValue(b, 'wholesalePrice') || byModelSort(a, b, num)); break;
    case 'status': arr.sort((a, b) => statusOrder(a.displayStatus) - statusOrder(b.displayStatus) || byModelSort(a, b, num)); break;
  }
  return arr;
}

function variantTotal(products) {
  return products.reduce((n, p) => n + p.variants.filter((v) => !state.colors.size || state.colors.has(v.color)).length, 0);
}

/* ---------- 筛选面板 ---------- */
function countProductsBy(pred, keyFn) {
  const counts = new Map();
  for (const p of state.catalog.products) {
    if (!pred(p)) continue;
    for (const key of keyFn(p)) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function checkboxHTML(group, value, label, count, dotColor) {
  const checked = state[GROUP_STATE[group]].has(value) ? 'checked' : '';
  const dot = dotColor ? `<span class="color-dot" style="background:${dotColor}"></span>` : '';
  return `<label class="check"><input type="checkbox" class="filter-check" data-group="${group}" data-value="${esc(value)}" ${checked}>${dot}<span class="check-label">${esc(label)}</span><span class="count">${count || ''}</span></label>`;
}

function renderFilterPanel() {
  const seriesCounts = countProductsBy(() => true, (p) => [seriesOf(p.brand).key]);
  const catCounts = countProductsBy(() => true, (p) => [p.category || '未分类']);
  const colorCounts = countProductsBy(() => true, (p) => p.colors);

  $('series-filters').innerHTML = [...seriesCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => checkboxHTML('series', key, t('series.' + key), n)).join('');

  $('category-filters').innerHTML = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => checkboxHTML('category', key, pTr(key, enLabelFor('category', key)), n)).join('');

  $('color-filters').innerHTML = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color, n]) => checkboxHTML('color', color, pTr(color, enColorFor(color)), colorDot(state.colorKey.get(color) || ''))).join('');

  $('media-filters').innerHTML = ['no', 'partial', 'complete']
    .map((key) => checkboxHTML('media', key, t('media.' + key), countProductsBy(() => true, (p) => [mediaStatus(p)]).get(key) || '')).join('');

  renderAdvancedFilters();

  filterEls = { series: {}, category: {}, color: {}, media: {}, source: {}, status: {}, brand: {} };
  document.querySelectorAll('.filter-check').forEach((input) => {
    const group = input.dataset.group;
    if (GROUP_STATE[group]) filterEls[group][input.dataset.value] = input;
  });
}

/* 高级筛选面板：仅内部查询模式渲染与可见；客户模式保持 hidden */
function renderAdvancedFilters() {
  const isInternal = state.mode === 'internal';
  const adv = $('advanced-filters');
  if (!adv) return;
  adv.classList.toggle('hidden', !isInternal);
  if (!isInternal) return;

  const sourceCounts = countProductsBy(() => true, (p) => [p.source || '未标注']);
  const statusCounts = countProductsBy(() => true, (p) => [p.displayStatus || '']);
  const brandCounts = countProductsBy(() => true, (p) => [p.brand || '未标注']);

  $('source-filters').innerHTML = [...sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => checkboxHTML('source', key, key, n)).join('');

  $('status-filters').innerHTML = [...statusCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([key, n]) => checkboxHTML('status', key, STATUS_LABELS[key] || key, n)).join('');

  $('brand-filters').innerHTML = [...brandCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => checkboxHTML('brand', key, key, n)).join('');

  refreshAdvFlagCounts();
}

/* 面状计数：计算其他筛选条件下每组数量，就地更新数字（不重建 DOM） */
function refreshFilterCounts() {
  if (!filterEls) return;
  for (const g of FACET_GROUPS) {
    const els = filterEls[g.key];
    if (!els) continue;
    const m = new Map();
    for (const p of state.catalog.products) {
      if (!productMatches(p, g.key)) continue;
      for (const k of g.extract(p)) m.set(k, (m.get(k) || 0) + 1);
    }
    for (const value in els) {
      const n = m.get(value) || 0;
      const countEl = els[value].closest('.check')?.querySelector('.count');
      if (countEl) countEl.textContent = n || '';
    }
  }
  refreshAdvFlagCounts();
}

/* 业务属性开关计数：在其余筛选条件下，各开关命中的产品数（仅内部模式） */
function refreshAdvFlagCounts() {
  if (state.mode !== 'internal' || !state.catalog) return;
  const flagPred = {
    'has-wholesale': (p) => hasValue(p.wholesalePrice),
    'has-moq': (p) => hasValue(p.moq),
    'has-carton': (p) => hasValue(p.cartonSize) || hasValue(p.cartonQty),
    'has-sizechart': (p) => hasValue(p.sizeChart) || hasValue(p.size),
    'has-admin-override': (p) => isAdminOverridden(p),
  };
  for (const flag in flagPred) {
    const el = $(`count-${flag}`);
    if (!el) continue;
    const key = FLAG_STATE[flag];
    const saved = state[key];
    state[key] = false;
    const n = state.catalog.products.filter((p) => productMatches(p, null)).filter(flagPred[flag]).length;
    state[key] = saved;
    el.textContent = n ? String(n) : '';
  }
}

function syncFilterCheckboxes() {
  document.querySelectorAll('.filter-check').forEach((input) => {
    const set = state[GROUP_STATE[input.dataset.group]];
    if (set) input.checked = set.has(input.dataset.value);
  });
  document.querySelectorAll('.flag-check').forEach((input) => {
    input.checked = state[FLAG_STATE[input.dataset.flag]] === true;
  });
}

/* ---------- 筛选芯片 ---------- */
function renderChips() {
  const chips = [];
  if (state.q) chips.push({ kind: 'q', label: t('chips.search', { q: state.q }) });
  if (state.advQ) chips.push({ kind: 'advq', label: `内部搜索「${state.advQ}」` });
  for (const key of state.series) chips.push({ kind: 'series', value: key, label: t('chips.series', { v: t('series.' + key) }) });
  for (const key of state.categories) chips.push({ kind: 'category', value: key, label: t('chips.category', { v: pTr(key, enLabelFor('category', key)) }) });
  for (const key of state.colors) chips.push({ kind: 'color', value: key, label: t('chips.color', { v: pTr(key, enColorFor(key)) }) });
  for (const key of state.media) chips.push({ kind: 'media', value: key, label: t('chips.media', { v: t('media.' + key) }) });
  for (const key of state.sources) chips.push({ kind: 'source', value: key, label: `来源：${key}` });
  for (const key of state.statuses) chips.push({ kind: 'status', value: key, label: `状态：${STATUS_LABELS[key] || key}` });
  for (const key of state.brands) chips.push({ kind: 'brand', value: key, label: `品牌：${key}` });
  if (state.hasWholesale) chips.push({ kind: 'flag', value: 'hasWholesale', label: '有批发价' });
  if (state.hasMoq) chips.push({ kind: 'flag', value: 'hasMoq', label: '有MOQ' });
  if (state.hasCarton) chips.push({ kind: 'flag', value: 'hasCarton', label: '有箱规' });
  if (state.hasSizeChart) chips.push({ kind: 'flag', value: 'hasSizeChart', label: '有尺码表' });
  if (state.hasAdminOverride) chips.push({ kind: 'flag', value: 'hasAdminOverride', label: '有管理端覆盖' });
  if (state.capacityMin !== '') chips.push({ kind: 'capacity', value: 'min', label: `容量 ≥ ${state.capacityMin}L` });
  if (state.capacityMax !== '') chips.push({ kind: 'capacity', value: 'max', label: `容量 ≤ ${state.capacityMax}L` });
  if (state.wholesaleMin !== '') chips.push({ kind: 'wholesale', value: 'min', label: `批发价 ≥ ¥${state.wholesaleMin}` });
  if (state.wholesaleMax !== '') chips.push({ kind: 'wholesale', value: 'max', label: `批发价 ≤ ¥${state.wholesaleMax}` });

  const wrap = $('chips');
  if (!chips.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = chips.map((c) =>
    `<span class="chip" data-kind="${c.kind}" data-value="${esc(c.value || '')}">${esc(c.label)}<button type="button" class="chip-remove" aria-label="${esc(t('chips.remove'))}">×</button></span>`
  ).join('') + `<button type="button" class="chip clear" id="clear-all">${esc(t('chips.clearAll'))}</button>`;
}

function removeFilter(kind, value) {
  if (kind === 'q') { state.q = ''; syncSearchInputs(''); }
  else if (kind === 'advq') { state.advQ = ''; $('adv-search').value = ''; }
  else if (kind === 'series') state.series.delete(value);
  else if (kind === 'category') state.categories.delete(value);
  else if (kind === 'color') state.colors.delete(value);
  else if (kind === 'media') state.media.delete(value);
  else if (kind === 'source') state.sources.delete(value);
  else if (kind === 'status') state.statuses.delete(value);
  else if (kind === 'brand') state.brands.delete(value);
  else if (kind === 'flag') { state[value] = false; }
  else if (kind === 'capacity') {
    if (value === 'min') { state.capacityMin = ''; if ($('capacity-min')) $('capacity-min').value = ''; }
    else { state.capacityMax = ''; if ($('capacity-max')) $('capacity-max').value = ''; }
  }
  else if (kind === 'wholesale') {
    if (value === 'min') { state.wholesaleMin = ''; if ($('wholesale-min')) $('wholesale-min').value = ''; }
    else { state.wholesaleMax = ''; if ($('wholesale-max')) $('wholesale-max').value = ''; }
  }
  syncFilterCheckboxes();
  applyFilters();
}

function clearAdvancedFilters() {
  state.advQ = '';
  state.sources.clear();
  state.statuses.clear();
  state.brands.clear();
  state.hasWholesale = state.hasMoq = state.hasCarton = state.hasSizeChart = state.hasAdminOverride = false;
  state.capacityMin = state.capacityMax = state.wholesaleMin = state.wholesaleMax = '';
  $('adv-search').value = '';
  ['capacity-min', 'capacity-max', 'wholesale-min', 'wholesale-max'].forEach((id) => { if ($(id)) $(id).value = ''; });
  syncFilterCheckboxes();
  applyFilters();
}

function activeFilterCount() {
  let n = 0;
  if (state.q) n++;
  if (state.advQ) n++;
  n += state.series.size + state.categories.size + state.colors.size + state.media.size
    + state.sources.size + state.statuses.size + state.brands.size;
  if (state.hasWholesale) n++;
  if (state.hasMoq) n++;
  if (state.hasCarton) n++;
  if (state.hasSizeChart) n++;
  if (state.hasAdminOverride) n++;
  if (state.capacityMin !== '') n++;
  if (state.capacityMax !== '') n++;
  if (state.wholesaleMin !== '') n++;
  if (state.wholesaleMax !== '') n++;
  return n;
}

function resetFilters() {
  state.q = '';
  state.advQ = '';
  state.series.clear();
  state.categories.clear();
  state.colors.clear();
  state.media.clear();
  state.sources.clear();
  state.statuses.clear();
  state.brands.clear();
  state.hasWholesale = false;
  state.hasMoq = false;
  state.hasCarton = false;
  state.hasSizeChart = false;
  state.hasAdminOverride = false;
  state.capacityMin = '';
  state.capacityMax = '';
  state.wholesaleMin = '';
  state.wholesaleMax = '';
  state.sort = 'default';
  state.viewMode = 'product';
  state.similar = null;
  state.page = 1;
  syncSearchInputs('');
  $('adv-search').value = '';
  $('sort').value = 'default';
  ['capacity-min', 'capacity-max', 'wholesale-min', 'wholesale-max'].forEach((id) => { if ($(id)) $(id).value = ''; });
  $('similar-status').classList.add('hidden');
  $('clear-similar').classList.add('hidden');
  setViewToggle('product');
  syncFilterCheckboxes();
  applyFilters();
}

function setViewToggle(mode) {
  document.querySelectorAll('#view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
}

function setFiltersHidden(hidden) {
  document.body.classList.toggle('filters-hidden', hidden);
  $('toggle-filters').setAttribute('aria-pressed', String(hidden));
  $('toggle-filters').textContent = hidden ? t('toolbar.toggleShow') : t('toolbar.toggleHide');
}

/* ---------- 客户界面语言：中文 / English / 双语（仅客户展示模式；内部模式固定中文） ---------- */
function langShortLabel() {
  return state.lang === 'bilingual' ? '中/EN' : (state.lang === 'en' ? 'EN' : '中');
}

function updateLangControl() {
  const langSwitch = $('lang-switch');
  if (langSwitch) langSwitch.classList.toggle('hidden', state.mode !== 'public');
  document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
  const mobile = $('mobile-lang');
  if (mobile) {
    mobile.classList.toggle('hidden', state.mode !== 'public');
    mobile.textContent = langShortLabel();
  }
}

function setLang(lang) {
  if (!LANG_MODES.includes(lang)) return;
  state.lang = lang;
  try { localStorage.setItem('langPref', lang); } catch { /* 隐私模式等场景忽略 */ }
  applyLanguage();
}

/* 静态文案（data-i18n / data-i18n-ph / data-i18n-title / data-i18n-aria）统一重绘 */
function renderStaticLabels() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}

function updateHealth() {
  const el = $('health');
  if (el) el.textContent = t(`health.${healthState}`);
}

function updateToggleFiltersLabel() {
  const btn = $('toggle-filters');
  if (btn) btn.textContent = document.body.classList.contains('filters-hidden') ? t('toolbar.toggleShow') : t('toolbar.toggleHide');
}

function syncSearchInputs(value) {
  const v = value === undefined ? state.q : value;
  if ($('search')) $('search').value = v;
  if ($('mobile-search')) $('mobile-search').value = v;
}

/* 语言/模式变化时重绘全部客户可见文案（静态标签 + 筛选面板 + 网格/芯片/分页 + 图库） */
function applyLanguage() {
  renderStaticLabels();
  updateHealth();
  updateModeUI();
  renderFilterPanel();
  applyFilters();
  const dialog = $('gallery-dialog');
  if (dialog && dialog.open && gallery.model) renderGalleryDOM();
  updateLangControl();
}

/* ---------- 移动端：悬浮工具栏与筛选底部抽屉（≤760px 生效，桌面端隐藏） ---------- */
function openFiltersDrawer() {
  document.body.classList.add('drawer-open');
  $('mobile-filter-btn').setAttribute('aria-pressed', 'true');
  $('drawer-backdrop').classList.add('open');
}

function closeFiltersDrawer() {
  document.body.classList.remove('drawer-open');
  $('mobile-filter-btn').setAttribute('aria-pressed', 'false');
  $('drawer-backdrop').classList.remove('open');
}

function toggleFiltersDrawer() {
  if (document.body.classList.contains('drawer-open')) closeFiltersDrawer();
  else openFiltersDrawer();
}

function cycleLang() {
  const idx = LANG_MODES.indexOf(state.lang);
  setLang(LANG_MODES[(idx + 1) % LANG_MODES.length]);
}

/* ---------- 网格渲染 ---------- */
function coverFor(product) {
  for (const v of product.variants || []) {
    const img = v.views['正面'] || v.views['45度'] || v.views['侧面'] || v.views['背面'];
    if (img) return img;
  }
  return null;
}

function noPhotoHTML() {
  return `<div class="thumb no-photo"><svg viewBox="0 0 96 120" width="58" height="74" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M24 40 V96 Q24 106 34 106 H62 Q72 106 72 96 V40 L62 30 H34 Z"/><path d="M30 40 V18 Q30 8 40 8 H56 Q66 8 66 18 V40"/><path d="M24 56 H36 L46 66"/><path d="M72 56 H60 L50 66"/></svg><span class="no-photo-label">${esc(t('media.no'))}</span></div>`;
}

/* ---------- 内部模式专用字段渲染（仅在 state.mode === 'internal' 时输出，全部经 esc 转义） ---------- */
function internalStatusBadgeHTML(p) {
  const status = p.displayStatus || '';
  const label = STATUS_LABELS[status] || status || '—';
  return `<span class="badge status-${esc(status)}">${esc(label)}</span>`;
}

function internalCardInfoHTML(p) {
  if (state.mode !== 'internal' || !p) return '';
  const parts = [];
  if (p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesalePrice !== '') parts.push(`<span class="badge price">批发 ¥${esc(p.wholesalePrice)}</span>`);
  if (p.retailPrice !== undefined && p.retailPrice !== null && p.retailPrice !== '') parts.push(`<span class="badge price">零售 ¥${esc(p.retailPrice)}</span>`);
  if (p.moq !== undefined && p.moq !== null && p.moq !== '') parts.push(`<span class="badge">MOQ ${esc(p.moq)}</span>`);
  parts.push(internalStatusBadgeHTML(p));
  return `<div class="card-internal">${parts.join('')}</div>`;
}

function internalGalleryHTML(p) {
  if (state.mode !== 'internal' || !p) return '';
  const rows = [];
  const add = (label, value) => { if (value !== undefined && value !== null && value !== '') rows.push(`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`); };
  add('批发价', p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesalePrice !== '' ? `¥${p.wholesalePrice}` : null);
  add('零售价', p.retailPrice !== undefined && p.retailPrice !== null && p.retailPrice !== '' ? `¥${p.retailPrice}` : null);
  add('线上价', p.onlinePrice !== undefined && p.onlinePrice !== null && p.onlinePrice !== '' ? `¥${p.onlinePrice}` : null);
  add('MOQ', p.moq);
  add('箱规尺寸', p.cartonSize);
  add('装箱数量', p.cartonQty);
  add('装箱重量', p.cartonWeight);
  add('来源系列', p.source);
  add('内部备注', p.notes);
  add('审核原因', p.displayReason);
  const statusLine = `<div class="internal-status"><span class="internal-status-label">审核状态</span>${internalStatusBadgeHTML(p)}</div>`;
  const specs = rows.length ? `<dl class="specs internal-specs">${rows.join('')}</dl>` : '';
  return `<div class="internal-panel">
    <h3 class="section-title internal-title">内部资料</h3>
    <p class="internal-hint">以下字段仅内部查询模式可见，仅供内部业务使用。</p>
    ${statusLine}
    ${specs}
  </div>`;
}

function productCardHTML(p) {
  const cover = coverFor(p);
  const media = MEDIA_META[mediaStatus(p)];
  const thumb = cover ? `<div class="thumb"><img loading="lazy" src="${esc(cover.url)}" alt="${esc(p.model)}"></div>` : noPhotoHTML();
  const nameEn = pEn(p, 'name');
  const categoryEn = pEn(p, 'category');
  const brandEn = pEn(p, 'brand');
  return `<article class="card product-card" tabindex="0" role="button" data-model="${esc(p.model)}" aria-label="${esc(p.model)} ${esc(pTr(p.name, nameEn))}">
    ${thumb}
    <div class="card-body">
      <div class="card-title">${esc(p.model)}</div>
      <div class="card-sub">${esc(pTr(p.name, nameEn))}</div>
      <div class="card-tags"><span class="card-tag">${esc(pTr(p.category || t('category.fallback'), categoryEn || enLabelFor('category', p.category)))}</span><span class="card-tag">${esc(pTr(p.brand || t('brand.fallback'), brandEn || enLabelFor('brand', p.brand)))}</span></div>
      <div class="card-foot"><span class="badge">${p.variants.length} ${t('color.count')}</span><span class="badge ${media.cls}">${esc(t('media.' + mediaStatus(p)))}</span></div>
      ${internalCardInfoHTML(p)}
    </div>
  </article>`;
}

function variantCardHTML(product, variant) {
  const img = variant.views['正面'] || variant.views['45度'] || variant.views['侧面'] || variant.views['背面'] || null;
  const thumb = img ? `<div class="thumb"><img loading="lazy" src="${esc(img.url)}" alt="${esc(product.model)} ${esc(variant.color)}"></div>` : noPhotoHTML();
  const count = Object.keys(variant.views).length;
  const label = count ? (variant.complete ? t('image.complete') : t('image.partialViews', { n: variant.missingViews.length })) : t('image.missing');
  const cls = variant.complete ? 'ok' : (count ? 'warn' : 'none');
  const colorEnV = colorEn(product, variant.color);
  const nameEn = pEn(product, 'name');
  return `<article class="card variant-card" tabindex="0" role="button" data-model="${esc(product.model)}" data-color="${esc(variant.color)}" aria-label="${esc(product.model)} ${esc(variant.color)}">
    ${thumb}
    <div class="card-body">
      <div class="card-title">${esc(product.model)}</div>
      <div class="card-sub">${esc(pTr(variant.color, colorEnV))} · ${esc(pTr(product.name, nameEn))}</div>
      <div class="card-tags"><span class="card-tag">${esc(pTr(product.category || t('category.fallback'), pEn(product, 'category')))}</span></div>
      <div class="card-foot"><span class="badge ${cls}">${esc(label)}</span></div>
      ${internalCardInfoHTML(product)}
    </div>
  </article>`;
}

function similarCardHTML(result) {
  const img = result.image;
  const product = productByModel(img.model);
  const variant = product ? variantFor(product, img.color) : null;
  const complete = !!(variant && variant.complete);
  const colorEnV = product ? colorEn(product, img.color) : null;
  const viewLabel = pTr(img.view, viewEn(img.view));
  return `<article class="card variant-card similar-card" tabindex="0" role="button" data-model="${esc(img.model)}" data-color="${esc(img.color)}" data-view="${esc(img.view)}" aria-label="${esc(img.model)} ${esc(img.color)} ${esc(img.view)}">
    <div class="thumb"><img loading="lazy" src="${esc(img.url)}" alt="${esc(img.model)} ${esc(img.color)} ${esc(img.view)}"></div>
    <div class="card-body">
      <div class="card-title">${esc(img.model)}</div>
      <div class="card-sub">${esc(pTr(img.color, colorEnV))} · ${esc(viewLabel)}</div>
      <div class="card-tags"><span class="card-tag">${esc(pTr(product ? (product.category || t('category.fallback')) : t('category.fallback'), product ? pEn(product, 'category') : null))}</span><span class="card-tag">${esc(pTr(product ? (product.brand || t('brand.fallback')) : t('brand.fallback'), product ? pEn(product, 'brand') : null))}</span></div>
      <div class="card-foot"><span class="badge score">${t('similar.score', { n: result.score })}</span><span class="badge ${complete ? 'ok' : 'none'}">${esc(complete ? t('image.complete') : t('image.missing'))}</span></div>
      ${product ? internalCardInfoHTML(product) : ''}
    </div>
  </article>`;
}

/* 表格视图：内部模式追加内部列；客户模式绝不输出内部字段 */
function tableHTML(products) {
  const isInternal = state.mode === 'internal';
  const head = `<thead><tr>
    <th>${esc(t('table.model'))}</th><th>${esc(t('table.name'))}</th><th>${esc(t('table.category'))}</th><th>${esc(t('table.brand'))}</th><th>${esc(t('table.capacity'))}</th><th>${esc(t('table.color'))}</th><th>${esc(t('table.image'))}</th>
    ${isInternal ? '<th>批发价</th><th>MOQ</th><th>箱规</th><th>来源系列</th><th>审核状态</th>' : ''}
  </tr></thead>`;
  const rows = products.map((p) => {
    const media = MEDIA_META[mediaStatus(p)];
    const nameEn = pEn(p, 'name');
    const categoryEn = pEn(p, 'category');
    const brandEn = pEn(p, 'brand');
    const capacityEn = pEn(p, 'capacity');
    let tds = `<td class="td-model">${esc(p.model)}</td>
      <td class="td-name">${esc(pTr(p.name, nameEn))}</td>
      <td>${esc(pTr(p.category || t('category.fallback'), categoryEn || enLabelFor('category', p.category)))}</td>
      <td>${esc(pTr(p.brand || t('brand.fallback'), brandEn || enLabelFor('brand', p.brand)))}</td>
      <td>${esc(pTr(p.capacity || '', capacityEn))}</td>
      <td>${p.variants.length} ${t('color.count')}</td>
      <td><span class="badge ${media.cls}">${esc(t('media.' + mediaStatus(p)))}</span></td>`;
    if (isInternal) {
      tds += `<td>${hasValue(p.wholesalePrice) ? `¥${esc(p.wholesalePrice)}` : '—'}</td>
        <td>${hasValue(p.moq) ? esc(p.moq) : '—'}</td>
        <td>${hasValue(p.cartonSize) ? esc(p.cartonSize) : (hasValue(p.cartonQty) ? esc(p.cartonQty) : '—')}</td>
        <td>${esc(p.source || '—')}</td>
        <td>${internalStatusBadgeHTML(p)}</td>`;
    }
    return `<tr class="table-row" data-model="${esc(p.model)}" tabindex="0">${tds}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="data-table">${head}<tbody>${rows}</tbody></table></div>`;
}

/* ---------- 分页（每页 PAGE_SIZE 条） ---------- */
function paginate(items) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  state.page = clamp(state.page, 1, pages);
  const start = (state.page - 1) * PAGE_SIZE;
  return { pageItems: items.slice(start, start + PAGE_SIZE), total, pages };
}

function renderPagination(total, pages) {
  lastPages = pages;
  const wrap = $('pagination');
  if (state.similar || pages <= 1) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  const cur = state.page;
  const btn = (n, label, cls) => `<button type="button" class="page-btn ${cls || ''}" data-page="${n}" ${n === cur ? 'aria-current="page"' : ''}>${label}</button>`;
  const dots = '<span class="page-dots">…</span>';
  let inner = '';
  const win = 2;
  const start = Math.max(1, cur - win);
  const end = Math.min(pages, cur + win);
  if (start > 2) { inner += btn(1, '1'); inner += dots; }
  else if (start === 2) { inner += btn(1, '1'); }
  for (let i = start; i <= end; i++) inner += btn(i, String(i), i === cur ? 'current' : '');
  if (end < pages - 1) { inner += dots; inner += btn(pages, String(pages)); }
  else if (end === pages - 1) { inner += btn(pages, String(pages)); }
  wrap.innerHTML = `<span class="page-info">${esc(t('page.info', { cur, pages, total }))}</span>
    <div class="page-nav">
      <button type="button" class="page-btn" data-page="prev" ${cur <= 1 ? 'disabled' : ''}>${esc(t('page.prev'))}</button>
      ${inner}
      <button type="button" class="page-btn" data-page="next" ${cur >= pages ? 'disabled' : ''}>${esc(t('page.next'))}</button>
    </div>`;
}

function renderGrid() {
  const grid = $('grid');
  const empty = $('empty-state');
  const title = $('result-title');
  const count = $('result-count');

  if (state.similar) {
    title.textContent = t('title.similar');
    count.textContent = t('result.countSimilar', { n: state.similar.results.length });
    grid.innerHTML = state.similar.results.map(similarCardHTML).join('');
    empty.classList.toggle('hidden', state.similar.results.length > 0);
    empty.innerHTML = `<p>${esc(t('empty.noSimilar'))}</p>`;
    $('pagination').classList.add('hidden');
    return;
  }

  const products = sortedProducts(filterProducts());
  const variants = products.flatMap((p) =>
    p.variants.filter((v) => !state.colors.size || state.colors.has(v.color)).map((v) => ({ product: p, variant: v }))
  );

  const emptyHTML = `<p>${esc(t('empty.noMatch'))}</p><button type="button" class="quiet" id="empty-reset">${esc(t('empty.reset'))}</button>`;

  if (state.viewMode === 'product') {
    title.textContent = t('title.all');
    count.textContent = products.length ? t('result.count', { n: products.length, v: variantTotal(products) }) : '';
    const { pageItems, total, pages } = paginate(products);
    grid.innerHTML = pageItems.map(productCardHTML).join('');
    empty.classList.toggle('hidden', total > 0);
    if (!total) empty.innerHTML = emptyHTML;
    renderPagination(total, pages);
  } else if (state.viewMode === 'variant') {
    title.textContent = t('title.variant');
    count.textContent = variants.length ? t('result.countVariants', { n: variants.length }) : '';
    const { pageItems, total, pages } = paginate(variants);
    grid.innerHTML = pageItems.map(({ product, variant }) => variantCardHTML(product, variant)).join('');
    empty.classList.toggle('hidden', total > 0);
    if (!total) empty.innerHTML = emptyHTML;
    renderPagination(total, pages);
  } else {
    title.textContent = t('title.table');
    count.textContent = products.length ? t('result.countSimple', { n: products.length }) : '';
    const { pageItems, total, pages } = paginate(products);
    grid.innerHTML = tableHTML(pageItems);
    empty.classList.toggle('hidden', total > 0);
    if (!total) empty.innerHTML = emptyHTML;
    renderPagination(total, pages);
  }
}

function applyFilters() {
  state.page = 1;
  renderChips();
  refreshFilterCounts();
  renderGrid();
  const active = activeFilterCount() > 0 || state.similar || state.viewMode !== 'product' || state.sort !== 'default';
  $('reset').classList.toggle('hidden', !active);
  if (activeFilterCount() > 0) $('reset').textContent = `${t('toolbar.clear')} (${activeFilterCount()})`;
  else $('reset').textContent = t('toolbar.clear');
  const mobileCount = $('mobile-count');
  if (mobileCount) {
    if (state.similar) mobileCount.textContent = `${state.similar.results.length} ${t('units.similarImages')}`;
    else mobileCount.textContent = `${sortedProducts(filterProducts()).length} ${t('units.products')}`;
  }
  const badge = $('mobile-filter-badge');
  if (badge) {
    const n = activeFilterCount();
    badge.classList.toggle('hidden', n === 0);
    badge.textContent = n > 99 ? '99+' : String(n);
  }
}

/* ============================================================
   统一产品图库（卡片与相似结果共用）
   ============================================================ */
const gallery = { model: null, color: null, index: 0, itemCount: 1, drag: null };

function openGallery(model, color, viewIndex) {
  const product = productByModel(model);
  if (!product) return;
  const variant = variantFor(product, color) || product.variants[0];
  gallery.model = model;
  gallery.color = variant.color;
  gallery.index = clamp(viewIndex || 0, 0, state.viewOrder.length - 1);
  renderGalleryDOM();
  $('gallery-dialog').showModal();
}

function galleryVariant() {
  const product = productByModel(gallery.model);
  return product ? (variantFor(product, gallery.color) || product.variants[0]) : null;
}
function galleryCurrentImage() {
  const variant = galleryVariant();
  if (!variant) return null;
  return variant.views[state.viewOrder[gallery.index]] || null;
}

function renderGalleryDOM() {
  const product = productByModel(gallery.model);
  const variant = galleryVariant();
  if (!product || !variant) return;
  gallery.color = variant.color;

  const hasImages = Object.keys(variant.views).length > 0;
  const itemCount = hasImages ? state.viewOrder.length : 1;
  gallery.index = clamp(gallery.index, 0, itemCount - 1);
  gallery.itemCount = itemCount;
  const current = galleryCurrentImage();

  let trackItems;
  if (hasImages) {
    trackItems = state.viewOrder.map((view) => {
      const img = variant.views[view];
      const viewLabel = pTr(view, viewEn(view));
      if (img) return `<div class="g-item"><img src="${esc(img.url)}" alt="${esc(product.model)} ${esc(variant.color)} ${esc(view)}" loading="lazy"></div>`;
      return `<div class="g-item g-item-empty"><p>${esc(t('gallery.viewMissing', { view: viewLabel }))}</p></div>`;
    }).join('');
  } else {
    trackItems = `<div class="g-item g-item-empty g-item-void"><p>${esc(t('gallery.colorNoImage'))}</p><p class="g-empty-note">${esc(t('gallery.emptyNote'))}</p></div>`;
  }

  const thumbs = state.viewOrder.map((view, i) => {
    const img = variant.views[view];
    const viewLabel = pTr(view, viewEn(view));
    if (!hasImages) return `<button type="button" class="g-thumb" disabled aria-label="${esc(viewLabel)}"><span class="g-thumb-missing">${esc(viewLabel)}</span><b>${esc(viewLabel)}</b></button>`;
    return `<button type="button" class="g-thumb ${i === gallery.index ? 'active' : ''}" data-index="${i}" ${img ? '' : 'disabled'} aria-label="${esc(viewLabel)}">${img ? `<img src="${esc(img.url)}" alt="${esc(viewLabel)}">` : `<span class="g-thumb-missing">${esc(viewLabel)}</span>`}<b>${esc(viewLabel)}</b></button>`;
  }).join('');

  const colorButtons = product.variants.map((v) => {
    const n = Object.keys(v.views).length;
    const note = v.complete ? t('specs.colorNoteComplete') : (n ? t('specs.colorNotePartial') : t('specs.colorNoteNone'));
    const colorLabel = pTr(v.color, colorEn(product, v.color));
    return `<button type="button" class="color-swatch ${v.color === variant.color ? 'active' : ''}" data-color="${esc(v.color)}">${esc(colorLabel)}<small>${esc(note)}</small></button>`;
  }).join('');

  const spEn = pEn(product, 'sellingPoints');
  const specsRows = [
    product.materials ? `<dt>${esc(t('specs.materials'))}</dt><dd>${esc(pTr(product.materials, pEn(product, 'materials')))}</dd>` : '',
    product.dimensions ? `<dt>${esc(t('specs.dimensions'))}</dt><dd>${esc(pTr(product.dimensions, pEn(product, 'dimensions')))}</dd>` : '',
    product.capacity ? `<dt>${esc(t('specs.capacity'))}</dt><dd>${esc(pTr(product.capacity, pEn(product, 'capacity')))}</dd>` : '',
    product.weight ? `<dt>${esc(t('specs.weight'))}</dt><dd>${esc(pTr(product.weight, pEn(product, 'weight')))}</dd>` : '',
  ].join('');
  const launch = product.launchDate ? `<p class="g-launch">${esc(t('gallery.launch', { d: product.launchDate }))}</p>` : '';

  $('gallery-dialog').innerHTML = `
    <button type="button" class="close" id="gallery-close" aria-label="${esc(t('gallery.close'))}">×</button>
    <div class="gallery-layout">
      <section class="gallery-stage">
        <div class="g-main" id="g-main">
          <div class="g-viewport" id="g-viewport">
            <div class="g-track" id="g-track">${trackItems}</div>
          </div>
          <button type="button" class="g-arrow g-prev" id="g-prev" aria-label="${esc(t('gallery.prev'))}" ${gallery.index === 0 ? 'disabled' : ''}>‹</button>
          <button type="button" class="g-arrow g-next" id="g-next" aria-label="${esc(t('gallery.next'))}" ${gallery.index >= itemCount - 1 ? 'disabled' : ''}>›</button>
          <div class="g-counter" id="g-counter">${hasImages ? `${gallery.index + 1} / ${itemCount}` : esc(t('gallery.noImage'))}</div>
          <div class="g-hint" id="g-hint">${hasImages ? esc(t('gallery.hint')) : esc(t('gallery.hintNoImage'))}</div>
        </div>
        <div class="g-thumbs" id="g-thumbs">${thumbs}</div>
      </section>
      <section class="gallery-info">
        <div class="g-crumb">${esc(pTr(product.category || t('category.fallback'), pEn(product, 'category')))} · ${esc(pTr(product.brand || t('brand.fallback'), pEn(product, 'brand')))}</div>
        <h2 class="g-title">${esc(product.model)} · ${esc(pTr(product.name, pEn(product, 'name')))}</h2>
        ${launch}
        <p class="g-current">${esc(t('gallery.currentColor', { c: pTr(variant.color, colorEn(product, variant.color)) }))}</p>
        ${product.sellingPoints && product.sellingPoints.length ? `<ul class="g-points">${product.sellingPoints.map((p, i) => `<li>${esc(pTr(p, Array.isArray(spEn) && spEn[i] ? spEn[i] : null))}</li>`).join('')}</ul>` : ''}
        <h3 class="section-title">${esc(t('gallery.colors'))}</h3>
        <div class="color-swatches" id="gallery-colors">${colorButtons}</div>
        ${specsRows ? `<dl class="specs">${specsRows}</dl>` : ''}
        ${internalGalleryHTML(product)}
        <button type="button" class="gallery-similar" id="gallery-similar" ${current ? '' : 'disabled'}>${esc(t('gallery.similar'))}</button>
      </section>
    </div>`;

  const track = $('g-track');
  track.style.transition = 'none';
  track.style.transform = `translateX(${-gallery.index * 100}%)`;
  bindGalleryEvents(hasImages);
  updateGalleryControls();
}

function bindGalleryEvents(hasImages) {
  const dialog = $('gallery-dialog');

  $('gallery-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  dialog.onkeydown = (e) => {
    if (e.key === 'ArrowLeft' && gallery.index > 0) { e.preventDefault(); changeGalleryIndex(-1); }
    else if (e.key === 'ArrowRight' && gallery.index < gallery.itemCount - 1) { e.preventDefault(); changeGalleryIndex(1); }
  };

  $('g-prev').addEventListener('click', () => changeGalleryIndex(-1));
  $('g-next').addEventListener('click', () => changeGalleryIndex(1));

  document.querySelectorAll('#gallery-dialog .g-thumb:not(:disabled)').forEach((b) =>
    b.addEventListener('click', () => animateToIndex(Number(b.dataset.index))));

  document.querySelectorAll('#gallery-dialog .color-swatch').forEach((b) =>
    b.addEventListener('click', () => switchGalleryColor(b.dataset.color)));

  $('gallery-similar').addEventListener('click', () => {
    const img = galleryCurrentImage();
    if (img) { dialog.close(); startSimilar(img); }
  });

  bindGalleryDrag(hasImages);
}

function changeGalleryIndex(step) {
  const target = clamp(gallery.index + step, 0, gallery.itemCount - 1);
  if (target !== gallery.index) animateToIndex(target);
}

/* 视角切换：带动画、边界禁用、缩略图/计数同步 */
function animateToIndex(target) {
  gallery.index = target;
  const track = $('g-track');
  if (track) {
    track.style.transition = GALLERY_EASE;
    track.style.transform = `translateX(${-target * 100}%)`;
  }
  updateGalleryControls();
}

function updateGalleryControls() {
  const prev = $('g-prev');
  const next = $('g-next');
  if (prev) prev.disabled = gallery.index === 0;
  if (next) next.disabled = gallery.index >= gallery.itemCount - 1;
  document.querySelectorAll('#gallery-dialog .g-thumb').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.index) === gallery.index));
  const counter = $('g-counter');
  if (counter) counter.textContent = gallery.itemCount > 1 ? `${gallery.index + 1} / ${gallery.itemCount}` : t('gallery.noImage');
  const sim = $('gallery-similar');
  if (sim) sim.disabled = !galleryCurrentImage();
}

function switchGalleryColor(color) {
  const product = productByModel(gallery.model);
  const variant = variantFor(product, color);
  if (!variant || variant.color === gallery.color) return;
  gallery.color = variant.color;
  gallery.index = Object.keys(variant.views).length ? clamp(gallery.index, 0, state.viewOrder.length - 1) : 0;
  renderGalleryDOM();
}

/* 拖拽手势：pointerdown/move/up/cancel + 捕获生命周期，跟随拖动后吸附回弹 */
function bindGalleryDrag(hasImages) {
  if (!hasImages) return;
  const viewport = $('g-viewport');
  const track = $('g-track');
  const main = $('g-main');

  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gallery.drag = { startX: e.clientX, startIndex: gallery.index };
    track.style.transition = 'none';
    main.classList.add('dragging');
    try { viewport.setPointerCapture(e.pointerId); } catch { /* 合成事件或已捕获场景忽略 */ }
    e.preventDefault();
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!gallery.drag) return;
    const width = viewport.clientWidth || 1;
    const deltaPct = ((e.clientX - gallery.drag.startX) / width) * 100;
    let t = -gallery.drag.startIndex * 100 + deltaPct;
    const max = -(gallery.itemCount - 1) * 100;
    if (t > 0) t *= 0.35;                            // 首屏越界阻力
    else if (t < max) t = max + (t - max) * 0.35;    // 尾屏越界阻力
    track.style.transform = `translateX(${t}%)`;
  });

  const finish = (target) => {
    gallery.drag = null;
    main.classList.remove('dragging');
    track.style.transition = GALLERY_EASE;
    animateToIndex(clamp(target, 0, gallery.itemCount - 1));
  };

  viewport.addEventListener('pointerup', (e) => {
    if (!gallery.drag) return;
    const width = viewport.clientWidth || 1;
    const ratio = (e.clientX - gallery.drag.startX) / width;
    let target = gallery.drag.startIndex;
    if (ratio <= -0.18) target = gallery.drag.startIndex + 1;
    else if (ratio >= 0.18) target = gallery.drag.startIndex - 1;
    finish(target);
  });

  viewport.addEventListener('pointercancel', () => {
    if (!gallery.drag) return;
    gallery.drag = null;
    main.classList.remove('dragging');
    track.style.transition = GALLERY_EASE;
    track.style.transform = `translateX(${-gallery.index * 100}%)`; // 取消时回弹原位
  });
}

/* ============================================================
   以图搜相似（浏览器端颜色直方图 + dHash，特征缓存，排除查询图）
   ============================================================ */
function pixelsToFeatures(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        const hist = new Array(64).fill(0);
        const gray = [];
        for (let i = 0; i < data.length; i += 4) {
          hist[(data[i] >> 6) * 16 + (data[i + 1] >> 6) * 4 + (data[i + 2] >> 6)]++;
          gray.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
        }
        const hash = [];
        for (let y = 0; y < 32; y += 4) {
          for (let x = 0; x < 28; x += 4) hash.push(gray[y * 32 + x] > gray[y * 32 + x + 4] ? 1 : 0);
        }
        resolve({ hist: hist.map((v) => v / 1024), hash });
      } catch (error) { reject(error); }
    };
    image.onerror = reject;
    image.src = source;
  });
}

function distance(a, b) {
  const histogram = a.hist.reduce((sum, value, i) => sum + Math.abs(value - b.hist[i]), 0) / 2;
  const hash = a.hash.reduce((sum, value, i) => sum + (value !== b.hash[i] ? 1 : 0), 0) / a.hash.length;
  return histogram * 0.65 + hash * 0.35;
}

async function featuresForImage(image) {
  const key = image.id || image.url;
  if (featureCache.has(key)) return featureCache.get(key);
  const feature = await pixelsToFeatures(image.url).catch(() => null);
  featureCache.set(key, feature);
  return feature;
}

async function startSimilar(image) {
  const status = $('similar-status');
  status.classList.remove('hidden');
  status.textContent = t('similar.searching');
  try {
    const query = await featuresForImage(image);
    if (!query) throw new Error('query failed');
    const candidates = state.catalog.images.filter((img) => img.id !== image.id && img.url !== image.url);
    const features = await Promise.all(candidates.map(featuresForImage));
    const results = features
      .map((feature, i) => feature ? { image: candidates[i], score: Math.max(0, Math.round((1 - distance(query, feature)) * 100)) } : null)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
    state.similar = { results, label: `${image.model} · ${image.color} · ${image.view}` };
    $('clear-similar').classList.remove('hidden');
    status.textContent = t('similar.results', { ref: state.similar.label, n: results.length });
    renderGrid();
  } catch (error) {
    status.textContent = t('similar.failed');
  }
}

function exitSimilar() {
  state.similar = null;
  $('similar-status').classList.add('hidden');
  $('clear-similar').classList.add('hidden');
  applyFilters();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('search').addEventListener('input', (e) => { state.q = e.target.value.trim(); syncSearchInputs(); applyFilters(); });
  $('mobile-search').addEventListener('input', (e) => { state.q = e.target.value.trim(); syncSearchInputs(); applyFilters(); });
  $('adv-search').addEventListener('input', (e) => { state.advQ = e.target.value.trim(); applyFilters(); });

  $('filters').addEventListener('change', (e) => {
    const input = e.target;
    if (input.classList.contains('filter-check')) {
      const set = state[GROUP_STATE[input.dataset.group]];
      if (set) { if (input.checked) set.add(input.dataset.value); else set.delete(input.dataset.value); }
      applyFilters();
      return;
    }
    if (input.classList.contains('flag-check')) {
      const key = FLAG_STATE[input.dataset.flag];
      if (key) state[key] = input.checked;
      applyFilters();
    }
  });

  $('filters').addEventListener('click', (e) => {
    const clear = e.target.closest('.group-clear');
    if (!clear) return;
    const group = clear.dataset.group;
    if (group === 'advanced') { clearAdvancedFilters(); return; }
    const set = state[GROUP_STATE[group]];
    if (set) set.clear();
    syncFilterCheckboxes();
    applyFilters();
  });

  $('adv-toggle').addEventListener('click', () => {
    const body = $('adv-body');
    const collapsed = body.classList.toggle('hidden');
    $('adv-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('adv-toggle').textContent = collapsed ? '展开高级筛选' : '收起高级筛选';
  });

  [['capacity-min', 'capacityMin'], ['capacity-max', 'capacityMax'], ['wholesale-min', 'wholesaleMin'], ['wholesale-max', 'wholesaleMax']]
    .forEach(([id, key]) => {
      $(id).addEventListener('input', (e) => { state[key] = e.target.value.trim(); applyFilters(); });
    });

  $('chips').addEventListener('click', (e) => {
    const remove = e.target.closest('.chip-remove');
    if (remove) {
      const chip = remove.closest('.chip');
      removeFilter(chip.dataset.kind, chip.dataset.value);
      return;
    }
    if (e.target.closest('#clear-all')) resetFilters();
  });

  $('reset').addEventListener('click', resetFilters);

  $('toggle-filters').addEventListener('click', () => setFiltersHidden(!document.body.classList.contains('filters-hidden')));

  $('view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.viewMode = btn.dataset.view;
    setViewToggle(state.viewMode);
    applyFilters();
  });

  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; applyFilters(); });

  $('pagination').addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    const pages = lastPages;
    let target = state.page;
    if (btn.dataset.page === 'prev') target = state.page - 1;
    else if (btn.dataset.page === 'next') target = state.page + 1;
    else target = Number(btn.dataset.page);
    target = clamp(target, 1, pages);
    if (target === state.page) return;
    state.page = target;
    renderGrid();
    const bar = document.querySelector('.content .toolbar');
    if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('grid').addEventListener('click', (e) => {
    const resetBtn = e.target.closest('#empty-reset');
    if (resetBtn) { resetFilters(); return; }
    const row = e.target.closest('.table-row');
    if (row) { openGallery(row.dataset.model); return; }
    const card = e.target.closest('.card');
    if (!card) return;
    if (card.classList.contains('similar-card')) openGallery(card.dataset.model, card.dataset.color, viewIndexOf(card.dataset.view));
    else if (card.classList.contains('variant-card')) openGallery(card.dataset.model, card.dataset.color);
    else openGallery(card.dataset.model);
  });

  $('grid').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.table-row');
    if (row) { e.preventDefault(); row.click(); return; }
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    card.click();
  });

  $('clear-similar').addEventListener('click', exitSimilar);

  $('upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      await startSimilar({ url, model: '参考图片', color: file.name, view: '原图' });
    } finally {
      URL.revokeObjectURL(url);
    }
    $('upload').value = '';
  });

  $('mode-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn || btn.dataset.mode === state.mode) return;
    if (btn.dataset.mode === 'internal') requestInternalMode();
    else activatePublicMode();
  });

  $('internal-logout').addEventListener('click', logoutInternal);

  // 客户界面语言切换（中文 / English / 双语）
  document.querySelectorAll('.lang-btn').forEach((b) =>
    b.addEventListener('click', () => setLang(b.dataset.lang)));
  $('mobile-lang').addEventListener('click', cycleLang);

  // 移动端：悬浮工具栏（搜索已在顶部绑定）与筛选底部抽屉
  $('mobile-filter-btn').addEventListener('click', toggleFiltersDrawer);
  $('drawer-close').addEventListener('click', closeFiltersDrawer);
  $('drawer-backdrop').addEventListener('click', closeFiltersDrawer);
  $('drawer-apply').addEventListener('click', closeFiltersDrawer);
  $('drawer-clear').addEventListener('click', () => { resetFilters(); closeFiltersDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeFiltersDrawer();
  });

  $('internal-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('internal-password').value;
    const errorEl = $('internal-login-error');
    errorEl.classList.add('hidden');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = '登录中…';
    try {
      await submitInternalLogin(password);
      $('internal-login-dialog').close();
      await activateInternalMode();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      $('internal-password').select();
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  $('internal-login-cancel').addEventListener('click', () => $('internal-login-dialog').close());
  $('internal-login-dialog').addEventListener('click', (e) => {
    if (e.target === $('internal-login-dialog')) $('internal-login-dialog').close();
  });

  $('gallery-dialog').addEventListener('close', () => { gallery.model = null; });
}

function viewIndexOf(view) {
  const idx = state.viewOrder.indexOf(view);
  return idx >= 0 ? idx : 0;
}

/* ---------- 初始化 ---------- */
async function init() {
  const savedLang = localStorage.getItem('langPref');
  if (LANG_MODES.includes(savedLang)) state.lang = savedLang;
  healthState = 'connecting';
  updateHealth();
  const response = await fetch('/api/catalog');
  if (!response.ok) throw new Error('目录加载失败');
  publicCatalog = await response.json();
  state.catalog = publicCatalog;
  buildIndexes();
  healthState = 'online';
  $('count').textContent = `${state.catalog.products.length} ${t('units.products')} · ${state.catalog.images.length} ${t('units.images')}`;
  renderFilterPanel();
  bindEvents();
  if (window.matchMedia('(max-width:760px)').matches) setFiltersHidden(true);
  applyLanguage(); // 绘制全部静态/动态客户文案（含语言、健康状态、计数、筛选、网格）
  await restoreInternalSession(); // 刷新时探测会话；上次处于内部模式则自动恢复
}

init().catch((error) => {
  healthState = 'failed';
  updateHealth();
  $('grid').textContent = error.message;
  $('empty-state').classList.remove('hidden');
  $('empty-state').innerHTML = `<p>${esc(error.message)}</p>`;
});
