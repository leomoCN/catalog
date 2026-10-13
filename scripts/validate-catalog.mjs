import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegSize } from './jpeg-size.mjs';
import { CANONICAL_CATEGORIES } from './category-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageDir = path.join(root, 'data', 'images');
const catalog = JSON.parse(await readFile(path.join(root, 'data', 'catalog.json'), 'utf8'));
const publicCatalog = JSON.parse(await readFile(path.join(root, 'data', 'catalog.public.json'), 'utf8'));
const source = JSON.parse(await readFile(path.join(root, 'data', 'product-catalog-source.json'), 'utf8'));
const specs = JSON.parse(await readFile(path.join(root, 'data', 'product-specs.json'), 'utf8'));
// 客户展示翻译模型（hand-curated）：词汇表 + 产品级翻译；校验其结构与引用合法性
let translations = { schemaVersion: 1, vocab: { views: {}, categories: {}, brands: {}, colors: {} }, products: {} };
try {
  translations = JSON.parse(await readFile(path.join(root, 'data', 'translations.json'), 'utf8'));
} catch {
  errors.push('translations.json 缺失或不是合法 JSON（客户模式将安全回落到中文原文）');
}
const files = (await readdir(imageDir)).filter((name) => /\.jpe?g$/i.test(name));
const errors = [];

// ---------- 图片完整性 ----------
// 不设固定图片总数：管理端可新增/删除槽位，允许部分完整（0/4–4/4）
if (catalog.images.length !== files.length) errors.push('目录图片数量与文件数量不一致');
const catalogFiles = new Set(catalog.images.map((image) => image.file));
const seenImageIds = new Set();
for (const image of catalog.images) {
  if (seenImageIds.has(image.id)) errors.push(`重复图片 id: ${image.id}`);
  seenImageIds.add(image.id);
  if (!files.includes(image.file)) errors.push(`目录图片文件缺失: ${image.file}`);
  const product = catalog.products.find((item) => item.model === image.model);
  if (!product) { errors.push(`图片 ${image.file} 的型号 ${image.model} 不在目录中`); continue; }
  if (!product.colors.includes(image.color)) errors.push(`图片 ${image.file} 的颜色不在 ${image.model} 的颜色列表中`);
}
for (const file of files) {
  if (!catalogFiles.has(file)) errors.push(`图片未进入目录: ${file}`);
  const size = jpegSize(await readFile(path.join(imageDir, file)));
  if (!size || size.width !== 1200 || size.height !== 1500) errors.push(`图片尺寸错误: ${file} (${size ? `${size.width}x${size.height}` : '不是有效 JPEG'})`);
}

// ---------- 内部目录 ----------
const modelSet = new Set();
if (catalog.products.length !== source.length) errors.push(`内部目录产品数 ${catalog.products.length} 与数据源 ${source.length} 不一致`);
for (const product of catalog.products) {
  if (modelSet.has(product.model)) errors.push(`重复型号: ${product.model}`);
  modelSet.add(product.model);
  if (!product.model) errors.push('产品缺少型号');
  if (!product.name) errors.push(`型号 ${product.model} 缺少品名`);
  const variantColors = new Set(product.variants.map((v) => v.color));
  for (const color of product.colors) {
    if (!variantColors.has(color)) errors.push(`${product.model} 颜色 ${color} 没有对应变体`);
  }
  for (const variant of product.variants) {
    if (!product.colors.includes(variant.color)) errors.push(`${product.model} 变体颜色 ${variant.color} 不在颜色列表中`);
    for (const view of Object.keys(variant.views)) {
      if (!['正面', '45度', '侧面', '背面'].includes(view)) errors.push(`${product.model}/${variant.color} 包含未知视角 ${view}`);
    }
  }
}

