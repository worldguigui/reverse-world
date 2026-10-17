/**
 * 工坊的会话数据：栅格网格、撤销栈、绘制标志，以及打开期间才有效的那组回调。
 *
 * 这些都不进 store：网格是几十万个浮点的 buffer，撤销栈又存着它的快照，
 * 一旦进 store 就会被快照式更新反复拷贝，也会让整块面板每画一笔重画一次。
 * store 里只留三个廉价的布尔量（canUndo/canRedo）供按钮显示可用态。
 */
import { useStore } from '../store/index.js';

export const workshop = {
  grid: null,        // 正在编辑的 TerrainGrid（由打开方决定是克隆还是直接绑定）
  binding: null,     // 直接编辑已存在的地图时记下 { rmapId }
  hooks: null,       // { onChange, onCommit, onCancel, loadRealEarth }
  undoStack: [],
  redoStack: [],
  painting: false,   // 指针是否按住（按住拖动时连续涂抹）
  dirty: false,      // 本次打开后是否真的改过
  previewed: false,  // 球体是否已经建过预览纹理

  canvas: null,      // 正在画的那张画布（网格自带，挂进 .wk-stage）
  wrap: null,        // 画布容器，缩放/平移都相对它算
  maskCanvas: null,  // 水陆掩膜预览：黑=陆地，白=水
  maskCtx: null,
  maskImage: null,   // 掩膜的 ImageData，随网格尺寸重建
  // 视图：zoom 是相对「适应窗口」的倍数，tx/ty 是画布左上角相对容器的偏移（屏幕像素）
  view: { zoom: 1, tx: 0, ty: 0 },
};

/** 撤销步数：网格越大，一份快照越贵（快照 = 高度 + 水两份数组） */
const undoLimit = () => (workshop.grid?.w >= 1024 ? 8 : 15);

/** 笔刷大小上限的基准格数，以及它是在多宽的栅格上调出来的 */
const BRUSH_MAX_CELLS = 48;
const BRUSH_REF_W = 512;

/**
 * 笔刷大小上限（格）。
 *
 * 「格」是相对单位：同样 48 格，栅格宽一倍，盖住的地面就只剩一半。
 * 按栅格宽度缩放上限，滑块两端盖住的地面范围才与分辨率无关——
 * 否则换一档分辨率，同一支笔就成了另一支笔。
 */
export const brushSizeMax = () => Math.round(
  (BRUSH_MAX_CELLS * (workshop.grid?.w ?? BRUSH_REF_W)) / BRUSH_REF_W,
);

/** 把撤销/重做的可用态同步给按钮 */
function syncFlags() {
  useStore.getState().setWorkshopFlags({
    canUndo: workshop.undoStack.length > 0,
    canRedo: workshop.redoStack.length > 0,
  });
}

export function beginWorkshop({ grid, binding = null, hooks }) {
  workshop.grid = grid;
  workshop.binding = binding;
  workshop.hooks = hooks;
  workshop.undoStack = [];
  workshop.redoStack = [];
  workshop.painting = false;
  workshop.dirty = false;
  workshop.previewed = false;
  workshop.view = { zoom: 1, tx: 0, ty: 0 };
  workshop.maskImage = null;
  fitted = false;
  syncFlags();
}

export function endWorkshop() {
  workshop.grid = null;
  workshop.binding = null;
  workshop.hooks = null;
  workshop.undoStack = [];
  workshop.redoStack = [];
  workshop.painting = false;
  workshop.maskCanvas = null;
  workshop.maskCtx = null;
  workshop.maskImage = null;
}

// ---------------------------------------------------------------- 画布视图（缩放 / 平移）

/** 「适应窗口」的比例：一格占多少屏幕像素 */
let fitScale = 1;
/** 缩放上限：一格铺到 32 屏幕像素已经很够抠细节了 */
const MAX_ZOOM = 32;
/** 缩放下限就是「适应窗口」本身——再小就只能看黑边了 */
const MIN_ZOOM = 1;
/** 是否已经量过容器、算出了适应窗口的比例（容器还没布局时量不出来） */
let fitted = false;

