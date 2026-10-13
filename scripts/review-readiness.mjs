// 审核就绪度计算模块（管理「图片补充/审核」工作台专用；纯函数，供 server.js / 测试 / CLI 共用）
// 就绪度由两项要素决定：
//   - 图片完整度 imageComplete：所有颜色组合均为 4/4 四视角完整（颜色组合为 0 时视为未完整）
//   - 分类状态 needsCategory：categoryStatus === 'pending'（待人工确认分类）
// 分级结果 readiness：
//   ready            图片完整且分类已确认 → 可直接审核公开
//   needs-images     图片未完整（分类已确认）→ 待补图
//   needs-category   图片完整但分类待确认 → 待人工确认分类
//   needs-both       图片未完整且分类待确认 → 待补图 + 待确认分类
// 展示状态 displayStatus 不参与就绪分级（由工作台以独立徽标展示，便于快速切换审核动作）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const READINESS_ORDER = ['ready', 'needs-images', 'needs-category', 'needs-both'];

export const READINESS_LABELS = {
  ready: '就绪',
  'needs-images': '待补图',
  'needs-category': '待确认分类',
  'needs-both': '待补图+分类',
};

// 评估单款产品的审核就绪度（product 为内部目录产品，含 variants / categoryStatus）
export function assessReadiness(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const colorCount = variants.length;
  const completeColors = variants.filter((variant) => !!variant.complete).length;
  const imageComplete = colorCount > 0 && completeColors === colorCount;
  const needsCategory = product.categoryStatus === 'pending';
  const readiness = imageComplete && !needsCategory ? 'ready'
    : !imageComplete && !needsCategory ? 'needs-images'
    : imageComplete && needsCategory ? 'needs-category'
    : 'needs-both';
  return { imageComplete, needsCategory, readiness, colorCount, completeColors };
}

// 就绪度计数（models 为工作台模型数组，每项携带 readiness）
export function buildReadinessCounts(models) {
  const counts = { ready: 0, 'needs-images': 0, 'needs-category': 0, 'needs-both': 0 };
  for (const model of models || []) {
    const key = model && model.readiness;
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    else if (key) counts[key] = 1;
  }
  return counts;
}

// 分类分布计数（models 为工作台模型数组，每项携带 category）
export function buildCategoryCounts(models) {
  const byCategory = {};
  for (const model of models || []) {
    const category = (model && model.category) || '';
    byCategory[category] = (byCategory[category] || 0) + 1;
  }
  return byCategory;
}

const isMain =
  (typeof import.meta !== 'undefined' && import.meta.main) ||
  (typeof process !== 'undefined' && typeof process.argv !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMain) {
  // CLI：读取内部目录并输出审核就绪度汇总（npm run review-readiness）
  const { readFile } = await import('node:fs/promises');
  const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url)));
  const models = catalog.products.map((product) => ({
    model: product.model,
    category: product.category,
    categoryStatus: product.categoryStatus,
    ...assessReadiness(product),
  }));
  const counts = buildReadinessCounts(models);
  const byCategory = buildCategoryCounts(models);
  console.log(`审核就绪度汇总：共 ${models.length} 款产品`);
  for (const key of READINESS_ORDER) {
    console.log(`  ${READINESS_LABELS[key]}（${key}）= ${counts[key] || 0} 款`);
  }
  console.log(`分类分布：${Object.entries(byCategory).map(([c, n]) => `${c}=${n}`).join('，')}`);
}
