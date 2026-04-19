// editor.js — Trailmark full-tab editor
// ─────────────────────────────────────────────────────────────────────────────
// Responsibilities:
//   • Load steps from chrome.storage.local
//   • Render the step rail (select / reorder via drag / delete)
//   • Canvas annotation editor with Select, Rect, Arrow, Highlight, Text, Blur
//   • Every annotation is a movable, resizable, deletable object
//   • Persist edits (debounced) to chrome.storage.local
//   • Export to PDF, Markdown (+ PNG files), and Microsoft Word (.doc)
//
// Annotation model — normalized coords (0..1 of natural image size) so shapes
// survive canvas resizes. Types:
//   rect       { x, y, w, h, color }
//   highlight  { x, y, w, h, color }
//   blur       { x, y, w, h }                 // color ignored
//   arrow      { x1, y1, x2, y2, color }
//   text       { x, y, text, color, size }    // size = font px at natural res
// ─────────────────────────────────────────────────────────────────────────────

// ─── Palette ────────────────────────────────────────────────────────────────
const PALETTE = [
  { name: 'Red',    value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green',  value: '#22c55e' },
  { name: 'Blue',   value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
];

// Highlight is always semi-transparent regardless of base color.
function highlightFill(hex) {
  // Convert hex #rrggbb → rgba(..., 0.35)
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},0.35)`;
}

// ─── State ──────────────────────────────────────────────────────────────────

let steps = [];
let selectedIndex = -1;
let currentTool = 'select';
let currentColor = PALETTE[0].value;
let guideTitle = '';

// AI description-check state
let llmKeyPresent = false;
const lastCheckResult = new Map();   // description text -> { ok, reason, suggestion }
let checkInFlight = false;
let descStatusTimer = null;          // auto-hide timer for ok/error states

// Selection / drag state for annotations
let selectedAnn = -1;              // index into steps[selectedIndex].annotations
let dragMode = null;               // 'move' | 'resize' | 'draw' | null
let dragHandle = null;              // handle name when dragMode='resize'
let dragStart = null;               // canvas-space {x,y}
let dragCurrent = null;
let dragOrigShape = null;           // snapshot of shape before drag (for move/resize)

// Canvas / image
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let bgImage = null;

// DOM refs
const stepListEl = document.getElementById('stepList');
const stepCountEl = document.getElementById('stepCount');
const railEmpty = document.getElementById('railEmpty');
const stageEmpty = document.getElementById('stageEmpty');
const stageEditor = document.getElementById('stageEditor');
const titleInput = document.getElementById('titleInput');
const descInput = document.getElementById('descInput');
const metaRow = document.getElementById('metaRow');
const colorRow = document.getElementById('colorRow');

// ─── Persistence ────────────────────────────────────────────────────────────

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 200);
}
async function persist() {
  await chrome.storage.local.set({ steps, editorTitle: guideTitle });
}

async function load() {
  const { steps: s, editorTitle, llmConfig } =
    await chrome.storage.local.get(['steps', 'editorTitle', 'llmConfig']);
  steps = (s || []).map(st => ({ ...st, annotations: st.annotations || [] }));
  guideTitle = editorTitle || steps[0]?.pageTitle || '';
  titleInput.value = guideTitle;
  llmKeyPresent = !!llmConfig?.apiKey;

  renderPalette();
  renderRail();
  if (steps.length > 0) selectStep(0);
  else showEmpty();
  updateDescUiForCurrentStep();
}

// Live-flip the description-check UI if the user sets up a key in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.llmConfig) return;
  llmKeyPresent = !!changes.llmConfig.newValue?.apiKey;
  updateDescUiForCurrentStep();
});

// Stay in sync when new steps are added elsewhere
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.steps) return;
    const newSteps = (changes.steps.newValue || []).map(st => ({
      ...st, annotations: st.annotations || []
    }));
    if (newSteps.length !== steps.length) {
      steps = newSteps;
      renderRail();
      if (selectedIndex >= steps.length) selectedIndex = steps.length - 1;
      if (selectedIndex < 0 && steps.length > 0) selectedIndex = 0;
      if (selectedIndex >= 0) selectStep(selectedIndex);
      else showEmpty();
    }
  });
}

// ─── Palette rendering ──────────────────────────────────────────────────────

function renderPalette() {
  colorRow.querySelectorAll('.color-swatch').forEach(el => el.remove());
  PALETTE.forEach(({ name, value }) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch' + (value === currentColor ? ' active' : '');
    btn.style.background = value;
    btn.title = name;
    btn.dataset.color = value;
    btn.addEventListener('click', () => {
      currentColor = value;
      colorRow.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      // If an annotation is selected, recolor it (unless it's a blur).
      if (selectedIndex >= 0 && selectedAnn >= 0) {
        const shape = steps[selectedIndex].annotations[selectedAnn];
        if (shape && shape.type !== 'blur') {
          shape.color = value;
          redraw();
          scheduleSave();
        }
      }
    });
    colorRow.appendChild(btn);
  });
}

// ─── Rail rendering ─────────────────────────────────────────────────────────

function renderRail() {
  stepCountEl.textContent = `${steps.length} step${steps.length !== 1 ? 's' : ''}`;
  if (steps.length === 0) {
    stepListEl.innerHTML = '';
    railEmpty.style.display = 'block';
    return;
  }
  railEmpty.style.display = 'none';

  stepListEl.innerHTML = '';
  steps.forEach((step, i) => {
    const card = document.createElement('div');
    card.className = 'step-card' + (i === selectedIndex ? ' selected' : '');
    card.draggable = true;
    card.dataset.index = String(i);
    card.innerHTML = `
      <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
      <div class="step-card-num">${i + 1}</div>
      <div class="step-card-body">
        <div class="step-card-desc"></div>
        <img class="step-card-thumb" alt="Step ${i + 1}" />
      </div>
      <div class="step-card-actions">
        <button class="del-btn" title="Delete step">✕</button>
      </div>
    `;
    card.querySelector('.step-card-desc').textContent = step.description || '(no description)';
    card.querySelector('.step-card-thumb').src = step.screenshot;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.step-card-actions')) return;
      selectStep(i);
    });
    card.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteStep(i);
    });

    // ─── Drag-to-reorder ───
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      stepListEl.querySelectorAll('.step-card').forEach(c => {
        c.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      card.classList.toggle('drag-over-top', before);
      card.classList.toggle('drag-over-bottom', !before);
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (Number.isNaN(from)) return;
      const rect = card.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      let to = parseInt(card.dataset.index, 10);
      if (!before) to += 1;
      if (from < to) to -= 1;
      if (from === to) { card.classList.remove('drag-over-top', 'drag-over-bottom'); return; }
      reorderSteps(from, to);
    });

    stepListEl.appendChild(card);
  });
}

function reorderSteps(from, to) {
  if (from < 0 || from >= steps.length) return;
  if (to < 0) to = 0;
  if (to >= steps.length) to = steps.length - 1;
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step);
  if (selectedIndex === from) selectedIndex = to;
  else if (from < selectedIndex && to >= selectedIndex) selectedIndex--;
  else if (from > selectedIndex && to <= selectedIndex) selectedIndex++;
  renumber();
  renderRail();
  scheduleSave();
}

function deleteStep(i) {
  if (!confirm(`Delete step ${i + 1}?`)) return;
  steps.splice(i, 1);
  if (steps.length === 0) {
    selectedIndex = -1;
    renumber();
    renderRail();
    showEmpty();
  } else {
    if (selectedIndex >= steps.length) selectedIndex = steps.length - 1;
    if (selectedIndex > i) selectedIndex--;
    renumber();
    renderRail();
    selectStep(selectedIndex);
  }
  scheduleSave();
}

function renumber() {
  steps.forEach((s, idx) => { s.stepNumber = idx + 1; });
}

function showEmpty() {
  stageEmpty.style.display = 'flex';
  stageEditor.style.display = 'none';
}

// ─── Step selection + canvas setup ─────────────────────────────────────────

function selectStep(i) {
  selectedIndex = i;
  selectedAnn = -1;
  const step = steps[i];
  if (!step) { showEmpty(); return; }

  stageEmpty.style.display = 'none';
  stageEditor.style.display = 'flex';
  descInput.value = step.description || '';
  renderMeta(step);

  bgImage = new Image();
  bgImage.onload = () => {
    canvas.width = bgImage.naturalWidth;
    canvas.height = bgImage.naturalHeight;
    redraw();
  };
  bgImage.src = step.screenshot;

  [...stepListEl.children].forEach((el, idx) => {
    el.classList.toggle('selected', idx === i);
  });
  updateDescUiForCurrentStep();
}

function renderMeta(step) {
  const ec = step.elementContext || {};
  const parts = [];
  if (step.pageTitle) parts.push(`<span><strong>Page:</strong> ${escapeHtml(step.pageTitle)}</span>`);
  if (step.url) parts.push(`<span><strong>URL:</strong> ${escapeHtml(step.url)}</span>`);
  if (ec.tag) parts.push(`<span><strong>Target:</strong> &lt;${escapeHtml(ec.tag)}&gt;</span>`);
  if (ec.text) parts.push(`<span><strong>Text:</strong> "${escapeHtml(ec.text)}"</span>`);
  metaRow.innerHTML = parts.join('');
}

// ─── Annotation drawing ────────────────────────────────────────────────────

function redraw() {
  if (!bgImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
  const step = steps[selectedIndex];
  if (step) {
    step.annotations.forEach((a, i) => {
      drawAnnotationOn(ctx, canvas, a, bgImage);
      if (i === selectedAnn && currentTool === 'select') drawSelection(ctx, canvas, a);
    });
  }
  // Live preview of the shape currently being drawn
  if (dragMode === 'draw' && dragStart && dragCurrent) {
    const preview = shapeFromDrag(dragStart, dragCurrent, currentTool, currentColor);
    if (preview) drawAnnotationOn(ctx, canvas, preview, bgImage);
  }
}

// Draw an annotation onto an arbitrary canvas/context.
// `bgImageForBlur` is the source image used when flattening a blur region —
// for the live editor this is `bgImage`; for exports it's a fresh Image().
function drawAnnotationOn(cctx, c, a, bgImageForBlur) {
  cctx.save();
  const color = a.color || PALETTE[0].value;
  if (a.type === 'rect') {
    cctx.strokeStyle = color;
    cctx.lineWidth = Math.max(3, c.width / 400);
    cctx.strokeRect(a.x * c.width, a.y * c.height, a.w * c.width, a.h * c.height);
  } else if (a.type === 'highlight') {
    cctx.fillStyle = highlightFill(color);
    cctx.fillRect(a.x * c.width, a.y * c.height, a.w * c.width, a.h * c.height);
  } else if (a.type === 'blur') {
    const bx = a.x * c.width, by = a.y * c.height;
    const bw = a.w * c.width, bh = a.h * c.height;
    cctx.save();
    cctx.beginPath();
    cctx.rect(bx, by, bw, bh);
    cctx.clip();
    // Canvas filter: blur the entire source image, but clipped to the rect,
    // only the pixels inside the rect actually change.
    cctx.filter = 'blur(14px)';
    if (bgImageForBlur) {
      cctx.drawImage(bgImageForBlur, 0, 0, c.width, c.height);
    }
    cctx.restore();
    // A faint border so the user can still see the blurred region in the editor
    cctx.strokeStyle = 'rgba(255,255,255,0.5)';
    cctx.setLineDash([6, 4]);
    cctx.lineWidth = Math.max(1.5, c.width / 800);
    cctx.strokeRect(bx, by, bw, bh);
  } else if (a.type === 'arrow') {
    drawArrowOn(cctx, c,
      a.x1 * c.width, a.y1 * c.height,
      a.x2 * c.width, a.y2 * c.height, color);
  } else if (a.type === 'text') {
    const size = (a.size || Math.max(20, c.width / 50));
    cctx.font = `bold ${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
    cctx.textBaseline = 'top';
    const padX = size * 0.5, padY = size * 0.25;
    const metrics = cctx.measureText(a.text || '');
    const w = metrics.width + padX * 2;
    const h = size + padY * 2;
    const x = a.x * c.width;
    const y = a.y * c.height;
    cctx.fillStyle = color;
    roundRectPath(cctx, x, y, w, h, 6);
    cctx.fill();
    cctx.fillStyle = 'white';
    cctx.fillText(a.text || '', x + padX, y + padY);
  }
  cctx.restore();
}