// 图片型号允许部分完整（0/4–4/4）：已有视角必须指向真实图片文件，缺失视角可以为空
for (const model of Object.keys(specs)) {
  const product = catalog.products.find((item) => item.model === model);
  if (!product) { errors.push(`图片型号 ${model} 未在目录中`); continue; }
  for (const variant of product.variants) {
    for (const view of Object.keys(variant.views)) {
      if (!['正面', '45度', '侧面', '背面'].includes(view)) errors.push(`${model}/${variant.color} 包含未知视角 ${view}`);
      const image = variant.views[view];
      if (!image || !catalogFiles.has(image.file)) errors.push(`${model}/${variant.color}/${view} 未指向真实图片`);
    }
  }
}

// ---------- 管理端新增槽位注册表（admin-store images）：注册的槽位必须真实存在于目录与文件中 ----------
let adminStoreData = { products: {} };
try {
  adminStoreData = JSON.parse(await readFile(path.join(root, 'data', 'admin-store.json'), 'utf8'));
} catch { /* 尚无管理存储文件 */ }
for (const [model, entry] of Object.entries(adminStoreData.products || {})) {
  for (const mi of (Array.isArray(entry.images) ? entry.images : [])) {
    if (!catalog.images.some((image) => image.file === mi.file && image.model === model && image.color === mi.color && image.view === mi.view)) {
      errors.push(`管理端 ${model} 注册图片 ${mi.file}（${mi.color}/${mi.view}）未在目录中`);
    }
  }
}

// ---------- display 审核状态（合法状态 + 审核原因；状态可由 admin-store 覆盖） ----------
const DISPLAY_STATUSES = new Set(['public', 'internal', 'pending', 'hidden']);
let publicStatusCount = 0;
for (const product of catalog.products) {
  if (!DISPLAY_STATUSES.has(product.displayStatus)) {
    errors.push(`型号 ${product.model} displayStatus 非法: ${product.displayStatus ?? '(缺失)'}`);
    continue;
  }
  if (typeof product.displayReason !== 'string' || !product.displayReason.trim()) {
    errors.push(`型号 ${product.model} 缺少 displayReason（审核原因）`);
  }
  if (product.displayStatus === 'public') publicStatusCount++;
}

// 没有图片的型号不得携带任何视图数据（禁止伪造图片）
const imageModels = new Set(catalog.images.map((image) => image.model));
for (const product of catalog.products) {
  if (imageModels.has(product.model)) continue;
  for (const variant of product.variants) {
    if (Object.keys(variant.views).length) errors.push(`${product.model}/${variant.color} 存在无源图片的视图数据`);
  }
}

// ---------- 分类归一：内部目录保留 categoryRaw/categoryStatus/categoryReason，category 为规范分类 ----------
const CATEGORY_STATUSES = new Set(['approved', 'auto', 'pending', 'admin']);
const LEGACY_RAW_CATEGORIES = ['双肩包', '腰包/挎包', '腿包/腰包', '挎包', '手提包', '其他配件', '腰带', '背带', '腰带/背带', '枪套', '弹夹带', '枪绳', '扣具'];
let pendingCategoryCount = 0;
for (const product of catalog.products) {
  if (typeof product.category !== 'string' || !product.category.trim()) {
    errors.push(`型号 ${product.model} 缺少规范分类 category`);
    continue;
  }
  if (typeof product.categoryRaw !== 'string') errors.push(`型号 ${product.model} 缺少 categoryRaw（原始分类）`);
  if (!CATEGORY_STATUSES.has(product.categoryStatus)) {
    errors.push(`型号 ${product.model} categoryStatus 非法: ${product.categoryStatus ?? '(缺失)'}`);
  }
  if (typeof product.categoryReason !== 'string' || !product.categoryReason.trim()) {
    errors.push(`型号 ${product.model} 缺少 categoryReason（分类原因）`);
  }
  if (product.categoryStatus === 'pending' && product.category !== '待确认') {
    errors.push(`型号 ${product.model} categoryStatus=pending 但分类不是待确认: ${product.category}`);
  }
  if (product.categoryStatus !== 'pending' && !CANONICAL_CATEGORIES.has(product.category)) {
    errors.push(`型号 ${product.model} 分类不在规范分类集合: ${product.category}`);
  }
  if (LEGACY_RAW_CATEGORIES.includes(product.category)) {
    errors.push(`型号 ${product.model} 分类仍为未归一的原始值: ${product.category}`);
  }
  if (product.categoryStatus === 'pending') pendingCategoryCount++;
}

