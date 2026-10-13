import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write.mjs';
import { normalizeCategory } from './category-normalize.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageDir = path.join(root, 'data', 'images');

export async function buildCatalog() {
  // 全量目录数据源：由知识库《20-产品与技术/05-产品目录与报价》01-08 解析生成（见 README）
  const sourceProducts = JSON.parse(await readFile(path.join(root, 'data', 'product-catalog-source.json'), 'utf8'));
  // 已拍照产品资料：LP2136/LP2135/LP2145 三个型号的梳理数据，作为图片型号映射的权威来源
  const specs = JSON.parse(await readFile(path.join(root, 'data', 'product-specs.json'), 'utf8'));
  // 管理端覆盖存储：管理接口（PUT/POST）写入的字段与 displayStatus/displayReason 在此落盘，构建时以覆盖优先
  let adminStore = { schemaVersion: 1, products: {}, audit: [] };
  try {
    adminStore = JSON.parse(await readFile(path.join(root, 'data', 'admin-store.json'), 'utf8'));
  } catch {
    // 尚无管理存储文件，使用空覆盖
  }
  const adminOverrides = adminStore.products && typeof adminStore.products === 'object' ? adminStore.products : {};
  let adminOverrideCount = 0;

  // 客户展示翻译模型（data/translations.json）：hand-curated 词汇表（固定枚举字段）+ 产品级英文翻译。
  // 仅用于公开目录生成；内部目录（catalog.json）保持中文，管理/内部界面固定中文。
  let translations = { schemaVersion: 1, vocab: { views: {}, categories: {}, brands: {}, colors: {} }, products: {} };
  try {
    translations = JSON.parse(await readFile(path.join(root, 'data', 'translations.json'), 'utf8'));
  } catch {
    // 尚无翻译模型文件，视为无英文翻译（客户模式安全回落到中文原文）
  }
  const vocab = translations.vocab && typeof translations.vocab === 'object' ? translations.vocab : {};
  const translationProducts = translations.products && typeof translations.products === 'object' ? translations.products : {};

  // 为公开产品计算「已批准英文字段」en 块：优先产品级翻译，其次固定枚举词汇表；
  // 绝不机翻产品自由文本（品名/材质/尺寸/容量/重量/卖点），无翻译则回落到中文原文。
  function englishBlockFor(product) {
    const tr = translationProducts[product.model];
    const en = {};
    const put = (key, value) => { if (typeof value === 'string' && value.trim()) en[key] = value.trim(); };
    if (tr) {
      put('name', tr.name);
      put('category', tr.category);
      put('brand', tr.brand);
      put('materials', tr.materials);
      put('dimensions', tr.dimensions);
      put('capacity', tr.capacity);
      put('weight', tr.weight);
      if (Array.isArray(tr.sellingPoints) && tr.sellingPoints.length) {
        en.sellingPoints = tr.sellingPoints.map((s) => String(s).trim()).filter(Boolean);
        if (!en.sellingPoints.length) delete en.sellingPoints;
      }
      if (tr.colors && typeof tr.colors === 'object') {
        const map = {};
        for (const [zh, val] of Object.entries(tr.colors)) if (typeof val === 'string' && val.trim()) map[zh] = val.trim();
        if (Object.keys(map).length) en.colors = map;
      }
    }
    // 固定枚举词汇表（分类 / 品牌 / 颜色）：hand-curated，不视为机翻
    const catVocab = vocab.categories && vocab.categories[product.category];
    const brandVocab = vocab.brands && vocab.brands[product.brand];
    if (!en.category && catVocab) en.category = catVocab;
    if (!en.brand && brandVocab) en.brand = brandVocab;
    if (!en.colors) en.colors = {};
    for (const color of product.colors) {
      if (!en.colors[color] && vocab.colors && vocab.colors[color]) en.colors[color] = vocab.colors[color];
    }
    const colorKeys = Object.keys(en.colors);
    if (!colorKeys.length) delete en.colors;
    return Object.keys(en).length ? en : null;
  }

  const viewOrder = ['正面', '45度', '侧面', '背面'];
  const viewKeys = { '正面': 'front', '45度': 'angle45', '侧面': 'side', '背面': 'back' };

  // 展示审核状态：公开(public)/内部(internal)/待审核(pending)/隐藏(hidden)
  const DISPLAY_STATUSES = new Set(['public', 'internal', 'pending', 'hidden']);
  // 阶段一保守初始状态：LP2135/LP2136/LP2145 已有真实产品图 → pending，其余型号默认 internal
  //（阶段一之后可通过 admin-store.json 覆盖为任意合法状态）
  const PENDING_MODELS = new Set(['LP2135', 'LP2136', 'LP2145']);
  // 默认内部审核原因：按来源系列生成（数据源行或 admin-store 可声明 displayStatus/displayReason 覆盖）
  function defaultDisplayReason(src) {
    if (PENDING_MODELS.has(src.model)) {
      return `待审核：产品图片已拍摄（来源系列：${src.source}），审核通过后公开`;
    }
    return `来源系列：${src.source}（内部未公开，待审核后公开）`;
  }
  function initialDisplayStatus(src) {
    if (DISPLAY_STATUSES.has(src.displayStatus)) {
      return {
        displayStatus: src.displayStatus,
        displayReason: typeof src.displayReason === 'string' && src.displayReason ? src.displayReason : defaultDisplayReason(src),
      };
    }
    return {
      displayStatus: PENDING_MODELS.has(src.model) ? 'pending' : 'internal',
      displayReason: defaultDisplayReason(src),
    };
  }

  // 常见颜色 -> 稳定 colorKey（用于过滤与前端展示）
  const COLOR_KEYS = {
    '黑色': 'black', '黑': 'black', '黑色CP': 'black-cp', '黑CP': 'black-cp', 'CP色': 'cp', 'CP': 'cp',
    '卡其色': 'khaki', '卡其': 'khaki', '军绿': 'olive', '军绿色': 'olive', '绿色': 'green', '灰色': 'gray', '灰': 'gray',
    '红色': 'red', '蓝色': 'blue', '宝蓝': 'royal-blue', '宝蓝色': 'royal-blue', '紫色': 'purple', '白色': 'white',
    '黄色': 'yellow', '橙色': 'orange', '粉红': 'pink', '粉色': 'pink', '棕色': 'brown', '杏色': 'apricot',
    '藏青': 'navy', '藏青蓝': 'navy', '米白': 'cream', '草绿': 'grass-green', '草绿色': 'grass-green', '砖红': 'brick-red',
    '绿CP': 'green-cp', 'CP迷彩': 'cp-camo', '迷彩': 'camo', '迷彩色': 'camo', '多色': 'multi',
    '丛林': 'jungle', '丛数': 'jungle-digital', 'ACU': 'acu', '三沙': 'three-tone-sand', '沙数': 'sand-digital',
    '废墟绿': 'ruin-green', '俄罗斯迷彩': 'russian-camo', '蟒黑': 'python-black', '蟒纹黑色': 'python-black',
    '蟒纹卡其': 'python-khaki', '枫叶迷彩': 'maple-camo', '虎斑迷彩': 'tiger-camo', '星空绿': 'star-green',
  };
  const colorKeyMemo = new Map();
  function colorKey(color) {
    const exact = COLOR_KEYS[color];
    if (exact) return exact;
    if (colorKeyMemo.has(color)) return colorKeyMemo.get(color);
    const slug = color.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const key = slug || `color-${colorKeyMemo.size}`;
    colorKeyMemo.set(color, key);
    return key;
  }

  // 颜色文本 -> 数组（去掉数量、码数、尺码等非颜色信息，保留原样作参考字段 colorsRaw）
  function parseColors(raw) {
    if (!raw) return [];
    const seen = new Set();
    const colors = [];
    for (let token of String(raw).split(/[\n、,，/;；\s]+/)) {
      token = token.replace(/^□\s*/, '').replace(/^颜色[：:]\s*/, '').trim();
      token = token.replace(/\s*\d+\+?\s*$/g, '').trim(); // 去掉数量后缀，如“灰色 3000+”
      if (!token) continue;
      if (/^\d/.test(token)) continue; // 3L / 2.5L / 58-60 等
      if (/[号码]/.test(token)) continue; // M号 / L号 / 均码
      if (/cm|CM|尺寸|腰围|内胆|承重/.test(token)) continue;
      if (/^(M|L|XL|XXL|S)([-+].*)?$/.test(token)) continue; // 尺码
      if (!seen.has(token)) { seen.add(token); colors.push(token); }
    }
    return colors;
  }

  // 卖点文本 -> 数组（按换行与项目符号拆分）
  function parseSellingPoints(raw) {
    if (!raw) return [];
    const points = [];
    for (let line of String(raw).split(/[\n•▪●]/)) {
      line = line.replace(/^[#\d.\-、)\s]+/g, '').trim();
      if (line) points.push(line);
    }
    return points;
  }

  // 1) 解析图片文件：沿用既有命名规范（型号支持 LP/BL/HY 等「字母开头 + 数字」的型号；其余复杂型号
  //    由管理端注册表接管，见 1b）。无法解析的文件不中断构建（将交由校验阶段报告为孤立文件）。
  const FILE_MODEL_RE = /^([A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*)_([^_]+)_(正面|45度|侧面|背面)\.jpe?g$/i;
  const files = (await readdir(imageDir)).filter((name) => /\.jpe?g$/i.test(name)).sort();
  const imagesByFile = new Map();
  for (const file of files) {
    const match = file.match(FILE_MODEL_RE);
    if (!match) {
      console.warn(`跳过无法解析的图片文件名（如为管理端新增槽位，将以 admin-store 注册表为准）: ${file}`);
      continue;
    }
    const [, model, color, view] = match;
    if (!viewKeys[view]) { console.warn(`跳过未知视角的图片文件名: ${file}`); continue; }
    imagesByFile.set(file, {
      id: `${model}__${color}__${view}`,
      model,
      color,
      colorKey: colorKey(color),
      view,
      viewKey: viewKeys[view],
      file,
      url: `/api/image/${encodeURIComponent(file)}`
    });
  }

  // 1b) 管理端新增槽位：admin-store 注册表（images 数组），每个条目都对应 data/images 中的真实文件。
  //     同名文件以注册表条目为准（注册表由上传接口写入，保证 model/color/view 与文件一致）。
  for (const [model, override] of Object.entries(adminOverrides)) {
    const managed = Array.isArray(override.images) ? override.images : [];
    for (const mi of managed) {
      if (!mi || typeof mi.file !== 'string' || !/\.jpe?g$/i.test(mi.file) || typeof mi.color !== 'string' || typeof mi.view !== 'string' || !viewKeys[mi.view]) {
        throw new Error(`管理端 ${model} 存在非法图片注册条目: ${JSON.stringify(mi)}`);
      }
      await stat(path.join(imageDir, mi.file)).catch(() => {
        throw new Error(`管理端注册的图片文件不存在: ${mi.file}（型号 ${model}，颜色 ${mi.color}，视角 ${mi.view}）`);
      });
      imagesByFile.set(mi.file, {
        id: `${model}__${mi.color}__${mi.view}`,
        model,
        color: mi.color,
        colorKey: colorKey(mi.color),
        view: mi.view,
        viewKey: viewKeys[mi.view],
        file: mi.file,
        url: `/api/image/${encodeURIComponent(mi.file)}`,
        managed: true,
      });
    }
  }
  const images = [...imagesByFile.values()];

  const groups = new Map();
  for (const image of images) {
    const key = `${image.model}__${image.color}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(image);
  }

  // 2) 由全量数据源构建产品（图片型号用 product-specs.json 的梳理数据覆盖）
  // 分类归一：先为有原始分类的型号计算规范分类，供空分类型号的同系列基型推导复用
  const knownCanonicalMap = new Map();
  for (const src of sourceProducts) {
    if (typeof src.category === 'string' && src.category.trim()) {
      knownCanonicalMap.set(src.model, normalizeCategory(src, { knownModels: knownCanonicalMap }).category);
    }
  }
  const normInfoByModel = new Map();
  const products = sourceProducts.map((src, srcIndex) => {
    // 分类归一：category 为规范分类；categoryRaw/categoryStatus/categoryReason 仅内部目录保留
    const norm = normalizeCategory(src, { knownModels: knownCanonicalMap });
    normInfoByModel.set(src.model, { row: srcIndex + 1, candidates: norm.candidates || [] });
    const spec = specs[src.model];
    const override = adminOverrides[src.model];
    // 颜色 = 数据源/资料基础颜色 + 管理端新增颜色（admin-store colors 为增量覆盖，去重、保留顺序）
    const baseColors = spec ? [...spec.colors] : parseColors(src.colorsRaw);
    const addedColors = Array.isArray(override && override.colors) ? override.colors : [];
    const colors = [...baseColors];
    for (const color of addedColors) {
      if (typeof color === 'string' && color && !colors.includes(color)) colors.push(color);
    }
    const product = {
      model: src.model,
      name: spec ? spec.name : (src.name || src.category || src.model),
      category: norm.category,
      categoryRaw: norm.categoryRaw,
      categoryStatus: norm.categoryStatus,
      categoryReason: norm.categoryReason,
      brand: src.brand,
      materials: spec ? spec.materials : src.materials,
      dimensions: spec ? spec.dimensions : src.dimensions,
      capacity: spec ? spec.capacity : src.capacity,
      weight: spec ? spec.weight : src.weight,
      sellingPoints: spec ? [...spec.sellingPoints] : parseSellingPoints(src.sellingPointsRaw),
      colors,
    };
    if (spec) {
      // 图片型号：保留既有梳理字段（含内部价格/物流字段）
      product.cartonSize = spec.cartonSize;
      product.cartonQty = spec.cartonQty;
      product.wholesalePrice = spec.wholesalePrice;
      product.retailPrice = spec.retailPrice;
      product.notes = spec.notes ?? '';
    } else {
      // 其余型号：来自知识库的原始字段（内部目录保留全部，公开目录再剥离）
      for (const [key, value] of [
        ['cartonSize', src.cartonSize], ['cartonQty', src.cartonQty], ['cartonWeight', src.cartonWeight],
        ['wholesalePrice', src.wholesalePrice], ['retailPrice', src.retailPrice], ['onlinePrice', src.onlinePrice],
        ['moq', src.moq], ['notes', src.notes], ['size', src.size], ['sizeChart', src.sizeChart],
        ['launchDate', src.launchDate], ['returnDate', src.returnDate], ['spec', src.spec],
      ]) {
        if (value !== undefined && value !== '') product[key] = value;
      }
    }
    product.source = src.source;
    product.row = src.row;
    const status = initialDisplayStatus(src);
    product.displayStatus = status.displayStatus;
    product.displayReason = status.displayReason;

    // 3) 合并管理端覆盖：admin-store.json 中的字段覆盖与 displayStatus/displayReason 以管理端为准
    if (override) {
      adminOverrideCount++;
      const fields = override.fields && typeof override.fields === 'object' ? override.fields : {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null) product[key] = value;
      }
      if (DISPLAY_STATUSES.has(override.displayStatus)) {
        product.displayStatus = override.displayStatus;
        if (typeof override.displayReason === 'string' && override.displayReason) {
          product.displayReason = override.displayReason;
        }
      }
      // 管理端覆盖分类：仍以管理端值为准，但标注来源（便于复核与校验）
      if (typeof override.fields.category === 'string' && override.fields.category.trim()) {
        product.categoryStatus = 'admin';
        product.categoryReason = '管理端覆盖分类';
      }
    }

    product.variants = colors.map((color) => {
      const variantImages = groups.get(`${product.model}__${color}`) || [];
      const views = {};
      for (const view of viewOrder) {
        const image = variantImages.find((item) => item.view === view);
        if (image) views[view] = image;
      }
      const missingViews = viewOrder.filter((view) => !views[view]);
      return { color, colorKey: colorKey(color), complete: missingViews.length === 0, missingViews, views };
    });
    return product;
  });

  // 4) 允许部分完整度（0/4–4/4）：不再强制图片型号四视角齐备；仅保证拍照型号都存在于目录数据中
  for (const model of Object.keys(specs)) {
    const product = products.find((item) => item.model === model);
    if (!product) throw new Error(`图片型号 ${model} 不在目录数据中`);
  }

  const generatedAt = new Date().toISOString();
  const imageStandard = { width: 1200, height: 1500, ratio: '4:5' };

  // 5) 公开目录：只含 displayStatus=public 的产品，并剥离批发/零售价、内部备注、箱规装箱、审核状态（displayStatus/displayReason）等内部字段
  const PUBLIC_KEYS = new Set(['model', 'name', 'category', 'brand', 'materials', 'dimensions', 'capacity', 'weight', 'sellingPoints', 'colors', 'variants', 'launchDate']);
  const publicProducts = products.filter((product) => product.displayStatus === 'public').map((product) => {
    const out = {};
    for (const key of Object.keys(product)) {
      if (PUBLIC_KEYS.has(key) && product[key] !== undefined) out[key] = product[key];
    }
    // 已批准英文字段（仅公开目录携带；内部目录/管理/内部界面保持中文）
    const en = englishBlockFor(product);
    if (en) out.en = en;
    return out;
  });
  const publicModels = new Set(publicProducts.map((product) => product.model));

  const catalog = { generatedAt, imageStandard, viewOrder, products, images };
  const publicCatalog = { generatedAt, imageStandard, viewOrder, viewLabels: vocab.views || {}, products: publicProducts, images: images.filter((image) => publicModels.has(image.model)) };

  await writeJsonAtomic(path.join(root, 'data', 'catalog.json'), catalog);
  await writeJsonAtomic(path.join(root, 'data', 'catalog.public.json'), publicCatalog);

  // 待人工确认分类清单：写 data/category-review.json（evidence/source/row），供下一步人工复核
  const pendingReviews = [];
  for (const product of products) {
    if (product.categoryStatus === 'pending') {
      const info = normInfoByModel.get(product.model) || {};
      pendingReviews.push({
        model: product.model,
        name: product.name || '',
        source: product.source || '',
        row: info.row ?? null,
        category: product.category,
        evidence: product.categoryReason || '',
        candidates: info.candidates || [],
      });
    }
  }
  await writeJsonAtomic(path.join(root, 'data', 'category-review.json'), {
    schemaVersion: 1,
    generatedAt,
    count: pendingReviews.length,
    pending: pendingReviews,
  });

  const variants = products.reduce((n, p) => n + p.variants.length, 0);
  const incompleteVariants = products.reduce((n, p) => n + p.variants.filter((v) => !v.complete).length, 0);
  const bySource = {};
  for (const product of products) bySource[product.source] = (bySource[product.source] || 0) + 1;
  const byStatus = {};
  for (const product of products) byStatus[product.displayStatus] = (byStatus[product.displayStatus] || 0) + 1;
  const byCategory = {};
  for (const product of products) byCategory[product.category] = (byCategory[product.category] || 0) + 1;
  const byCategoryStatus = {};
  for (const product of products) byCategoryStatus[product.categoryStatus] = (byCategoryStatus[product.categoryStatus] || 0) + 1;
  console.log(`已生成目录：${images.length} 张图片，${products.length} 个产品，${variants} 个颜色组合（允许部分完整 0/4–4/4，当前 ${incompleteVariants} 个未四视角齐全）`);
  for (const [source, count] of Object.entries(bySource)) console.log(`  ${source}: ${count} 款`);
  for (const [status, count] of Object.entries(byStatus)) console.log(`  displayStatus=${status}: ${count} 款`);
  console.log(`规范分类：${Object.entries(byCategory).map(([c, n]) => `${c}=${n}`).join('，')}`);
  console.log(`分类状态：${Object.entries(byCategoryStatus).map(([s, n]) => `${s}=${n}`).join('，')}；待确认 ${pendingReviews.length} 款已写入 data/category-review.json`);
  console.log(`公开目录：${publicProducts.length} 款产品（仅 displayStatus=public，不含批发/内部/物流/审核字段，分类为规范分类）`);
  if (adminOverrideCount) console.log(`管理端覆盖：${adminOverrideCount} 个型号使用 admin-store.json 覆盖`);

  return { generatedAt, images, products, publicProducts, variants, bySource, byStatus };
}

const isMain =
  (typeof import.meta !== 'undefined' && import.meta.main) ||
  (typeof process !== 'undefined' && typeof process.argv !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMain) {
  await buildCatalog();
}