function drawArrowOn(cctx, c, x1, y1, x2, y2, color) {
  const width = Math.max(4, c.width / 350);
  cctx.strokeStyle = color;
  cctx.fillStyle = color;
  cctx.lineWidth = width;
  cctx.lineCap = 'round';
  cctx.beginPath();
  cctx.moveTo(x1, y1);
  cctx.lineTo(x2, y2);
  cctx.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(18, c.width / 60);
  cctx.beginPath();
  cctx.moveTo(x2, y2);
  cctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  cctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  cctx.closePath();
  cctx.fill();
}

function roundRectPath(cctx, x, y, w, h, r) {
  cctx.beginPath();
  cctx.moveTo(x + r, y);
  cctx.arcTo(x + w, y, x + w, y + h, r);
  cctx.arcTo(x + w, y + h, x, y + h, r);
  cctx.arcTo(x, y + h, x, y, r);
  cctx.arcTo(x, y, x + w, y, r);
  cctx.closePath();
}

// ─── Bounding boxes, hit-test, and handles ────────────────────────────────

// Return {x, y, w, h} in canvas pixels — the axis-aligned bounds of the shape.
function boundsOf(a) {
  if (a.type === 'rect' || a.type === 'highlight' || a.type === 'blur') {
    return { x: a.x * canvas.width, y: a.y * canvas.height,
             w: a.w * canvas.width, h: a.h * canvas.height };
  }
  if (a.type === 'arrow') {
    const x1 = a.x1 * canvas.width, y1 = a.y1 * canvas.height;
    const x2 = a.x2 * canvas.width, y2 = a.y2 * canvas.height;
    return {
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      w: Math.abs(x2 - x1), h: Math.abs(y2 - y1)
    };
  }
  if (a.type === 'text') {
    const size = a.size || Math.max(20, canvas.width / 50);
    ctx.font = `bold ${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const padX = size * 0.5, padY = size * 0.25;
    const metrics = ctx.measureText(a.text || '');
    return {
      x: a.x * canvas.width,
      y: a.y * canvas.height,
      w: metrics.width + padX * 2,
      h: size + padY * 2
    };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

// Handle size in canvas pixels. Scales with image so small screenshots still work.
function handleSize() {
  return Math.max(10, canvas.width / 120);
}

// Draw 8 corner/mid handles around a shape (2 endpoints for arrow).
function drawSelection(cctx, c, a) {
  cctx.save();
  const hs = handleSize();

  if (a.type === 'arrow') {
    // Selection = dashed line along shape + 2 round handles at endpoints.
    const x1 = a.x1 * c.width, y1 = a.y1 * c.height;
    const x2 = a.x2 * c.width, y2 = a.y2 * c.height;
    cctx.strokeStyle = '#6366f1';
    cctx.setLineDash([6, 4]);
    cctx.lineWidth = Math.max(1.5, c.width / 800);
    cctx.beginPath();
    cctx.moveTo(x1, y1); cctx.lineTo(x2, y2);
    cctx.stroke();
    drawHandle(cctx, x1, y1, hs);
    drawHandle(cctx, x2, y2, hs);
    cctx.restore();
    return;
  }

  const b = boundsOf(a);
  cctx.strokeStyle = '#6366f1';
  cctx.setLineDash([6, 4]);
  cctx.lineWidth = Math.max(1.5, c.width / 800);
  cctx.strokeRect(b.x, b.y, b.w, b.h);
  cctx.setLineDash([]);

  // Text: only 4 corner handles (uniform resize scales font). Rect/highlight/blur: 8 handles.
  const handles = a.type === 'text'
    ? ['nw', 'ne', 'sw', 'se']
    : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  for (const h of handles) {
    const p = handlePoint(b, h);
    drawHandle(cctx, p.x, p.y, hs);
  }
  cctx.restore();
}

function drawHandle(cctx, x, y, size) {
  cctx.fillStyle = 'white';
  cctx.strokeStyle = '#6366f1';
  cctx.lineWidth = 2;
  cctx.beginPath();
  cctx.rect(x - size / 2, y - size / 2, size, size);
  cctx.fill();
  cctx.stroke();
}

function handlePoint(b, name) {
  const xs = { w: b.x, e: b.x + b.w, n: b.x + b.w / 2, s: b.x + b.w / 2,
               nw: b.x, ne: b.x + b.w, sw: b.x, se: b.x + b.w };
  const ys = { w: b.y + b.h / 2, e: b.y + b.h / 2, n: b.y, s: b.y + b.h,
               nw: b.y, ne: b.y, sw: b.y + b.h, se: b.y + b.h };
  return { x: xs[name], y: ys[name] };
}

// Hit-test: which handle (if any) of the selected shape is at the given point?
function hitHandle(a, px, py) {
  const hs = handleSize();
  const tol = hs * 0.75;
  if (a.type === 'arrow') {
    const x1 = a.x1 * canvas.width, y1 = a.y1 * canvas.height;
    const x2 = a.x2 * canvas.width, y2 = a.y2 * canvas.height;
    if (Math.abs(px - x1) <= tol && Math.abs(py - y1) <= tol) return 'p1';
    if (Math.abs(px - x2) <= tol && Math.abs(py - y2) <= tol) return 'p2';
    return null;
  }
  const b = boundsOf(a);
  const handles = a.type === 'text'
    ? ['nw', 'ne', 'sw', 'se']
    : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  for (const h of handles) {
    const p = handlePoint(b, h);
    if (Math.abs(px - p.x) <= tol && Math.abs(py - p.y) <= tol) return h;
  }
  return null;
}

// Hit-test: which annotation (if any) is under the given point? Topmost first.
function hitAnnotation(px, py) {
  const step = steps[selectedIndex];
  if (!step) return -1;
  for (let i = step.annotations.length - 1; i >= 0; i--) {
    const a = step.annotations[i];
    if (a.type === 'arrow') {
      // Distance from point to segment
      const x1 = a.x1 * canvas.width, y1 = a.y1 * canvas.height;
      const x2 = a.x2 * canvas.width, y2 = a.y2 * canvas.height;
      const d = distPointToSegment(px, py, x1, y1, x2, y2);
      const tol = Math.max(8, canvas.width / 250);
      if (d <= tol) return i;
      continue;
    }
    const b = boundsOf(a);
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return i;
  }
  return -1;
}

function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ─── Mouse → canvas coords ─────────────────────────────────────────────────

function eventToCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

// ─── Drawing new shapes ────────────────────────────────────────────────────

function shapeFromDrag(a, b, tool, color) {
  if (tool === 'rect' || tool === 'highlight' || tool === 'blur') {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 4 || h < 4) return null;
    const shape = {
      type: tool,
      x: x / canvas.width,
      y: y / canvas.height,
      w: w / canvas.width,
      h: h / canvas.height
    };
    if (tool !== 'blur') shape.color = color;
    return shape;
  }
  if (tool === 'arrow') {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 6) return null;
    return {
      type: 'arrow',
      x1: a.x / canvas.width, y1: a.y / canvas.height,
      x2: b.x / canvas.width, y2: b.y / canvas.height,
      color
    };
  }
  return null;
}

// ─── Move / resize ─────────────────────────────────────────────────────────

function moveShape(shape, orig, dx, dy) {
  // dx, dy in canvas pixels — convert back to normalized on assignment.
  if (shape.type === 'arrow') {
    shape.x1 = orig.x1 + dx / canvas.width;
    shape.y1 = orig.y1 + dy / canvas.height;
    shape.x2 = orig.x2 + dx / canvas.width;
    shape.y2 = orig.y2 + dy / canvas.height;
    return;
  }
  shape.x = orig.x + dx / canvas.width;
  shape.y = orig.y + dy / canvas.height;
}

function resizeShape(shape, orig, handle, px, py) {
  if (shape.type === 'arrow') {
    if (handle === 'p1') {
      shape.x1 = px / canvas.width;
      shape.y1 = py / canvas.height;
    } else if (handle === 'p2') {
      shape.x2 = px / canvas.width;
      shape.y2 = py / canvas.height;
    }
    return;
  }
  if (shape.type === 'text') {
    // Uniform resize: scale the font size by diagonal ratio of corner-drag.
    const origBounds = {
      x: orig.x * canvas.width, y: orig.y * canvas.height,
      w: orig._w, h: orig._h
    };
    let newW = origBounds.w, newH = origBounds.h;
    // Fix the opposite corner, move the dragged one
    let fixedX = origBounds.x, fixedY = origBounds.y;
    if (handle === 'se') {
      newW = px - origBounds.x;
      newH = py - origBounds.y;
    } else if (handle === 'ne') {
      newW = px - origBounds.x;
      newH = origBounds.y + origBounds.h - py;
      fixedY = py;
    } else if (handle === 'sw') {
      newW = origBounds.x + origBounds.w - px;
      newH = py - origBounds.y;
      fixedX = px;
    } else if (handle === 'nw') {
      newW = origBounds.x + origBounds.w - px;
      newH = origBounds.y + origBounds.h - py;
      fixedX = px;
      fixedY = py;
    }
    if (newW < 10 || newH < 10) return;
    // Use the width scale for the font — prevents aspect stretching.
    const scale = newW / origBounds.w;
    const newSize = Math.max(10, orig._size * scale);
    shape.size = newSize;
    shape.x = fixedX / canvas.width;
    shape.y = fixedY / canvas.height;
    return;
  }
  // rect / highlight / blur — 8-handle resize
  const o = {
    x: orig.x * canvas.width, y: orig.y * canvas.height,
    w: orig.w * canvas.width, h: orig.h * canvas.height
  };
  let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
  if (handle.includes('w')) { nx = px; nw = o.x + o.w - px; }
  if (handle.includes('e')) { nw = px - o.x; }
  if (handle.includes('n')) { ny = py; nh = o.y + o.h - py; }
  if (handle.includes('s')) { nh = py - o.y; }
  if (nw < 6 || nh < 6) return;
  shape.x = nx / canvas.width;
  shape.y = ny / canvas.height;
  shape.w = nw / canvas.width;
  shape.h = nh / canvas.height;
}

// ─── Cursor feedback in select mode ────────────────────────────────────────

function handleCursorClass(h) {
  if (!h) return '';
  if (h === 'nw' || h === 'se') return 'hover-handle-nwse';
  if (h === 'ne' || h === 'sw') return 'hover-handle-nesw';
  if (h === 'n' || h === 's' || h === 'p1' || h === 'p2') return 'hover-handle-ns';
  if (h === 'e' || h === 'w') return 'hover-handle-ew';
  return '';
}

function setCanvasCursor(cls) {
  canvas.classList.remove(
    'hover-shape', 'hover-handle-nwse', 'hover-handle-nesw',
    'hover-handle-ns', 'hover-handle-ew'
  );
  if (cls) canvas.classList.add(cls);
}

// ─── Pointer handlers ──────────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (selectedIndex < 0) return;
  canvas.focus();
  const p = eventToCanvas(e);

  if (currentTool === 'select') {
    // 1. Clicking a handle of the currently-selected shape → resize
    if (selectedAnn >= 0) {
      const shape = steps[selectedIndex].annotations[selectedAnn];
      const h = hitHandle(shape, p.x, p.y);
      if (h) {
        dragMode = 'resize';
        dragHandle = h;
        dragStart = p;
        // Snapshot the original shape state for delta-based resizing.
        dragOrigShape = snapshot(shape);
        return;
      }
    }
    // 2. Clicking inside an annotation → select + start move
    const hit = hitAnnotation(p.x, p.y);
    if (hit >= 0) {
      selectedAnn = hit;
      dragMode = 'move';
      dragStart = p;
      dragOrigShape = snapshot(steps[selectedIndex].annotations[hit]);
      redraw();
      return;
    }
    // 3. Click on empty space → deselect
    selectedAnn = -1;
    redraw();
    return;
  }

  if (currentTool === 'text') {
    const text = prompt('Label text:');
    if (text && text.trim()) {
      const size = Math.max(20, canvas.width / 50);
      steps[selectedIndex].annotations.push({
        type: 'text',
        x: p.x / canvas.width,
        y: p.y / canvas.height,
        text: text.trim(),
        color: currentColor,
        size
      });
      redraw();
      scheduleSave();
    }
    return;
  }

  // Drawing tools (rect/arrow/highlight/blur)
  dragMode = 'draw';
  dragStart = p;
  dragCurrent = p;
});

canvas.addEventListener('mousemove', (e) => {
  const p = eventToCanvas(e);

  // Cursor hints in select mode
  if (currentTool === 'select' && !dragMode) {
    let cursor = '';
    if (selectedAnn >= 0) {
      const shape = steps[selectedIndex]?.annotations[selectedAnn];
      if (shape) {
        const h = hitHandle(shape, p.x, p.y);
        if (h) cursor = handleCursorClass(h);
      }
    }
    if (!cursor) {
      const hit = hitAnnotation(p.x, p.y);
      if (hit >= 0) cursor = 'hover-shape';
    }
    setCanvasCursor(cursor);
  }

  if (!dragMode) return;
  dragCurrent = p;

  if (dragMode === 'draw') {
    redraw();
  } else if (dragMode === 'move' && selectedAnn >= 0) {
    const shape = steps[selectedIndex].annotations[selectedAnn];
    const dx = p.x - dragStart.x;
    const dy = p.y - dragStart.y;
    moveShape(shape, dragOrigShape, dx, dy);
    redraw();
  } else if (dragMode === 'resize' && selectedAnn >= 0) {
    const shape = steps[selectedIndex].annotations[selectedAnn];
    resizeShape(shape, dragOrigShape, dragHandle, p.x, p.y);
    redraw();
  }
});

window.addEventListener('mouseup', (e) => {
  if (!dragMode) return;
  if (dragMode === 'draw' && dragStart) {
    const end = eventToCanvas(e);
    const shape = shapeFromDrag(dragStart, end, currentTool, currentColor);
    if (shape) {
      steps[selectedIndex].annotations.push(shape);
      selectedAnn = steps[selectedIndex].annotations.length - 1;
      // After drawing, drop back into select mode so the user can adjust.
      setTool('select');
      scheduleSave();
    }
  } else if (dragMode === 'move' || dragMode === 'resize') {
    scheduleSave();
  }
  dragMode = null;
  dragHandle = null;
  dragStart = dragCurrent = dragOrigShape = null;
  redraw();
});

// Delete key removes selected annotation
window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (document.activeElement === descInput || document.activeElement === titleInput) return;
    deleteSelectedAnnotation();
  }
});

function deleteSelectedAnnotation() {
  if (selectedIndex < 0 || selectedAnn < 0) return;
  steps[selectedIndex].annotations.splice(selectedAnn, 1);
  selectedAnn = -1;
  redraw();
  scheduleSave();
}

// Helper: shallow copy of a shape, plus cached bounds for text resize math.
function snapshot(shape) {
  const s = { ...shape };
  if (shape.type === 'text') {
    const b = boundsOf(shape);
    s._w = b.w; s._h = b.h;
    s._size = shape.size || Math.max(20, canvas.width / 50);
  }
  return s;
}

// ─── Toolbar / buttons ─────────────────────────────────────────────────────

function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  canvas.classList.toggle('mode-select', tool === 'select');
  if (tool !== 'select') {
    selectedAnn = -1;
    setCanvasCursor('');
  }
  redraw();
}

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

document.getElementById('undoBtn').addEventListener('click', () => {
  if (selectedIndex < 0) return;
  steps[selectedIndex].annotations.pop();
  selectedAnn = -1;
  redraw();
  scheduleSave();
});

document.getElementById('clearBtn').addEventListener('click', () => {
  if (selectedIndex < 0) return;
  if (steps[selectedIndex].annotations.length === 0) return;
  if (!confirm('Clear all annotations on this step?')) return;
  steps[selectedIndex].annotations = [];
  selectedAnn = -1;
  redraw();
  scheduleSave();
});

document.getElementById('deleteAnnBtn').addEventListener('click', deleteSelectedAnnotation);

descInput.addEventListener('blur', () => {
  if (selectedIndex < 0) return;
  steps[selectedIndex].description = descInput.value;
  renderRail();
  scheduleSave();
});

// ─── AI description-check ──────────────────────────────────────────────────

const descCheckBtn = document.getElementById('descCheckBtn');
const descStatus = document.getElementById('descStatus');

function countWords(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

function clearDescStatusTimer() {
  if (descStatusTimer) { clearTimeout(descStatusTimer); descStatusTimer = null; }
}

function renderDescStatus(state, payload = {}) {
  if (!descStatus) return;
  clearDescStatusTimer();
  descStatus.innerHTML = '';
  descStatus.dataset.state = state;

  if (state === 'idle') {
    descStatus.style.display = 'none';
    return;
  }
  descStatus.style.display = 'flex';

  if (state === 'no-key') {
    descStatus.appendChild(iconFor('info'));
    descStatus.appendChild(document.createTextNode(' Add an AI provider to check descriptions — '));
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'nokey-link';
    link.textContent = 'Set up';
    link.addEventListener('click', () => chrome.runtime.openOptionsPage());
    descStatus.appendChild(link);
    return;
  }
  if (state === 'checking') {
    const sp = document.createElement('span');
    sp.className = 'desc-spinner';
    descStatus.appendChild(sp);
    descStatus.appendChild(document.createTextNode(' Proofreading…'));
    return;
  }
  if (state === 'ok') {
    descStatus.appendChild(iconFor('check'));
    descStatus.appendChild(document.createTextNode(' Reads clearly.'));
    descStatusTimer = setTimeout(() => renderDescStatus('idle'), 4000);
    return;
  }
  if (state === 'suggest') {
    descStatus.appendChild(iconFor('edit'));
    const label = document.createElement('span');
    label.className = 'suggest-reason';
    label.textContent = ' ' + (payload.reason || 'Consider rewording') + (payload.suggestion ? ' — "' + payload.suggestion + '"' : '');
    descStatus.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'actions';
    if (payload.suggestion) {
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'mini-btn apply';
      apply.textContent = 'Apply';
      apply.addEventListener('click', () => applySuggestion(payload.suggestion));
      actions.appendChild(apply);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'mini-btn dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => renderDescStatus('idle'));
    actions.appendChild(dismiss);
    descStatus.appendChild(actions);
    return;
  }
  if (state === 'error') {
    descStatus.appendChild(iconFor('warn'));
    descStatus.appendChild(document.createTextNode(' ' + (payload.message || "Couldn't proofread — try again.")));
    descStatusTimer = setTimeout(() => renderDescStatus('idle'), 5000);
    return;
  }
}

function iconFor(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(ns, 'path');
  if (kind === 'check') path.setAttribute('d', 'M20 6L9 17l-5-5');
  else if (kind === 'warn') path.setAttribute('d', 'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z');
  else if (kind === 'edit') path.setAttribute('d', 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z');
  else path.setAttribute('d', 'M12 16v-4M12 8h.01M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z');
  svg.appendChild(path);
  return svg;
}

function applySuggestion(text) {
  if (selectedIndex < 0 || !text) return;
  descInput.value = text;
  steps[selectedIndex].description = text;
  renderRail();
  scheduleSave();
  // Remember this version is clean so a re-click on Check is cached.
  lastCheckResult.set(text, { ok: true, reason: '', suggestion: '' });
  renderDescStatus('ok');
}

function updateDescUiForCurrentStep() {
  if (!descCheckBtn || !descStatus) return;
  const hasStep = selectedIndex >= 0;

  // Always visible. State is communicated via disabled + tooltip + a data-reason
  // attribute the CSS can style on.
  descCheckBtn.style.display = '';

  if (!hasStep) {
    descCheckBtn.disabled = true;
    descCheckBtn.dataset.reason = 'no-step';
    descCheckBtn.title = 'Select a step to proofread its description';
    renderDescStatus('idle');
    return;
  }
  if (!llmKeyPresent) {
    // Disabled-style, but clickable — click opens Settings as a shortcut.
    descCheckBtn.disabled = false;
    descCheckBtn.dataset.reason = 'no-key';
    descCheckBtn.title = 'Add an AI API key in Settings to enable AI Proofread';
    renderDescStatus('idle');
    return;
  }
  if (countWords(descInput.value) < 4) {
    descCheckBtn.disabled = true;
    descCheckBtn.dataset.reason = 'too-short';
    descCheckBtn.title = 'Write at least 4 words to proofread';
  } else if (checkInFlight) {
    descCheckBtn.disabled = true;
    descCheckBtn.dataset.reason = 'in-flight';
    descCheckBtn.title = 'Proofreading…';
  } else {
    descCheckBtn.disabled = false;
    descCheckBtn.dataset.reason = 'ready';
    descCheckBtn.title = 'Use AI to proofread this step\'s description';
  }

  // If we have a cached verdict for the current text, show it (but don't start auto-hide).
  const cached = lastCheckResult.get(descInput.value);
  if (cached) {
    if (cached.ok) {
      renderDescStatus('idle');
    } else {
      renderDescStatus('suggest', { reason: cached.reason, suggestion: cached.suggestion });
    }
  } else {
    renderDescStatus('idle');
  }
}

descInput.addEventListener('input', () => {
  if (selectedIndex >= 0) {
    steps[selectedIndex].description = descInput.value;
    scheduleSave();
  }
  updateDescUiForCurrentStep();
});

descCheckBtn?.addEventListener('click', async () => {
  // No-key state: clicking jumps to Settings instead of firing a request.
  if (descCheckBtn.dataset.reason === 'no-key') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (selectedIndex < 0) return;
  const text = descInput.value.trim();
  if (countWords(text) < 4) return;

  // Cached?
  const cached = lastCheckResult.get(text);
  if (cached) {
    if (cached.ok) renderDescStatus('ok');
    else renderDescStatus('suggest', { reason: cached.reason, suggestion: cached.suggestion });
    return;
  }

  if (checkInFlight) return;
  checkInFlight = true;
  descCheckBtn.disabled = true;
  renderDescStatus('checking');

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CHECK_DESCRIPTION', text });
    if (resp?.ok && resp.result) {
      const r = resp.result;
      lastCheckResult.set(text, r);
      if (r.ok) renderDescStatus('ok');
      else renderDescStatus('suggest', { reason: r.reason, suggestion: r.suggestion });
    } else {
      const reason = resp?.reason || 'network';
      const msg =
        reason === 'auth' ? 'Auth failed — check your API key.' :
        reason === 'rate-limit' ? 'Rate limit — try again soon.' :
        reason === 'no-key' ? 'Add an AI provider in Settings.' :
        reason === 'bad-custom-url' ? 'Custom provider URL is invalid.' :
        reason === 'parse' ? "Couldn't understand the AI response." :
        "Couldn't proofread — try again.";
      renderDescStatus('error', { message: msg });
    }
  } catch {
    renderDescStatus('error');
  } finally {
    checkInFlight = false;
    updateDescUiForCurrentStep();
  }
});

titleInput.addEventListener('input', () => {
  guideTitle = titleInput.value;
  scheduleSave();
});

document.getElementById('backBtn').addEventListener('click', () => {
  window.close();
});

// ─── Upload / drag-drop custom screenshots as new steps ───────────────────

const addStepBtn = document.getElementById('addStepBtn');
const uploadInput = document.getElementById('uploadInput');
const dropZone = document.getElementById('dropZone');
const browseBtn = document.getElementById('browseBtn');
const dropError = document.getElementById('dropError');
const addModal = document.getElementById('addModal');
const addModalBackdrop = document.getElementById('addModalBackdrop');
const addModalClose = document.getElementById('addModalClose');
const modalDropZone = document.getElementById('modalDropZone');
const modalBrowseBtn = document.getElementById('modalBrowseBtn');
const modalDropError = document.getElementById('modalDropError');

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'
]);

// Magic-number signatures for defense against spoofed file extensions.
// Returns the detected MIME type, or null if it doesn't match any accepted type.
function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const [b0, b1, b2, b3, b4, b5, b6, b7] = bytes;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47 && b4 === 0x0D && b5 === 0x0A && b6 === 0x1A && b7 === 0x0A) return 'image/png';
  // JPEG: FF D8 FF
  if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return 'image/jpeg';
  // GIF: 47 49 46 38 (GIF8)
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return 'image/gif';
  // WEBP: RIFF....WEBP
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
    const b8 = bytes[8], b9 = bytes[9], b10 = bytes[10], b11 = bytes[11];
    if (b8 === 0x57 && b9 === 0x45 && b10 === 0x42 && b11 === 0x50) return 'image/webp';
  }
  // HEIC/HEIF: bytes 4..11 = "ftyp" + brand. Brands: heic, heix, hevc, heim, heis, mif1, msf1, heif
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (['heic','heix','hevc','heim','heis','mif1','msf1','heif'].includes(brand)) return 'image/heic';
  }
  return null;
}

async function convertHeicToJpeg(file) {
  // Use browser-native HEIC decode via createImageBitmap. Chrome on macOS supports
  // this on recent versions; on unsupported browsers it throws and we bail out.
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('HEIC conversion failed')),
      'image/jpeg',
      0.92
    );
  });
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Read failed'));
    reader.readAsDataURL(blob);
  });
}

function showDropError(msg) {
  // Show in whichever drop UI is currently visible.
  const target = (addModal && addModal.style.display !== 'none') ? modalDropError : dropError;
  if (!target) return;
  target.textContent = msg;
  clearTimeout(showDropError._t);
  showDropError._t = setTimeout(() => { target.textContent = ''; }, 5000);
}

function openAddModal() {
  if (!addModal) return;
  addModal.style.display = 'flex';
  if (modalDropError) modalDropError.textContent = '';
}
function closeAddModal() {
  if (!addModal) return;
  addModal.style.display = 'none';
}

async function ingestFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return false;

  const errors = [];
  let addedIndex = -1;

  for (const file of list) {
    // 1. Claimed MIME + size checks
    if (!ACCEPTED_MIME.has(file.type)) {
      errors.push(`${file.name}: unsupported type`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name}: larger than 10 MB`);
      continue;
    }

    // 2. Magic-number sniff on the first 12 bytes
    let headerBytes;
    try {
      headerBytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    } catch {
      errors.push(`${file.name}: could not read file`);
      continue;
    }
    const detected = detectImageType(headerBytes);
    if (!detected) {
      errors.push(`${file.name}: not a recognized image`);
      continue;
    }

    // 3. HEIC → JPEG conversion if needed
    let blobForStep = file;
    if (detected === 'image/heic' || file.type === 'image/heic' || file.type === 'image/heif') {
      try {
        blobForStep = await convertHeicToJpeg(file);
      } catch {
        errors.push(`${file.name}: HEIC isn't supported in this browser — convert to JPG first`);
        continue;
      }
    }

    // 4. Read as data URL and push a step
    let dataUrl;
    try {
      dataUrl = await readAsDataUrl(blobForStep);
    } catch {
      errors.push(`${file.name}: could not encode`);
      continue;
    }

    const newStep = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      stepNumber: steps.length + 1,
      description: '',
      screenshot: dataUrl,
      pageTitle: '',
      url: '',
      elementContext: { tag: 'upload', text: '', pageTitle: '', pageUrl: '' },
      annotations: []
    };
    steps.push(newStep);
    if (addedIndex < 0) addedIndex = steps.length - 1;
  }

  if (errors.length) showDropError(errors.slice(0, 3).join(' · '));
  if (addedIndex >= 0) {
    renumber();
    renderRail();
    selectStep(addedIndex);
    scheduleSave();
    return true;
  }
  return false;
}