// 待确认分类必须出现在 data/category-review.json（evidence/source/row），且已归类的不得残留
let categoryReviewData = { pending: [] };
try {
  categoryReviewData = JSON.parse(await readFile(path.join(root, 'data', 'category-review.json'), 'utf8'));
} catch {
  errors.push('category-review.json 缺失或不是合法 JSON');
}
const reviewModels = new Set(Array.isArray(categoryReviewData.pending) ? categoryReviewData.pending.map((r) => r && r.model) : []);
for (const product of catalog.products) {
  if (product.categoryStatus === 'pending' && !reviewModels.has(product.model)) {
    errors.push(`型号 ${product.model} 待确认但未列入 category-review.json`);
  }
  if (product.categoryStatus !== 'pending' && reviewModels.has(product.model)) {
    errors.push(`型号 ${product.model} 已归类但仍残留在 category-review.json`);
  }
}
for (const review of (Array.isArray(categoryReviewData.pending) ? categoryReviewData.pending : [])) {
  if (!review || typeof review.model !== 'string' || !review.model) { errors.push('category-review.json 存在缺型号的待确认条目'); continue; }
  if (typeof review.source !== 'string' || !review.source) errors.push(`待确认 ${review.model} 缺少 source`);
  if (typeof review.evidence !== 'string' || !review.evidence.trim()) errors.push(`待确认 ${review.model} 缺少 evidence（证据说明）`);
  if (typeof review.row !== 'number' || review.row < 1) errors.push(`待确认 ${review.model} 缺少 row（数据源行号）`);
}

// ---------- 公开目录（只含 displayStatus=public 的产品，剥离全部审批/内部字段） ----------
const PUBLIC_FORBIDDEN = ['wholesalePrice', 'retailPrice', 'onlinePrice', 'notes', 'cartonSize', 'cartonQty', 'cartonWeight', 'moq', 'size', 'sizeChart', 'spec', 'source', 'row', 'returnDate', 'displayStatus', 'displayReason', 'categoryRaw', 'categoryStatus', 'categoryReason'];
const internalPublicModels = new Set(catalog.products.filter((p) => p.displayStatus === 'public').map((p) => p.model));
if (publicCatalog.products.length !== publicStatusCount) errors.push(`公开目录产品数 ${publicCatalog.products.length} 与内部 public 产品数 ${publicStatusCount} 不一致`);
const publicModels = new Set();
for (const product of publicCatalog.products) {
  if (publicModels.has(product.model)) errors.push(`公开目录重复型号: ${product.model}`);
  publicModels.add(product.model);
  if (!internalPublicModels.has(product.model)) errors.push(`公开目录包含非 public 状态的型号: ${product.model}`);
  for (const key of Object.keys(product)) {
    if (PUBLIC_FORBIDDEN.includes(key)) errors.push(`公开目录 ${product.model} 包含内部字段: ${key}`);
  }
  if (!product.name) errors.push(`公开目录型号 ${product.model} 缺少品名`);
  if (typeof product.category !== 'string' || !product.category.trim()) errors.push(`公开目录型号 ${product.model} 缺少分类`);
  if (!CANONICAL_CATEGORIES.has(product.category)) errors.push(`公开目录 ${product.model} 分类不是规范分类: ${product.category}`);
  if (!Array.isArray(product.colors)) errors.push(`公开目录型号 ${product.model} 缺少颜色列表`);
  if (!Array.isArray(product.variants)) errors.push(`公开目录型号 ${product.model} 缺少变体列表`);
}
// 内部 public 型号必须全部进入公开目录（一一对应）
for (const model of internalPublicModels) {
  if (!publicModels.has(model)) errors.push(`内部 public 型号 ${model} 未进入公开目录`);
}
// 公开目录图片：只能来自 public 型号
const publicInternalImageCount = catalog.images.filter((image) => internalPublicModels.has(image.model)).length;
if (publicCatalog.images.length !== publicInternalImageCount) errors.push(`公开目录图片数 ${publicCatalog.images.length} 与内部 public 型号图片数 ${publicInternalImageCount} 不一致`);
for (const image of publicCatalog.images) {
  if (!internalPublicModels.has(image.model)) errors.push(`公开目录包含非 public 型号的图片: ${image.file}`);
}