/** 当前实际比例 */
const scaleOf = () => fitScale * workshop.view.zoom;

/** 把视图状态写到画布上。画布是网格自带的节点，只能命令式改样式 */
function applyView() {
  const { canvas, maskCanvas, view } = workshop;
  if (!canvas) return;
  const s = scaleOf();
  const transform = `translate(${view.tx}px, ${view.ty}px) scale(${s})`;
  const rendering = s >= 1 ? 'pixelated' : 'auto';
  canvas.style.transform = transform;
  // 一格一像素，放大时该用最近点：格子边界要像刀切一样清楚。
  // 缩小时（画布比容器宽——分辨率一高，适应窗口那一档就是缩小）最近点会丢行丢列，
  // 满是细线与色带的地图会抖成一片；这一档交回浏览器的平滑缩放。
  canvas.style.imageRendering = rendering;
  // 掩膜是叠在同一位置上的另一张画布，必须跟画布共享同一套平移与缩放
  if (maskCanvas) {
    maskCanvas.style.transform = transform;
    maskCanvas.style.imageRendering = rendering;
  }
}

/** 缩放倍数同步给顶栏读数。平移不动缩放，所以只有缩放路径调它 */
function syncZoom() {
  const st = useStore.getState();
  if (st.workshopZoom !== workshop.view.zoom) st.setWorkshopZoom(workshop.view.zoom);
}

/** 按容器大小重算「适应窗口」，并把画布摆在正中 */
export function fitView() {
  const { wrap, grid } = workshop;
  if (!canvasReady() || wrap.clientWidth < 2 || wrap.clientHeight < 2) return;
  fitScale = Math.min(wrap.clientWidth / grid.w, wrap.clientHeight / grid.h) || 1;
  fitted = true;
  workshop.view.zoom = 1;
  centerView();
  syncZoom();
}

function centerView() {
  const { wrap, grid, view } = workshop;
  const s = scaleOf();
  view.tx = (wrap.clientWidth - grid.w * s) / 2;
  view.ty = (wrap.clientHeight - grid.h * s) / 2;
  applyView();
}

/** 拖动平移：屏幕像素增量直接加到偏移上 */
function panBy(dx, dy) {
  workshop.view.tx += dx;
  workshop.view.ty += dy;
  applyView();
}

/**
 * 以某个屏幕位置为锚点缩放：光标底下的那一格保持不动，
 * 所以「滚轮推近 → 想放大的地方正好在光标下面」。
 * 只用到画布自己的 rect，不必关心它在容器里的边距/边框。
 */
function zoomAt(clientX, clientY, factor) {
  const { canvas, view } = workshop;
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  if (next === view.zoom) return;
  const r = canvas.getBoundingClientRect();
  const s = scaleOf();
  const lx = (clientX - r.left) / s; // 锚点在画布本地坐标里的位置
  const ly = (clientY - r.top) / s;
  view.zoom = next;
  const s2 = scaleOf();
  view.tx += (clientX - r.left) - lx * s2;
  view.ty += (clientY - r.top) - ly * s2;
  applyView();
  syncZoom();
}

/** 容器尺寸变了（窗口缩放）：重算适应比例，并让容器中心处的那一格留在原地 */
function reflow() {
  const { wrap, grid, view } = workshop;
  if (!canvasReady() || wrap.clientWidth < 2 || wrap.clientHeight < 2) return;
  if (!fitted) { fitView(); return; } // 挂画布时容器还没布局，这里补上第一次
  const s = scaleOf();
  const cx = wrap.clientWidth / 2;
  const cy = wrap.clientHeight / 2;
  const lx = (cx - view.tx) / s;
  const ly = (cy - view.ty) / s;
  fitScale = Math.min(wrap.clientWidth / grid.w, wrap.clientHeight / grid.h) || 1;
  const s2 = scaleOf();
  view.tx = cx - lx * s2;
  view.ty = cy - ly * s2;
  applyView();
}