// "+ Add" — show the modal drop zone. Users can drop files onto it or click
// "browse files" to open the OS file picker.
addStepBtn.addEventListener('click', () => openAddModal());
if (browseBtn) browseBtn.addEventListener('click', () => uploadInput.click());
if (modalBrowseBtn) modalBrowseBtn.addEventListener('click', () => uploadInput.click());
if (addModalClose) addModalClose.addEventListener('click', closeAddModal);
if (addModalBackdrop) addModalBackdrop.addEventListener('click', closeAddModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && addModal && addModal.style.display !== 'none') closeAddModal();
});

uploadInput.addEventListener('change', async () => {
  const added = await ingestFiles(uploadInput.files);
  uploadInput.value = '';
  if (added) closeAddModal();
});

// Drag-and-drop onto the empty-state drop zone, the modal, and the step rail.
function bindDrop(target, { closeModalOnDrop = false } = {}) {
  if (!target) return;
  const setActive = (on) => target.classList.toggle('drop-active', on);
  target.addEventListener('dragenter', e => { e.preventDefault(); setActive(true); });
  target.addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setActive(true); });
  target.addEventListener('dragleave', e => {
    if (e.target === target) setActive(false);
  });
  target.addEventListener('drop', async e => {
    e.preventDefault();
    setActive(false);
    const added = await ingestFiles(e.dataTransfer?.files);
    if (added && closeModalOnDrop) closeAddModal();
  });
}
bindDrop(dropZone);
bindDrop(modalDropZone, { closeModalOnDrop: true });
bindDrop(document.getElementById('rail'));