// ---------- 客户展示翻译模型（translations.json）与公开目录已批准英文字段 ----------
const TR_STRING_KEYS = ['name', 'category', 'brand', 'materials', 'dimensions', 'capacity', 'weight'];
const TR_ALLOWED_KEYS = new Set([...TR_STRING_KEYS, 'sellingPoints', 'colors']);
const EN_FORBIDDEN = new Set(['wholesalePrice', 'retailPrice', 'onlinePrice', 'notes', 'cartonSize', 'cartonQty', 'cartonWeight', 'moq', 'size', 'sizeChart', 'spec', 'source', 'row', 'returnDate', 'displayStatus', 'displayReason', 'categoryRaw', 'categoryStatus', 'categoryReason']);

if (translations && translations.products && typeof translations.products === 'object') {
  for (const [model, tr] of Object.entries(translations.products)) {
    if (!tr || typeof tr !== 'object' || Array.isArray(tr)) { errors.push(`翻译模型 ${model} 非法：必须是对象`); continue; }
    const internalProduct = catalog.products.find((p) => p.model === model);
    if (!internalProduct) { errors.push(`翻译模型引用了不存在的型号: ${model}`); continue; }
    for (const key of Object.keys(tr)) {
      if (!TR_ALLOWED_KEYS.has(key)) { errors.push(`翻译模型 ${model} 含不支持的字段: ${key}`); continue; }
      if (TR_STRING_KEYS.includes(key)) {
        if (typeof tr[key] !== 'string' || !tr[key].trim()) errors.push(`翻译模型 ${model}.${key} 必须是非空字符串`);
      } else if (key === 'sellingPoints') {
        if (!Array.isArray(tr[key]) || !tr[key].every((s) => typeof s === 'string' && s.trim())) errors.push(`翻译模型 ${model}.sellingPoints 必须是非空字符串数组`);
      } else if (key === 'colors') {
        if (!tr[key] || typeof tr[key] !== 'object' || Array.isArray(tr[key])) { errors.push(`翻译模型 ${model}.colors 必须是对象`); continue; }
        for (const [color, val] of Object.entries(tr[key])) {
          if (!internalProduct.colors.includes(color)) errors.push(`翻译模型 ${model}.colors 的颜色不在型号颜色列表中: ${color}`);
          if (typeof val !== 'string' || !val.trim()) errors.push(`翻译模型 ${model}.colors.${color} 必须是非空字符串`);
        }
      }
    }
  }
}