const canvasReady = () => !!(workshop.canvas && workshop.wrap && workshop.grid);

// ---------------------------------------------------------------- 撤销 / 重做

const snapshot = () => ({ h: workshop.grid.height.slice(), w: workshop.grid.water.slice() });

function pushUndo() {
  workshop.undoStack.push(snapshot());
  if (workshop.undoStack.length > undoLimit()) workshop.undoStack.shift();
  workshop.redoStack.length = 0;
  syncFlags();
}

function restore(snap) {
  const g = workshop.grid;
  g.height.set(snap.h);
  g.water.set(snap.w);
  g.renderColor();
  drawMask();
  workshop.hooks.onChange(g);
}

export function undo() {
  if (!workshop.undoStack.length) return;
  workshop.redoStack.push(snapshot());
  restore(workshop.undoStack.pop());
  syncFlags();
}

export function redo() {
  if (!workshop.redoStack.length) return;
  workshop.undoStack.push(snapshot());
  restore(workshop.redoStack.pop());
  syncFlags();
}

// ---------------------------------------------------------------- 整块操作

export function resetOcean() {
  pushUndo();
  workshop.grid.fill(-0.45, 255);
  drawMask();
  workshop.dirty = true;
  workshop.hooks.onChange(workshop.grid);
}

/** 用真实地球高程覆盖整张网格（下载解码由调用方提供） */
export async function copyFromRealEarth() {
  pushUndo();
  const real = await workshop.hooks.loadRealEarth();
  workshop.grid.copyFrom(real);
  drawMask();
  workshop.dirty = true;
  workshop.hooks.onChange(workshop.grid);
}

// ---------------------------------------------------------------- 水陆掩膜预览

/**
 * 把水通道画成黑白图：黑=陆地，白=水。
 * 只在打开「查看水陆掩膜」时画；传 rect 只重绘脏区，和颜色画布一样便宜。
 */
