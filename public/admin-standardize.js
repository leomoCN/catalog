'use strict';

/* ============================================================
   图片标准化 · 浏览器本地 Canvas 编辑器（管理页第五个标签页）
   多选图片 → 填充裁切 / 完整适配 → 拖动裁切区域 / 缩放 → 统一导出
   1200×1500（4:5）JPEG。纯浏览器本地：不调用任何接口、不上传、
   不写服务器。整个模块用 IIFE 包裹，不与 admin.js 顶层全局冲突，
   不影响既有产品资料 / 图片补充 / 图片巡检 / 审计日志流程。
   ============================================================ */
(function () {
  const STD_TARGET = { width: 1200, height: 1500 };
  const STD_PREVIEW = { width: 240, height: 300 };
  const STD_NUDGE_RATIO = 0.05; // 箭头微调步长 = 裁切窗口尺寸的 5%（至少 4 源像素）

  const byId = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let stdItems = [];
  let stdIdCounter = 0;
  let stdGridVisible = true; // 裁切对齐网格 + 中心十字的全局显示开关（仅预览辅助，不进入导出图）
  let stdCurrentIndex = 0; // 当前聚焦（上一张/下一张）卡片下标

  /* ---------- 纯函数（测试脚本按函数文本抽取后做行为校验） ---------- */
  function clamp(n, min, max) {
    if (max < min) return min;
    return Math.min(max, Math.max(min, n));
  }

  function baseScale(sw, sh, tw, th, mode) {
    if (!sw || !sh) return 1;
    return mode === 'cover' ? Math.max(tw / sw, th / sh) : Math.min(tw / sw, th / sh);
  }

  // 计算导出/预览用的裁切矩形：
  //   cover（填充裁切）：源按有效缩放铺满目标，用 srcX/srcY 圈定可见区域（拖动 + 钳制）
  //   fit（完整适配）：整张源等比放进目标，四周留白，目标矩形居中
  function computeCrop(sw, sh, tw, th, mode, userScale, offsetX, offsetY) {
    const base = mode === 'cover' ? Math.max(tw / sw, th / sh) : Math.min(tw / sw, th / sh);
    const eff = base * userScale;
    if (mode === 'fit') return { mode, srcX: 0, srcY: 0, srcW: sw, srcH: sh, destX: (tw - sw * eff) / 2, destY: (th - sh * eff) / 2, destW: sw * eff, destH: sh * eff };
    const srcW = tw / eff;
    const srcH = th / eff;
    const maxX = Math.max(0, sw - srcW);
    const maxY = Math.max(0, sh - srcH);
    const srcX = offsetX < 0 ? 0 : (offsetX > maxX ? maxX : offsetX);
    const srcY = offsetY < 0 ? 0 : (offsetY > maxY ? maxY : offsetY);
    return { mode, srcX, srcY, srcW, srcH, destX: 0, destY: 0, destW: tw, destH: th };
  }

  // 拖动后的取景偏移：遵循「图像随指针」——指针向右/下拖动时，
  // 取景窗口在源图上反向移动（预览中的图像随之移动），故用「起始偏移 − 增量」。
  // 自包含（不依赖 clamp），纯函数供测试脚本直接校验拖动方向。
  function moveOffset(start, delta, max) {
    const limit = Math.max(0, max);
    return Math.min(limit, Math.max(0, start - delta));
  }

  // 箭头微调后的取景偏移：同向增量（按一下右箭头 → 取景右移一档），并钳制到可见范围。
  function nudgeOffset(offset, delta, max) {
    const limit = Math.max(0, max);
    return Math.min(limit, Math.max(0, offset + delta));
  }

  function downloadName(originalName) {
    const base = String(originalName || 'image').replace(/\.[^.]+$/, '');
    return `${base}_1200x1500.jpg`;
  }

  // 导出文件名清理：去掉路径分隔符 / 控制字符 / 非法字符，去掉首尾空白与尾部点号，
  // 保证以 .jpg / .jpeg 结尾（其它扩展名一律替换为 .jpg），空值回落到 image.jpg。
  function sanitizeFilename(name) {
    const raw = String(name ?? '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
    const base = raw || 'image';
    if (/\.jpe?g$/i.test(base)) return base;
    return `${base.replace(/\.[^.]+$/, '')}.jpg`;
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // 裁切对齐辅助：在预览画布上叠加「三分构图网格 + 中心十字准线」。
  // 只在预览绘制（纯视觉参考），导出画布从不调用，保证导出图不含网格。
  function drawStdGrid(ctx, w, h) {
    if (!ctx || !w || !h) return;
    const x1 = w / 3;
    const x2 = (w * 2) / 3;
    const y1 = h / 3;
    const y2 = (h * 2) / 3;
    ctx.save();
    // 三分构图网格
    ctx.strokeStyle = 'rgba(79, 70, 229, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, h);
    ctx.moveTo(x2, 0);
    ctx.lineTo(x2, h);
    ctx.moveTo(0, y1);
    ctx.lineTo(w, y1);
    ctx.moveTo(0, y2);
    ctx.lineTo(w, y2);
    ctx.stroke();
    // 中心十字准线（颜色更深、略粗，便于区分三分网格）
    ctx.strokeStyle = 'rgba(220, 60, 60, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.restore();
  }

  // 水平/垂直居中时裁切窗口相对源图的对齐偏移：窗口超出源图（无法居中）时返回 0。
  function alignOffset(total, windowSize) {
    if (!total || !windowSize) return 0;
    const diff = total - windowSize;
    return diff > 0 ? diff / 2 : 0;
  }

  /* ---------- 渲染 ---------- */
  function stdEffScale(item) {
    const img = item.img;
    return baseScale(img.naturalWidth, img.naturalHeight, STD_TARGET.width, STD_TARGET.height, item.mode) * item.scale;
  }

  function stdItemCardHTML(item) {
    return `<div class="std-card${item.selected ? ' is-selected' : ''}" data-id="${item.id}">
      <div class="std-card-head">
        <label class="std-check"><input type="checkbox" data-std-select="${item.id}"${item.selected ? ' checked' : ''}> <span>导出</span></label>
        <label class="std-done" title="标记 / 取消已处理（交互调整也会自动标记）"><input type="checkbox" data-std-done="${item.id}"${item.processed ? ' checked' : ''}> 已处理</label>
        <span class="std-size">${esc(formatBytes(item.file.size))}</span>
        <button type="button" class="quiet danger std-remove" data-std-remove="${item.id}">移除</button>
      </div>
      <label class="std-name-row" title="编辑导出文件名（导出时自动清理非法字符并保证 .jpg 扩展名）">
        <span class="std-name-label">导出文件名</span>
        <input class="std-name-input" type="text" data-std-name="${item.id}" value="${esc(item.customName)}" spellcheck="false">
      </label>
      <div class="std-preview">
        <canvas width="${STD_PREVIEW.width}" height="${STD_PREVIEW.height}"></canvas>
        ${item.mode === 'cover' ? '<div class="std-drag-hint">拖拽移动裁切区域</div>' : ''}
      </div>
      <div class="std-controls">
        <div class="std-mode-row">
          <button type="button" class="std-mode-btn${item.mode === 'cover' ? ' is-active' : ''}" data-std-mode="${item.id}" data-mode="cover">填充裁切</button>
          <button type="button" class="std-mode-btn${item.mode === 'fit' ? ' is-active' : ''}" data-std-mode="${item.id}" data-mode="fit">完整适配</button>
        </div>
        <div class="std-nudge-row">
          <button type="button" class="std-nudge-btn" title="取景微调：上（按裁切窗口 5%）" data-std-nudge="${item.id}" data-dx="0" data-dy="-1"${item.mode !== 'cover' ? ' disabled' : ''}>▲</button>
          <button type="button" class="std-nudge-btn" title="取景微调：左（按裁切窗口 5%）" data-std-nudge="${item.id}" data-dx="-1" data-dy="0"${item.mode !== 'cover' ? ' disabled' : ''}>◀</button>
          <button type="button" class="std-nudge-btn" title="取景微调：右（按裁切窗口 5%）" data-std-nudge="${item.id}" data-dx="1" data-dy="0"${item.mode !== 'cover' ? ' disabled' : ''}>▶</button>
          <button type="button" class="std-nudge-btn" title="取景微调：下（按裁切窗口 5%）" data-std-nudge="${item.id}" data-dx="0" data-dy="1"${item.mode !== 'cover' ? ' disabled' : ''}>▼</button>
        </div>
        <div class="std-align-row">
          <button type="button" class="std-align-btn" title="水平居中：裁切窗口对齐到图片横向中央" data-std-align="${item.id}" data-align="h"${item.mode !== 'cover' ? ' disabled' : ''}>水平</button>
          <button type="button" class="std-align-btn" title="垂直居中：裁切窗口对齐到图片纵向中央" data-std-align="${item.id}" data-align="v"${item.mode !== 'cover' ? ' disabled' : ''}>垂直</button>
          <button type="button" class="std-align-btn" title="居中：横纵双向同时居中" data-std-align="${item.id}" data-align="center"${item.mode !== 'cover' ? ' disabled' : ''}>居中</button>
          <button type="button" class="std-align-btn" title="重置：裁切位置回到图片左上角" data-std-align="${item.id}" data-align="reset"${item.mode !== 'cover' ? ' disabled' : ''}>重置</button>
        </div>
        <label class="std-scale-row">
          <span class="std-scale-label">缩放</span>
          <input type="range" min="100" max="300" value="${Math.round(item.scale * 100)}" data-std-scale="${item.id}">
          <span class="std-scale-value">${Math.round(item.scale * 100)}%</span>
        </label>
      </div>
    </div>`;
  }

  function renderStdItem(item) {
    const canvas = item.canvas;
    if (!canvas || !item.loaded || !item.img) return;
    const ctx = canvas.getContext('2d');
    const img = item.img;
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    const eff = stdEffScale(item);
    item.effectiveScale = eff;
    const crop = computeCrop(sw, sh, STD_TARGET.width, STD_TARGET.height, item.mode, item.scale, item.offsetX, item.offsetY);
    item.crop = crop;
    // 预览画布与导出目标同为 4:5，源裁切区域一致，仅目标矩形按预览比例缩放
    const k = STD_PREVIEW.width / STD_TARGET.width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, STD_PREVIEW.width, STD_PREVIEW.height);
    ctx.drawImage(img, crop.srcX, crop.srcY, crop.srcW, crop.srcH, crop.destX * k, crop.destY * k, crop.destW * k, crop.destH * k);
    // 对齐网格 + 中心十字只画在预览上（辅助取景），导出画布不调用，保证导出图与预览取景一致且不含网格
    if (stdGridVisible) drawStdGrid(ctx, STD_PREVIEW.width, STD_PREVIEW.height);
    const label = item.el && item.el.querySelector('.std-scale-value');
    if (label) label.textContent = `${Math.round(item.scale * 100)}%`;
  }

  function renderStdGrid() {
    const grid = byId('std-grid');
    if (!stdItems.length) {
      stdCurrentIndex = 0;
      grid.innerHTML = '<p class="empty-note">尚未选择图片。可拖拽或点击选择多张图片。</p>';
      updateStdCount();
      updateStdExportState();
      updateStdPosition();
      updateStdProgress();
      return;
    }
    grid.innerHTML = stdItems.map(stdItemCardHTML).join('');
    for (const item of stdItems) {
      item.el = grid.querySelector(`.std-card[data-id="${item.id}"]`);
      if (!item.el) continue;
      item.canvas = item.el.querySelector('canvas');
      // 每次重绘都会重建画布元素，因此每次都需要重新绑定拖拽（新元素无监听器）
      if (item.canvas) bindStdDrag(item);
      if (item.loaded && item.img) {
        renderStdItem(item);
      } else if (item.error) {
        const preview = item.el.querySelector('.std-preview');
        if (preview) preview.innerHTML = `<div class="std-decode-error">${esc(item.error)}</div>`;
      }
    }
    const current = stdItems[stdCurrentIndex];
    if (current && current.el) current.el.classList.add('is-current');
    updateStdCount();
    updateStdExportState();
    updateStdPosition();
    updateStdProgress();
  }

  function updateStdCount() {
    const done = stdItems.filter((i) => i.processed).length;
    byId('std-count').innerHTML = `共 <b>${stdItems.length}</b> 张，已选 <b>${stdItems.filter((i) => i.selected).length}</b> 张，已处理 <b>${done}</b> 张；导出尺寸统一为 1200×1500（4:5）JPEG。`;
  }

  function updateStdExportState() {
    byId('std-export').disabled = stdItems.filter((i) => i.selected).length === 0;
  }

  function updateStdPosition() {
    const el = byId('std-position');
    if (el) el.textContent = stdItems.length ? `${stdCurrentIndex + 1} / ${stdItems.length}` : '0 / 0';
  }

  function updateStdProgress() {
    const done = stdItems.filter((i) => i.processed).length;
    const total = stdItems.length;
    const text = byId('std-progress-text');
    if (text) text.textContent = `已处理 ${done} / ${total} 张`;
    const bar = byId('std-progress-bar');
    if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  }

  function stdSetCurrent(idx) {
    if (!stdItems.length) { stdCurrentIndex = 0; return; }
    stdCurrentIndex = clamp(idx, 0, stdItems.length - 1);
    renderStdGrid();
    const current = stdItems[stdCurrentIndex];
    if (current && current.el && current.el.scrollIntoView) current.el.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- 拖拽：仅 cover（填充裁切）模式可平移裁切区域（保持偏移连续、不跳变） ---------- */
  function bindStdDrag(item) {
    const canvas = item.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      if (item.mode !== 'cover' || !item.loaded || !item.img) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      // 预览上 1 屏幕像素对应的源像素数：srcW / 预览显示宽度
      const srcW = STD_TARGET.width / item.effectiveScale;
      const srcH = STD_TARGET.height / item.effectiveScale;
      item.drag = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        offX: item.offsetX,
        offY: item.offsetY,
        factor: rect.width ? srcW / rect.width : 1,
        srcW,
        srcH,
      };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!item.drag || !item.drag.active) return;
      const dx = (e.clientX - item.drag.startX) * item.drag.factor;
      const dy = (e.clientY - item.drag.startY) * item.drag.factor;
      // 图随指针：用 moveOffset 把偏移钳制到可见范围内并写回 item.offsetX/offsetY，
      // 保持「存储偏移 = 可见位置」一致，后续再拖不因越界值跳变
      item.offsetX = moveOffset(item.drag.offX, dx, Math.max(0, item.img.naturalWidth - item.drag.srcW));
      item.offsetY = moveOffset(item.drag.offY, dy, Math.max(0, item.img.naturalHeight - item.drag.srcH));
      renderStdItem(item);
    });
    const endDrag = () => {
      if (!item.drag) return;
      item.drag.active = false;
      item.processed = true;
      updateStdProgress();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  /* ---------- 文件加载 ---------- */
  function addStdFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && typeof f.size === 'number' && /^image\//.test(String(f.type)));
    if (!files.length) { showStdError('未选择可解码的图片文件（支持 JPEG / PNG / WebP）。'); return; }
    hideStdError();
    for (const file of files) {
      const item = {
        id: ++stdIdCounter,
        file,
        url: URL.createObjectURL(file),
        img: null,
        loaded: false,
        loading: false,
        error: '',
        mode: 'cover',
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        effectiveScale: 1,
        selected: true,
        processed: false,
        customName: downloadName(file.name),
        el: null,
        canvas: null,
        drag: null,
      };
      stdItems.push(item);
    }
    renderStdGrid();
    loadStdImages();
  }

  function loadStdImages() {
    for (const item of stdItems) {
      if (item.loaded || item.loading || item.error) continue;
      item.loading = true;
      const img = new Image();
      img.onload = () => {
        item.img = img;
        item.loaded = true;
        item.loading = false;
        renderStdGrid();
      };
      img.onerror = () => {
        item.loading = false;
        item.error = '图片无法解码（格式不受支持或文件损坏）';
        renderStdGrid();
      };
      img.src = item.url;
    }
  }

  function removeStdItem(id) {
    const idx = stdItems.findIndex((i) => i.id === id);
    if (idx === -1) return;
    if (stdItems[idx].url) URL.revokeObjectURL(stdItems[idx].url);
    stdItems.splice(idx, 1);
    if (stdCurrentIndex >= stdItems.length) stdCurrentIndex = Math.max(0, stdItems.length - 1);
    renderStdGrid();
  }

  function clearStdItems() {
    for (const item of stdItems) if (item.url) URL.revokeObjectURL(item.url);
    stdItems = [];
    stdCurrentIndex = 0;
    renderStdGrid();
  }

  /* ---------- 导出 ---------- */
  function stdQuality() {
    return clamp(Number(byId('std-quality').value || 85) / 100, 0.1, 1);
  }

  // 导出文件名：优先使用当前卡片可编辑文件名（导出时清理非法字符并保证 .jpg），
  // 未编辑时回落为默认的「原文件名_1200x1500.jpg」。
  function stdExportName(item) {
    return sanitizeFilename(item.customName || downloadName(item.file.name));
  }

  function exportStdItem(item) {
    return new Promise((resolve, reject) => {
      try {
        const img = item.img;
        const sw = img.naturalWidth;
        const sh = img.naturalHeight;
        const crop = computeCrop(sw, sh, STD_TARGET.width, STD_TARGET.height, item.mode, item.scale, item.offsetX, item.offsetY);
        const canvas = document.createElement('canvas');
        canvas.width = STD_TARGET.width;
        canvas.height = STD_TARGET.height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, STD_TARGET.width, STD_TARGET.height);
        ctx.drawImage(img, crop.srcX, crop.srcY, crop.srcW, crop.srcH, crop.destX, crop.destY, crop.destW, crop.destH);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('无法编码 JPEG')); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = stdExportName(item);
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          resolve();
        }, 'image/jpeg', stdQuality());
      } catch (err) {
        reject(err);
      }
    });
  }

  async function exportSelected() {
    const selected = stdItems.filter((i) => i.selected);
    if (!selected.length) { showStdError('请先勾选要导出的图片（每张卡片左上角「导出」勾选框）。'); return; }
    if (selected.some((i) => !i.loaded || !i.img)) { showStdError('部分图片仍在加载或解码失败，请稍后重试。'); return; }
    hideStdError();
    let ok = 0;
    let failed = 0;
    const quality = byId('std-quality').value;
    byId('std-export').disabled = true;
    for (let i = 0; i < selected.length; i += 1) {
      const item = selected[i];
      showStdStatus(`正在导出 ${i + 1}/${selected.length}：${stdExportName(item)}（1200×1500 JPEG，质量 ${quality}%）…`);
      try {
        await exportStdItem(item);
        ok += 1;
        item.processed = true;
      } catch (err) {
        failed += 1;
        console.error(err);
      }
      updateStdProgress();
      // 逐个触发下载，避免浏览器批量下载并发限制
      await new Promise((r) => setTimeout(r, 120));
    }
    updateStdExportState();
    showStdStatus(`导出完成：成功 ${ok} 张${failed ? `，失败 ${failed} 张（若为浏览器批量下载限制，请分批导出）。` : '，文件名已按卡片「导出文件名」命名。'}`);
  }

  /* ---------- 状态提示 ---------- */
  function showStdStatus(text) {
    const el = byId('std-status');
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function showStdError(text) {
    const el = byId('std-error');
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function hideStdError() {
    byId('std-error').classList.add('hidden');
  }

  /* ---------- 事件绑定 ---------- */
  function bindStdEvents() {
    byId('std-pick').addEventListener('click', () => { byId('std-file-input').value = ''; byId('std-file-input').click(); });
    byId('std-file-input').addEventListener('change', (e) => { addStdFiles(e.target.files); e.target.value = ''; });
    byId('std-dropzone').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      byId('std-file-input').value = '';
      byId('std-file-input').click();
    });
    ['dragover', 'dragenter'].forEach((ev) => {
      byId('std-dropzone').addEventListener(ev, (e) => { e.preventDefault(); byId('std-dropzone').classList.add('is-drag'); });
    });
    byId('std-dropzone').addEventListener('dragleave', () => byId('std-dropzone').classList.remove('is-drag'));
    byId('std-dropzone').addEventListener('drop', (e) => {
      e.preventDefault();
      byId('std-dropzone').classList.remove('is-drag');
      addStdFiles(e.dataTransfer.files);
    });
    byId('std-quality').addEventListener('input', () => { byId('std-quality-label').textContent = `${byId('std-quality').value}%`; });
    byId('std-export').addEventListener('click', exportSelected);
    byId('std-prev').addEventListener('click', () => stdSetCurrent(stdCurrentIndex - 1));
    byId('std-next').addEventListener('click', () => stdSetCurrent(stdCurrentIndex + 1));
    byId('std-clear').addEventListener('click', () => {
      if (stdItems.length && !window.confirm('确定清空已选择的图片吗？')) return;
      clearStdItems();
    });
    byId('std-grid-toggle').addEventListener('click', () => {
      stdGridVisible = !stdGridVisible;
      byId('std-grid-toggle').textContent = `网格：${stdGridVisible ? '开' : '关'}`;
      renderStdGrid();
    });
    // 上一张 / 下一张快捷键（Alt+← / Alt+→），输入框内不触发
    document.addEventListener('keydown', (e) => {
      if (!byId('std-prev')) return;
      if (byId('tab-standardize').classList.contains('hidden')) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); stdSetCurrent(stdCurrentIndex - 1); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); stdSetCurrent(stdCurrentIndex + 1); }
    });
    byId('std-grid').addEventListener('change', (e) => {
      const box = e.target.closest('[data-std-select]');
      if (box) {
        const item = stdItems.find((i) => i.id === Number(box.dataset.stdSelect));
        if (item) { item.selected = box.checked; renderStdGrid(); }
        return;
      }
      const doneBox = e.target.closest('[data-std-done]');
      if (doneBox) {
        const item = stdItems.find((i) => i.id === Number(doneBox.dataset.stdDone));
        if (item) { item.processed = doneBox.checked; renderStdGrid(); }
      }
    });
    byId('std-grid').addEventListener('input', (e) => {
      const scaleInput = e.target.closest('[data-std-scale]');
      if (scaleInput) {
        const item = stdItems.find((i) => i.id === Number(scaleInput.dataset.stdScale));
        if (!item) return;
        item.scale = Number(scaleInput.value) / 100;
        item.processed = true;
        renderStdItem(item);
        updateStdExportState();
        updateStdProgress();
        return;
      }
      const nameInput = e.target.closest('[data-std-name]');
      if (nameInput) {
        const item = stdItems.find((i) => i.id === Number(nameInput.dataset.stdName));
        if (!item) return;
        item.customName = nameInput.value;
        item.processed = true;
        updateStdProgress();
      }
    });
    byId('std-grid').addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-std-remove]');
      if (removeBtn) { removeStdItem(Number(removeBtn.dataset.stdRemove)); return; }
      const modeBtn = e.target.closest('[data-std-mode]');
      if (modeBtn) {
        const item = stdItems.find((i) => i.id === Number(modeBtn.dataset.stdMode));
        if (!item) return;
        item.mode = modeBtn.dataset.mode;
        item.processed = true;
        // 切换模式保留裁切位置（offset 不自动复位），需要复位时用「重置」按钮
        renderStdGrid();
        updateStdProgress();
        return;
      }
      const nudgeBtn = e.target.closest('[data-std-nudge]');
      if (nudgeBtn) {
        const item = stdItems.find((i) => i.id === Number(nudgeBtn.dataset.stdNudge));
        if (!item || !item.img || item.mode !== 'cover') return;
        const eff = stdEffScale(item);
        const srcW = STD_TARGET.width / eff;
        const srcH = STD_TARGET.height / eff;
        const stepX = Math.max(4, Math.round(srcW * STD_NUDGE_RATIO));
        const stepY = Math.max(4, Math.round(srcH * STD_NUDGE_RATIO));
        const dx = Number(nudgeBtn.dataset.dx || 0) * stepX;
        const dy = Number(nudgeBtn.dataset.dy || 0) * stepY;
        item.offsetX = nudgeOffset(item.offsetX, dx, Math.max(0, item.img.naturalWidth - srcW));
        item.offsetY = nudgeOffset(item.offsetY, dy, Math.max(0, item.img.naturalHeight - srcH));
        item.processed = true;
        renderStdItem(item);
        updateStdProgress();
        return;
      }
      const alignBtn = e.target.closest('[data-std-align]');
      if (alignBtn) {
        const item = stdItems.find((i) => i.id === Number(alignBtn.dataset.stdAlign));
        if (!item || !item.img || item.mode !== 'cover') return;
        const eff = stdEffScale(item);
        const srcW = STD_TARGET.width / eff;
        const srcH = STD_TARGET.height / eff;
        const action = alignBtn.dataset.align;
        if (action === 'h' || action === 'center') item.offsetX = alignOffset(item.img.naturalWidth, srcW);
        if (action === 'v' || action === 'center') item.offsetY = alignOffset(item.img.naturalHeight, srcH);
        if (action === 'reset') { item.offsetX = 0; item.offsetY = 0; }
        item.processed = true;
        renderStdItem(item);
        updateStdProgress();
      }
    });
  }

  function initStd() {
    bindStdEvents();
    renderStdGrid();
  }

  initStd();
})();