// Block the browser's default "open file" behavior if the user misses the drop zone.
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop',     e => { e.preventDefault(); });


// ─── Export: flatten a step to an offscreen canvas ─────────────────────────

function renderStepToCanvas(step) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cctx = c.getContext('2d');
      cctx.drawImage(img, 0, 0);
      for (const a of (step.annotations || [])) {
        drawAnnotationOn(cctx, c, a, img);
      }
      resolve(c);
    };
    img.onerror = reject;
    img.src = step.screenshot;
  });
}

// ─── PDF export ────────────────────────────────────────────────────────────

document.getElementById('exportPdfBtn').addEventListener('click', exportPDF);

async function exportPDF() {
  if (steps.length === 0) { alert('No steps to export.'); return; }
  const btn = document.getElementById('exportPdfBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Generating PDF...';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const pageW = 210, pageH = 297, margin = 16;
    const contentW = pageW - margin * 2;

    // Cover
    doc.setFillColor(15, 17, 23);
    doc.rect(0, 0, pageW, pageH, 'F');
    doc.setTextColor(99, 102, 241);
    doc.setFontSize(28);
    doc.setFont('helvetica', 'bold');
    doc.text('Step-by-Step Guide', margin, 60);

    doc.setTextColor(232, 234, 240);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'normal');
    const title = (guideTitle || steps[0]?.pageTitle || 'Recorded Workflow');
    const titleLines = doc.splitTextToSize(title, contentW);
    doc.text(titleLines, margin, 76);

    doc.setTextColor(107, 114, 128);
    doc.setFontSize(11);
    doc.text(`${steps.length} steps  ·  Generated by Trailmark  ·  ${new Date().toLocaleDateString()}`, margin, 96);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      doc.addPage();
      doc.setFillColor(248, 249, 251);
      doc.rect(0, 0, pageW, pageH, 'F');

      let y = margin;
      doc.setFillColor(99, 102, 241);
      doc.roundedRect(margin, y, 28, 8, 2, 2, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text(`STEP ${i + 1}`, margin + 4, y + 5.5);
      y += 14;

      doc.setTextColor(15, 17, 23);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      const descLines = doc.splitTextToSize(step.description || '', contentW);
      doc.text(descLines, margin, y);
      y += descLines.length * 7 + 8;

      doc.setTextColor(107, 114, 128);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      const urlText = step.pageTitle || step.url || '';
      doc.text(urlText.slice(0, 80), margin, y);
      y += 8;

      try {
        const flat = await renderStepToCanvas(step);
        const imgData = flat.toDataURL('image/png');
        const imgProps = doc.getImageProperties(imgData);
        const imgW = contentW;
        const imgH = (imgProps.height / imgProps.width) * imgW;
        const maxImgH = pageH - y - margin - 10;
        const finalH = Math.min(imgH, maxImgH);
        doc.setDrawColor(220, 220, 230);
        doc.setLineWidth(0.3);
        doc.roundedRect(margin, y, imgW, finalH, 3, 3, 'S');
        doc.addImage(imgData, 'PNG', margin, y, imgW, finalH);
        y += finalH + 6;
      } catch (err) {
        console.error('PDF: failed to render step image', err);
      }

      doc.setTextColor(180, 180, 190);
      doc.setFontSize(8);
      doc.text(`${i + 1} / ${steps.length}`, pageW - margin, pageH - 8, { align: 'right' });
      doc.text('Generated by Trailmark', margin, pageH - 8);
    }

    doc.save(`trailmark-guide-${Date.now()}.pdf`);
  } catch (err) {
    console.error(err);
    alert('PDF export failed — check the console.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ─── Markdown export (+ separate PNG files) ────────────────────────────────

document.getElementById('exportMdBtn').addEventListener('click', exportMarkdown);

function slugify(s) {
  return String(s || 'guide')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'guide';
}

async function exportMarkdown() {
  if (steps.length === 0) { alert('No steps to export.'); return; }
  const btn = document.getElementById('exportMdBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const title = (guideTitle || steps[0]?.pageTitle || 'Recorded Workflow');
    const date = new Date().toLocaleDateString();
    const folder = `trailmark-${slugify(title)}-${Date.now()}`;

    // Pre-render every step to a flattened canvas so we can download + reference.
    const flats = [];
    for (const step of steps) flats.push(await renderStepToCanvas(step));

    const padLen = String(steps.length).length;
    const filenameFor = (i) => `step-${String(i + 1).padStart(padLen, '0')}.png`;

    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`_Recorded with Trailmark · ${steps.length} steps · ${date}_`);
    lines.push('');
    lines.push('## Instructions for a browser agent');
    lines.push('');
    lines.push('You are being given a recorded click-through. Replay each step in order on the page whose URL matches `page_url`. For every step: navigate to `page_url` if you are not already there, locate the element described under **Target element** using the hints in priority order (visible text → aria-label → role+text → href → tag+nearest text), and perform the action described in **Action**. The screenshot shows what the page looked like immediately before the click.');
    lines.push('');
    lines.push('---');
    lines.push('');

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const ec = step.elementContext || {};
      const imgName = filenameFor(i);

      lines.push(`## Step ${i + 1} — ${escapeMdInline(step.description || '')}`);
      lines.push('');
      if (step.pageTitle) lines.push(`- **Page title:** ${escapeMdInline(step.pageTitle)}`);
      if (step.url) lines.push(`- **Page URL:** ${step.url}`);
      lines.push(`- **Action:** ${escapeMdInline(step.description || '')}`);
      lines.push('');

      const fields = [
        ['tag', ec.tag],
        ['visible text', ec.text],
        ['aria-label', ec.ariaLabel],
        ['role', ec.role],
        ['placeholder', ec.placeholder],
        ['input type', ec.type],
        ['href', ec.href],
        ['id', ec.id],
        ['class', ec.className],
      ].filter(([, v]) => v && String(v).trim().length > 0);

      if (fields.length > 0) {
        lines.push('**Target element**');
        lines.push('');
        lines.push('| field | value |');
        lines.push('|---|---|');
        for (const [k, v] of fields) {
          lines.push(`| ${k} | \`${String(v).replace(/\|/g, '\\|').replace(/`/g, '\\`')}\` |`);
        }
        lines.push('');
      }

      lines.push('**Screenshot**');
      lines.push('');
      lines.push(`![Step ${i + 1}](./${imgName})`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    // Download the markdown itself
    const mdBlob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const mdUrl = URL.createObjectURL(mdBlob);
    await chrome.downloads.download({
      url: mdUrl,
      filename: `${folder}/guide.md`,
      saveAs: false
    });

    // Download each step screenshot into the same folder
    for (let i = 0; i < flats.length; i++) {
      const pngUrl = flats[i].toDataURL('image/png');
      await chrome.downloads.download({
        url: pngUrl,
        filename: `${folder}/${filenameFor(i)}`,
        saveAs: false
      });
    }

    setTimeout(() => URL.revokeObjectURL(mdUrl), 10_000);
    alert(`Exported ${steps.length + 1} files to Downloads/${folder}/`);
  } catch (err) {
    console.error(err);
    alert('Markdown export failed — check the console.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ─── Word (.doc) export ────────────────────────────────────────────────────

document.getElementById('exportDocBtn').addEventListener('click', exportWord);

// Generate a Word-compatible HTML document with an MSO header. Word, Pages,
// and Google Docs will all open this as a rich document with inline images.
async function exportWord() {
  if (steps.length === 0) { alert('No steps to export.'); return; }
  const btn = document.getElementById('exportDocBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const title = (guideTitle || steps[0]?.pageTitle || 'Recorded Workflow');
    const date = new Date().toLocaleDateString();

    const parts = [];
    parts.push(`<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument>
</xml>
<![endif]-->
<style>
  @page { size: A4; margin: 2cm; }
  body { font-family: Calibri, Arial, sans-serif; color: #1a1a1a; font-size: 11pt; line-height: 1.5; }
  .cover { page-break-after: always; }
  .eyebrow {
    color: #6b7280; font-size: 11pt; font-weight: bold;
    letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 6pt;
  }
  h1 { font-size: 26pt; color: #4f46e5; margin: 0 0 4pt 0; }
  h2 { font-size: 14pt; color: #1a1a1a; margin: 0 0 6pt; page-break-after: avoid; page-break-inside: avoid; }
  .sub { color: #6b7280; font-size: 10pt; margin-bottom: 12pt; }
  .step-badge {
    color: #4f46e5; font-size: 9pt; font-weight: bold;
    letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4pt;
  }
  .step-meta { color: #6b7280; font-size: 9pt; margin-bottom: 6pt; }
  .step-img { border: 1pt solid #d1d5db; margin: 6pt 0 12pt; page-break-before: avoid; }
  .divider { border: none; border-top: 1pt solid #e5e7eb; margin: 18pt 0; }
</style>
</head>
<body>`);

    parts.push('<div class="cover">');
    parts.push('<div class="eyebrow">Step-by-Step Guide</div>');
    parts.push(`<h1>${escapeHtml(title)}</h1>`);
    parts.push(`<div class="sub">${steps.length} steps · Generated by Trailmark · ${date}</div>`);
    parts.push('</div>');

    // Match the PDF's content-area sizing so screenshots don't bleed past the
    // page margins or take over a whole page.
    const WORD_CONTENT_W_CM = 17.0;  // A4 width (21cm) minus 2cm margins × 2
    const WORD_MAX_IMG_H_CM = 19.5;  // Leaves headroom for the h2 + meta line

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const flat = await renderStepToCanvas(step);
      const dataUrl = flat.toDataURL('image/png');

      // Size the image in cm so Word lays it out the same way the PDF does,
      // regardless of the raw pixel dimensions coming out of renderStepToCanvas.
      const ratio = flat.height / flat.width;
      let imgWcm = WORD_CONTENT_W_CM;
      let imgHcm = imgWcm * ratio;
      if (imgHcm > WORD_MAX_IMG_H_CM) {
        imgHcm = WORD_MAX_IMG_H_CM;
        imgWcm = imgHcm / ratio;
      }
      // Word also honors explicit width/height HTML attributes (in px) as a
      // belt-and-suspenders fallback — 1cm ≈ 37.795px at 96dpi.
      const imgWpx = Math.round(imgWcm * 37.795);
      const imgHpx = Math.round(imgHcm * 37.795);

      if (i > 0) parts.push('<hr class="divider" />');
      parts.push(`<div class="step-badge">STEP ${i + 1}</div>`);
      parts.push(`<h2>${escapeHtml(step.description || '')}</h2>`);
      if (step.pageTitle || step.url) {
        parts.push(`<div class="step-meta">${escapeHtml(step.pageTitle || '')}${step.url ? ' · ' + escapeHtml(step.url) : ''}</div>`);
      }
      parts.push(
        `<img class="step-img" src="${dataUrl}" alt="Step ${i + 1}" ` +
        `width="${imgWpx}" height="${imgHpx}" ` +
        `style="width:${imgWcm.toFixed(2)}cm;height:${imgHcm.toFixed(2)}cm;" />`
      );
    }

    parts.push('</body></html>');

    const blob = new Blob([parts.join('\n')], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: `trailmark-guide-${Date.now()}.doc`,
      saveAs: true
    });
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    console.error(err);
    alert('Word export failed — check the console.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ─── Utils ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeMdInline(str) {
  return String(str ?? '').replace(/\r?\n/g, ' ').trim();
}

// ─── Boot ──────────────────────────────────────────────────────────────────

load();