function drawMask(rect) {
  const { maskCanvas, maskCtx, grid } = workshop;
  if (!maskCanvas || !maskCtx || !grid) return;
  if (!useStore.getState().workshopShowWater) return;
  if (!workshop.maskImage || workshop.maskImage.width !== grid.w || workshop.maskImage.height !== grid.h) {
    workshop.maskImage = maskCtx.createImageData(grid.w, grid.h);
  }
  const img = workshop.maskImage;
  const data = img.data;
  const x0 = rect ? Math.max(0, rect[0] - 1) : 0;
  const y0 = rect ? Math.max(0, rect[1] - 1) : 0;
  const x1 = rect ? Math.min(grid.w - 1, rect[0] + rect[2] + 1) : grid.w - 1;
  const y1 = rect ? Math.min(grid.h - 1, rect[1] + rect[3] + 1) : grid.h - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * grid.w + x;
      const v = grid.water[i];
      const o = i * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  maskCtx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

/** 开关切换后同步掩膜画布的显隐；React 只负责改 store 里的布尔量 */
export function syncMaskView() {
  const { maskCanvas } = workshop;
  if (!maskCanvas) return;
  const on = useStore.getState().workshopShowWater;
  maskCanvas.style.display = on ? 'block' : 'none';
  if (on) drawMask();
}

// ---------------------------------------------------------------- 指针绘制

/**
 * 屏幕坐标 → 网格坐标。
 * rect 取的是**变换后**的矩形（含 scale 与 translate），所以缩放平移之后
 * 这条按比例换算照样成立，不用另外记一份视图变换的逆。
 */
function toGrid(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return [
    ((e.clientX - rect.left) / rect.width) * workshop.grid.w,
    ((e.clientY - rect.top) / rect.height) * workshop.grid.h,
  ];
}

/** 画一笔。画笔参数每次现取 store 里的值，免得闭包留住旧参数 */
function paint(canvas, e) {
  const st = useStore.getState();
  // 笔刷大小是跨网格留在 store 里的，可能来自上一张更宽的网格；夹到当前上限再落笔
  const size = Math.min(st.workshopSize, brushSizeMax());
  const [gx, gy] = toGrid(canvas, e);
  const g = workshop.grid;
  const dirty = g.applyBrush(st.workshopTool, gx, gy, size, st.workshopStrength, st.workshopHard);
  if (!dirty) return;
  g.renderColor(dirty);
  drawMask(dirty);
  workshop.dirty = true;
  workshop.hooks.onChange(g);
}

/** 滚轮一格大约 100，换算成缩放倍率的指数底；调这个就是调「滚一格放大多少」 */
const WHEEL_K = 0.0015;

/**
 * 给画布装上指针事件（涂抹 + 平移）与滚轮缩放，并算好初始视图。
 * 画布本身是网格自带的 DOM 节点、由调用方插进页面，不是 React 元素，
 * 所以这里用命令式绑定；返回解绑函数。
 * @param {HTMLCanvasElement} canvas 网格的 colorCanvas
 * @param {HTMLElement} wrap .wk-stage，画布的定位容器
 */
export function attachCanvas(canvas, wrap) {
  workshop.canvas = canvas;
  workshop.wrap = wrap;
  // 一格一个 CSS 像素；缩放全靠 transform，不动 canvas 的分辨率（那会重采样，糊）
  canvas.style.width = `${workshop.grid.w}px`;
  canvas.style.height = `${workshop.grid.h}px`;
  // 水陆掩膜是叠在颜色画布上的第二张画布：同一套平移缩放，像素一一对应。
  // 每格一个 CSS 像素，和颜色画布一致；显隐由 syncMaskView 按开关切换
  const mask = document.createElement('canvas');
  mask.width = workshop.grid.w;
  mask.height = workshop.grid.h;
  mask.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;'
    + 'pointer-events:none;display:none;'
    + `width:${workshop.grid.w}px;height:${workshop.grid.h}px;`;
  wrap.appendChild(mask);
  workshop.maskCanvas = mask;
  workshop.maskCtx = mask.getContext('2d', { willReadFrequently: true });
  workshop.maskImage = null;
  fitView();
  syncMaskView();

  let panning = null; // 正在平移时记上一个指针位置

  const onDown = (e) => {
    // 中键 / 右键 / Shift+左键 = 平移；左键 = 涂抹
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      panning = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    pushUndo(); // 一笔一档：撤销回到这一笔之前
    workshop.painting = true;
    paint(canvas, e);
  };

  const onMove = (e) => {
    if (panning) {
      panBy(e.clientX - panning.x, e.clientY - panning.y);
      panning.x = e.clientX;
      panning.y = e.clientY;
      return;
    }
    if (workshop.painting) paint(canvas, e);
  };

  const onUp = () => {
    workshop.painting = false;
    panning = null;
    canvas.style.cursor = '';
  };

  const onWheel = (e) => {
    e.preventDefault(); // 不然页面（或底下的相机）也跟着滚
    // deltaMode=1 是按「行」滚的浏览器，换算成像素再看齐
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * WHEEL_K));
  };

  const onContext = (e) => e.preventDefault(); // 右键要用来平移，不出菜单

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);

  // 拖窗口时容器会变宽变高，「适应窗口」的比例跟着变，否则图会飘到视野外
  const ro = new ResizeObserver(() => reflow());
  ro.observe(wrap);

  return () => {
    ro.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContext);
    mask.remove();
    workshop.canvas = null;
    workshop.wrap = null;
    workshop.maskCanvas = null;
    workshop.maskCtx = null;
    workshop.maskImage = null;
  };
}

// ---------------------------------------------------------------- 收尾

/** 完成：把网格交回调用方保存 */
export function commitWorkshop() {
  const g = workshop.grid;
  const done = workshop.hooks.onCommit;
  endWorkshop();
  done(g);
}

/** 取消：交回网格与「是否改过」，由调用方决定怎么恢复 */
export function cancelWorkshop() {
  const g = workshop.grid;
  const { dirty } = workshop;
  const done = workshop.hooks.onCancel;
  endWorkshop();
  done(g, dirty);
}