for (const product of publicCatalog.products) {
  const en = product.en;
  if (!en) continue; // 无英文翻译的公开产品安全回落到中文原文
  if (!en || typeof en !== 'object' || Array.isArray(en)) { errors.push(`公开目录 ${product.model}.en 非法`); continue; }
  for (const key of Object.keys(en)) {
    if (!TR_ALLOWED_KEYS.has(key)) errors.push(`公开目录 ${product.model}.en 含不支持的字段: ${key}`);
    if (EN_FORBIDDEN.has(key)) errors.push(`公开目录 ${product.model}.en 包含内部字段: ${key}`);
    if (TR_STRING_KEYS.includes(key)) {
      if (typeof en[key] !== 'string' || !en[key].trim()) errors.push(`公开目录 ${product.model}.en.${key} 必须是非空字符串`);
    } else if (key === 'sellingPoints') {
      if (!Array.isArray(en[key]) || !en[key].every((s) => typeof s === 'string' && s.trim())) errors.push(`公开目录 ${product.model}.en.sellingPoints 必须是非空字符串数组`);
    } else if (key === 'colors') {
      if (!en[key] || typeof en[key] !== 'object' || Array.isArray(en[key])) errors.push(`公开目录 ${product.model}.en.colors 必须是对象`);
      else {
        for (const [color, val] of Object.entries(en[key])) {
          if (!product.colors.includes(color)) errors.push(`公开目录 ${product.model}.en.colors 的颜色不在型号颜色列表中: ${color}`);
          if (typeof val !== 'string' || !val.trim()) errors.push(`公开目录 ${product.model}.en.colors.${color} 必须是非空字符串`);
        }
      }
    }
  }
  if (Object.keys(en).length === 0) errors.push(`公开目录 ${product.model}.en 为空对象`);
}
// 内部目录保持中文：内部/管理界面固定中文，不允许携带英文字段
for (const product of catalog.products) {
  if (Object.prototype.hasOwnProperty.call(product, 'en')) errors.push(`内部目录 ${product.model} 不应包含英文字段 en（内部/管理界面固定中文）`);
}

// 覆盖统计：公开产品英文翻译覆盖率（完整 = 展示字段全部有英文；部分 = 至少一个字段有英文；无 = 回落到中文）
const FULL_TR_FIELDS = ['name', 'materials', 'dimensions', 'capacity', 'weight'];
let fullTrCount = 0;
let partialTrCount = 0;
let noneTrCount = 0;
for (const product of publicCatalog.products) {
  const en = product.en || {};
  const hasAny = Object.keys(en).length > 0;
  const hasFull = FULL_TR_FIELDS.every((k) => typeof en[k] === 'string' && en[k].trim());
  if (hasFull) fullTrCount++;
  else if (hasAny) partialTrCount++;
  else noneTrCount++;
}

if (errors.length) {
  console.error(errors.map((error) => `✗ ${error}`).join('\n'));
  process.exit(1);
}

const variants = catalog.products.reduce((n, p) => n + p.variants.length, 0);
const imageVariants = catalog.products.reduce((n, p) => (imageModels.has(p.model) ? n + p.variants.length : n), 0);
const statusCounts = {};
for (const product of catalog.products) statusCounts[product.displayStatus] = (statusCounts[product.displayStatus] || 0) + 1;
const statusAudit = Object.entries(statusCounts).map(([s, c]) => `${s}=${c}`).join('，');
const categoryCounts = {};
for (const product of catalog.products) categoryCounts[product.category] = (categoryCounts[product.category] || 0) + 1;
const categoryStatusCounts = {};
for (const product of catalog.products) categoryStatusCounts[product.categoryStatus] = (categoryStatusCounts[product.categoryStatus] || 0) + 1;
console.log(`校验通过：${files.length} 张图片全部为 1200×1500，${catalog.products.length} 个产品（${variants} 个颜色组合，${imageVariants} 个拍照颜色组合，允许部分完整 0/4–4/4）；公开目录 ${publicCatalog.products.length} 款且不含批发/内部/物流/审核字段，无伪造图片。`);
console.log(`displayStatus 审计：${statusAudit}；公开目录仅含 public 产品。`);
console.log(`规范分类审计：${Object.entries(categoryCounts).map(([c, n]) => `${c}=${n}`).join('，')}`);
console.log(`分类状态审计：${Object.entries(categoryStatusCounts).map(([s, n]) => `${s}=${n}`).join('，')}；待人工确认 ${pendingCategoryCount} 款（data/category-review.json）。`);
console.log(`翻译覆盖（仅公开目录）：完整英文 ${fullTrCount} 款 / 部分英文 ${partialTrCount} 款 / 中文回落 ${noneTrCount} 款（内部目录与管理页固定中文）。`);
