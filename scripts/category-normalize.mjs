// 分类归一（Category Normalization）
//
// 把数据源里的原始分类（含空值）归一到「规范分类」，供内部目录 / 公开目录 / 筛选 / 翻译词汇表统一使用。
// - 规范分类 canonical `category`：所有下游（公开目录、筛选、翻译 en.category 回退）只认这个值。
// - 内部目录额外保留三件套，公开目录一律不携带：
//     categoryRaw    —— 数据源原始分类（空分类为 ''）
//     categoryStatus —— approved（用户批准的安全规则 / 保留）/ auto（高置信自动归类）/ pending（待人工确认）/ admin（管理端覆盖）
//     categoryReason —— 归类原因 / 证据说明
// - 空分类先按「同系列基型」推导，再按关键词高置信自动归类；仍无法高置信归类的标为
//   category='待确认'、categoryStatus='pending'，并输出证据到 data/category-review.json 供人工复核。

// 规范分类集合（公开目录 / 筛选 / 翻译词汇表都以此为准）。
// 更新规则时务必同步维护本集合，避免校验与筛选出现未知分类。
export const CANONICAL_CATEGORIES = new Set([
  '双肩背包',
  '腰包/腿包',
  '挎包/手提包',
  '配件',
  '附件包',
  '水袋包',
  '水壶包',
  '胸包/挎包',
  '战术背心',
  '战术背心 组合套装',
  '狗背心',
  '手套',
  '户外用品',
  '上衣',
  '裤子',
  '套服',
  '帽',
  '防弹头盔',
  '钓鱼包/枪包',
  '护具',
  '待确认',
]);

// 用户批准的安全规则：原始分类 -> 规范分类（未列出的原始分类原样保留）。
//  双肩包→双肩背包
//  腰包/挎包 + 腿包/腰包 → 腰包/腿包
//  挎包 / 手提包 / 挎包/手提包 → 挎包/手提包（外加品名显式含 单肩/斜挎）
//  其他配件→配件；枪套/弹夹带/腰带/背带/枪绳/扣具→配件
//  医疗/急救→附件包（另按品名/描述关键词命中）
//  保留 水袋包/水壶包 及各背心/服装/装备分类
const RAW_CATEGORY_MAP = new Map(Object.entries({
  '双肩包': '双肩背包',
  '双肩背包': '双肩背包',
  '腰包/挎包': '腰包/腿包',
  '腿包/腰包': '腰包/腿包',
  '挎包': '挎包/手提包',
  '手提包': '挎包/手提包',
  '挎包/手提包': '挎包/手提包',
  '其他配件': '配件',
  '配件': '配件',
  '腰带': '配件',
  '背带': '配件',
  '腰带/背带': '配件',
  '枪套': '配件',
  '弹夹带': '配件',
  '枪绳': '配件',
  '扣具': '配件',
  '附件包': '附件包',
  '水袋包': '水袋包',
  '水壶包': '水壶包',
  '胸包/挎包': '胸包/挎包',
  '战术背心': '战术背心',
  '战术背心 组合套装': '战术背心 组合套装',
  '狗背心': '狗背心',
  '手套': '手套',
  '户外用品': '户外用品',
  '上衣': '上衣',
  '裤子': '裤子',
  '套服': '套服',
  '帽': '帽',
  '防弹头盔': '防弹头盔',
  '钓鱼包/枪包': '钓鱼包/枪包',
  '护具': '护具',
}));

const MEDICAL_RE = /医疗|急救|医护/;
const SINGLE_CROSS_RE = /单肩|斜挎/;

// 空分类自动归类关键词规则（按序匹配，命中即视为高置信；usesDesc 表示同时参考品名与描述）。
const AUTO_RULES = [
  { re: /枪套|弹夹带|枪绳|扣具|腰带|背带|肩带/, category: '配件', note: '品名含配件关键词（枪套/弹夹带/腰带/背带/枪绳/扣具/肩带）' },
  { re: /水袋/, category: '水袋包', note: '品名含“水袋”' },
  { re: /水壶|水杯|杯套/, category: '水壶包', note: '品名含“水壶/水杯/杯套”' },
  { re: /双肩|背包|登山包|背囊|激光包|MOLLE包/, category: '双肩背包', note: '品名含背包关键词（双肩/背包/登山包/背囊/激光包/MOLLE包）' },
  { re: /胸包/, category: '胸包/挎包', note: '品名含“胸包”' },
  { re: /腰包/, category: '腰包/腿包', note: '品名含“腰包”' },
  { re: /单肩|斜挎|挎包|手提|公文包|商务/, category: '挎包/手提包', note: '品名/描述含“单肩/斜挎/挎包/手提/公文包”等', usesDesc: true },
  { re: /套服/, category: '套服', note: '品名含“套服”' },
  { re: /帽/, category: '帽', note: '品名含“帽”' },
  { re: /钓鱼|枪包/, category: '钓鱼包/枪包', note: '品名含“钓鱼/枪包”' },
  { re: /手套/, category: '手套', note: '品名含“手套”' },
];

// 品名/描述拼接：供医疗与单肩/斜挎规则参考
function descriptionOf(src) {
  const selling = Array.isArray(src.sellingPointsRaw) ? src.sellingPointsRaw : (typeof src.sellingPointsRaw === 'string' ? [src.sellingPointsRaw] : []);
  return [src.name, src.materials, src.capacity, src.dimensions, ...selling, src.notes]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');
}

// 同系列基型推导：空分类型号若与某个已知规范分类的型号共享基型（如 BL008C 是 BL008 的 C 款、
// HY8280-2 是 HY8280 的 2 款、BL008-带织唛 是 BL008 的带织唛款），则继承其规范分类。
function baseModelOf(model, knownModels) {
  if (!model) return null;
  const candidates = [...knownModels.entries()]
    .filter(([m]) => m !== model && typeof m === 'string' && model.startsWith(m))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [base, canonical] of candidates) {
    const rest = model.slice(base.length);
    if (/^[C0-9-]/.test(rest) || /^(小款|大款|带织唛)/.test(rest)) return { model: base, canonical };
  }
  return null;
}

// 归一单个产品分类；knownModels 为 { model -> 规范分类 } 映射（仅用于空分类的同系列基型推导）。
// 返回 { category, categoryRaw, categoryStatus, categoryReason, candidates? }
export function normalizeCategory(src, { knownModels = new Map() } = {}) {
  const raw = typeof src.category === 'string' && src.category.trim() ? src.category.trim() : '';
  const name = typeof src.name === 'string' ? src.name : '';
  const desc = descriptionOf(src);

  // 1) 医疗/急救/医护 -> 附件包（品名/分类命中即归类；描述提及医疗用途（如背心挂载医疗包）不算）
  if (MEDICAL_RE.test(name) || MEDICAL_RE.test(raw)) {
    return { category: '附件包', categoryRaw: raw, categoryStatus: 'approved', categoryReason: '规则：医疗/急救→附件包' };
  }
  // 2) 品名显式含 单肩/斜挎 -> 挎包/手提包（显式规则）
  if (SINGLE_CROSS_RE.test(name)) {
    return { category: '挎包/手提包', categoryRaw: raw, categoryStatus: 'approved', categoryReason: '规则：品名显式含“单肩/斜挎”→挎包/手提包' };
  }
  // 3) 有原始分类：按用户批准规则归一；未列出的分类原样保留
  if (raw) {
    const canonical = RAW_CATEGORY_MAP.get(raw);
    if (canonical) {
      const reason = canonical === raw ? `分类归一：${raw}（保留）` : `分类归一：${raw}→${canonical}`;
      return { category: canonical, categoryRaw: raw, categoryStatus: 'approved', categoryReason: reason };
    }
    return { category: raw, categoryRaw: raw, categoryStatus: 'approved', categoryReason: `分类保留：${raw}（未在归一规则中）` };
  }
  // 4) 空分类：同系列基型推导
  const base = baseModelOf(src.model, knownModels);
  if (base) {
    return { category: base.canonical, categoryRaw: raw, categoryStatus: 'auto', categoryReason: `自动归类：同系列基型 ${base.model}（${base.canonical}）` };
  }
  // 5) 空分类：按关键词高置信自动归类（品名优先，个别规则参考描述）
  for (const rule of AUTO_RULES) {
    if (rule.re.test(name) || (rule.usesDesc && rule.re.test(desc))) {
      return { category: rule.category, categoryRaw: raw, categoryStatus: 'auto', categoryReason: `自动归类：${rule.note}` };
    }
  }
  // 6) 无法高置信归类：待人工确认（候选分类供复核参考）
  const candidates = [];
  if (/化妆/.test(name)) candidates.push('挎包/手提包', '附件包');
  if (/袜/.test(name)) candidates.push('配件', '帽');
  if (/背心/.test(name)) candidates.push('战术背心', '上衣');
  return {
    category: '待确认',
    categoryRaw: raw,
    categoryStatus: 'pending',
    categoryReason: '待人工确认：品名/描述无法高置信归类，见 data/category-review.json',
    candidates,
  };
}
