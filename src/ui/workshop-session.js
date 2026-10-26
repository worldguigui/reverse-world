/**
 * 工坊的会话数据：栅格网格、撤销栈、绘制标志，以及打开期间才有效的那组回调。
 *
 * 这些都不进 store：网格是几十万个浮点的 buffer，撤销栈又存着它的快照，
 * 一旦进 store 就会被快照式更新反复拷贝，也会让整块面板每画一笔重画一次。
 * store 里只留三个廉价的布尔量（canUndo/canRedo）供按钮显示可用态。
 */
import { useStore } from '../store/index.js';
import { hexTo565 } from '../core/raster.js';
import { slerpLatLng, vec3ToLatLng } from '../utils.js';
import { OVERLAY_BASE, OVERLAY_BORDER } from '../view/overlay-palette.js';

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
  overlayCanvas: null, // 已有路线/区域的只读参考层（屏幕坐标重绘）
  overlayCtx: null,
  brushEl: null,     // 跟着指针走的笔刷范围框（屏幕坐标）
  pointer: null,     // 最近一次指针在画布上的位置（clientX/clientY）
  brushVisible: false, // 指针是否在画布上；平移、离开画布时框要收起来
  overlayRev: -1,      // 路径缓存对应的项目版本；项目一改就重建
  overlayRegions: [],  // [{ path: Path2D, color: string|null }]，坐标是栅格像素
  overlayRoutes: [],
  // 视图：zoom 是相对「适应窗口」的倍数，tx/ty 是画布左上角相对容器的偏移（屏幕像素）
  view: { zoom: 1, tx: 0, ty: 0 },
};

/** 撤销步数：网格越大，一份快照越贵（快照 = 高度 + 颜色两份数组） */
const undoLimit = () => (workshop.grid?.w >= 1024 ? 8 : 15);

/** 笔刷大小上限的基准格数，以及它是在多宽的栅格上调出来的 */
const BRUSH_MAX_CELLS = 48;
const BRUSH_REF_W = 512;

/**
 * 笔刷大小上限（格，奇数）。
 *
 * 「格」是相对单位：同样 48 格，栅格宽一倍，盖住的地面就只剩一半。
 * 按栅格宽度缩放上限，滑块两端盖住的地面范围才与分辨率无关——
 * 否则换一档分辨率，同一支笔就成了另一支笔。
 */
export const brushSizeMax = () => {
  const n = Math.round(
    (BRUSH_MAX_CELLS * (workshop.grid?.w ?? BRUSH_REF_W)) / BRUSH_REF_W,
  );
  // 滑块只能停在奇数上；上限也取奇数，免得上限本身选不到
  return Math.max(1, n % 2 === 1 ? n : n - 1);
};

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
  // 每次打开的网格可能换了一张，上一轮按旧网格尺寸算好的路径不能再用
  workshop.overlayRev = -1;
  workshop.overlayRegions = [];
  workshop.overlayRoutes = [];
  fitted = false;
  syncFlags();
  // 打开时先把当前网格交给球面：新地图还没落第一笔，预览里也该是那片汪洋
  hooks.onChange?.(grid);
}

export function endWorkshop() {
  workshop.grid = null;
  workshop.binding = null;
  workshop.hooks = null;
  workshop.undoStack = [];
  workshop.redoStack = [];
  workshop.painting = false;
  workshop.overlayCanvas = null;
  workshop.overlayCtx = null;
  workshop.brushEl = null;
  workshop.pointer = null;
  workshop.brushVisible = false;
  workshop.overlayRev = -1;
  workshop.overlayRegions = [];
  workshop.overlayRoutes = [];
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
  const { canvas, view } = workshop;
  if (!canvas) return;
  const s = scaleOf();
  const transform = `translate(${view.tx}px, ${view.ty}px) scale(${s})`;
  const rendering = s >= 1 ? 'pixelated' : 'auto';
  canvas.style.transform = transform;
  // 一格一像素，放大时该用最近点：格子边界要像刀切一样清楚。
  // 缩小时（画布比容器宽——分辨率一高，适应窗口那一档就是缩小）最近点会丢行丢列，
  // 满是细线与色带的地图会抖成一片；这一档交回浏览器的平滑缩放。
  canvas.style.imageRendering = rendering;
  // 路线/区域参考层按屏幕坐标重画，不吃这个 transform：平移缩放后要重新算一遍落点
  drawRouteOverlay();
  // 笔刷框也按屏幕坐标摆放；缩放、平移后要跟着重新量
  updateBrush();
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

const snapshot = () => ({ h: workshop.grid.height.slice(), c: workshop.grid.color.slice() });

/** 把一份已经拍好的快照压进撤销栈；异步操作要在结果确认有效之后再调用 */
function pushSnapshot(snap) {
  workshop.undoStack.push(snap);
  if (workshop.undoStack.length > undoLimit()) workshop.undoStack.shift();
  workshop.redoStack.length = 0;
  syncFlags();
}

function pushUndo() {
  pushSnapshot(snapshot());
}

function restore(snap) {
  const g = workshop.grid;
  g.height.set(snap.h);
  g.color.set(snap.c);
  g.renderColor();
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
  workshop.grid.fill(-0.45, hexTo565(useStore.getState().workshopOceanColor));
  workshop.dirty = true;
  workshop.hooks.onChange(workshop.grid);
}

/** 整图填成海平面以上的平地，颜色用陆地预设色；与重置为海洋共用同一套填充与撤销 */
export function resetLand() {
  pushUndo();
  workshop.grid.fill(0.2, hexTo565(useStore.getState().workshopLandColor));
  workshop.dirty = true;
  workshop.hooks.onChange(workshop.grid);
}

/**
 * 用真实地球高程覆盖整张网格（下载解码由调用方提供）。
 * 返回 false 表示等待期间已经关闭工坊或换了另一张网格，这次结果被丢弃。
 */
export async function copyFromRealEarth() {
  const grid = workshop.grid;
  const load = workshop.hooks?.loadRealEarth;
  if (!grid || !load) return false;
  // 撤销步要在覆盖之前拍；但等数据回来、确认仍是同一张网格之后才入栈，
  // 否则关掉工坊会留下一个指向已结束会话的空撤销步
  const before = snapshot();
  const real = await load();
  if (workshop.grid !== grid) return false;
  pushSnapshot(before);
  grid.copyFrom(real);
  workshop.dirty = true;
  workshop.hooks.onChange(grid);
  return true;
}

// ---------------------------------------------------------------- 路线 / 区域参考层

const DEG = Math.PI / 180;

/**
 * 往 Path2D 里接一段大圆弧（经纬度已是栅格像素）。
 * 与球面路线层用同一套球面插值：相邻途经点之间走最短弧，而不是地图上的直线，
 * 这样照着参考层画出来的地形，贴到球上仍与路线对得齐。
 */
function appendArc(path, a, b, xOf, yOf) {
  const cos = Math.sin(a.lat * DEG) * Math.sin(b.lat * DEG) +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lng - a.lng) * DEG);
  const angle = Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
  const steps = Math.max(1, Math.ceil(angle / 2)); // 细分到 ≤2°，与球面路线一致
  let prevLng = a.lng;
  for (let s = 1; s <= steps; s++) {
    const { lat, lng: rawLng } = vec3ToLatLng(slerpLatLng(a.lat, a.lng, b.lat, b.lng, s / steps));
    // 跨 ±180° 时按短弧把经度接到前一点附近，避免一条线横穿整张地图
    let lng = rawLng;
    while (lng - prevLng > 180) lng -= 360;
    while (prevLng - lng > 180) lng += 360;
    prevLng = lng;
    path.lineTo(xOf(lng), yOf(lat));
  }
}

/**
 * 把路线/区域的路径预先算成栅格像素坐标（Path2D）。
 * 平移与缩放只改画布的 transform，不必每帧重新遍历所有顶点。
 */
function buildOverlayPaths() {
  const { grid } = workshop;
  const st = useStore.getState();
  const project = st.project;
  workshop.overlayRegions = [];
  workshop.overlayRoutes = [];
  workshop.overlayRev = st.contentRev;
  if (!grid || !project) return;

  // 整张栅格就是等经纬投影：x 从 -180° 铺到 180°，y 从 90° 铺到 -90°
  const xOf = (lng) => ((lng + 180) / 360) * grid.w;
  const yOf = (lat) => ((90 - lat) / 180) * grid.h;

  for (const region of project.regions) {
    const ring = region.ring;
    if (!ring || ring.length < 3) continue;
    const path = new Path2D();
    path.moveTo(xOf(ring[0][0]), yOf(ring[0][1]));
    for (let i = 1; i < ring.length; i++) path.lineTo(xOf(ring[i][0]), yOf(ring[i][1]));
    path.closePath();
    workshop.overlayRegions.push({ path, color: region.color ?? null });
  }

  for (const route of project.routes) {
    const points = route.points;
    if (!points || points.length < 2) continue;
    const path = new Path2D();
    path.moveTo(xOf(points[0].lng), yOf(points[0].lat));
    for (let i = 1; i < points.length; i++) appendArc(path, points[i - 1], points[i], xOf, yOf);
    workshop.overlayRoutes.push({ path, color: route.color ?? null });
  }
}

/**
 * 把已有的路线与区域画在画布上方，勾地形时对着它们找准位置。
 *
 * 路径只算一次，之后每次重画只换画布 transform：平移缩放因此是即时的，
 * 线宽也按屏幕像素补偿（除以当前比例），放大后不会变成粗带。
 * 参考层不看年份——工坊编的是整张底图，不是某一年的切面。
 * 它只读：画布 pointer-events:none，不接任何绘制事件，也不改项目数据。
 */
function drawRouteOverlay() {
  const { overlayCanvas, overlayCtx, wrap, grid, view } = workshop;
  if (!overlayCanvas || !overlayCtx || !wrap || !grid) return;
  if (!useStore.getState().workshopShowOverlay) return;
  const cw = wrap.clientWidth;
  const ch = wrap.clientHeight;
  if (cw < 2 || ch < 2) return;

  // 按设备像素比开画布，线条在高分屏上才不糊；样式尺寸仍是 CSS 像素
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (overlayCanvas.width !== Math.round(cw * dpr) ||
      overlayCanvas.height !== Math.round(ch * dpr)) {
    overlayCanvas.width = Math.round(cw * dpr);
    overlayCanvas.height = Math.round(ch * dpr);
    overlayCanvas.style.width = `${cw}px`;
    overlayCanvas.style.height = `${ch}px`;
  }
  const ctx = overlayCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw * dpr, ch * dpr);
  if (useStore.getState().contentRev !== workshop.overlayRev) buildOverlayPaths();

  // 画布像素 → 栅格像素的变换：先缩放，再按视图偏移
  const s = scaleOf();
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.tx, dpr * view.ty);

  // 先区域后路线：路线更细，压在上面才不会被区域边界淹没
  for (const { path, color } of workshop.overlayRegions) {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color ?? OVERLAY_BASE;
    ctx.fill(path);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color ?? OVERLAY_BORDER;
    ctx.lineWidth = 1.5 / s;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2 / s;
  for (const { path, color } of workshop.overlayRoutes) {
    ctx.strokeStyle = color ?? OVERLAY_BASE;
    ctx.stroke(path);
  }
}

/** 开关切换后同步参考层的显隐并立即重画；React 只负责改 store 里的布尔量 */
export function syncOverlayView() {
  const { overlayCanvas } = workshop;
  if (!overlayCanvas) return;
  const on = useStore.getState().workshopShowOverlay;
  overlayCanvas.style.display = on ? 'block' : 'none';
  if (on) drawRouteOverlay();
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

/**
 * 笔刷框：按当前指针与笔刷边长，把实际会受影响的格子矩形量到屏幕上。
 * 与 applyBrush 用同一套奇数化与中心格规则；贴到画布边缘时按网格边界裁掉，
 * 所以框永远表示真正会被写到的范围，而不是一个悬在画布外的理论尺寸。
 */
function updateBrush() {
  const { brushEl, pointer, brushVisible, canvas, wrap, grid } = workshop;
  if (!brushEl) return;
  if (!brushVisible || !pointer || !canvas || !wrap || !grid) {
    brushEl.style.display = 'none';
    return;
  }
  const st = useStore.getState();
  const rounded = Math.max(1, Math.round(Math.min(st.workshopSize, brushSizeMax())));
  const side = rounded % 2 === 1 ? rounded : rounded + 1;
  const [gx, gy] = toGrid(canvas, pointer);
  const anchorX = Math.floor(gx);
  const anchorY = Math.floor(gy);
  const before = (side - 1) / 2;
  const x0 = Math.max(0, anchorX - before);
  const y0 = Math.max(0, anchorY - before);
  const x1 = Math.min(grid.w - 1, anchorX + before);
  const y1 = Math.min(grid.h - 1, anchorY + before);
  if (x1 < x0 || y1 < y0) {
    brushEl.style.display = 'none';
    return;
  }
  const r = canvas.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const cellW = r.width / grid.w;
  const cellH = r.height / grid.h;
  brushEl.style.display = 'block';
  brushEl.style.transform = `translate(${r.left - wr.left + x0 * cellW}px, ${r.top - wr.top + y0 * cellH}px)`;
  brushEl.style.width = `${(x1 - x0 + 1) * cellW}px`;
  brushEl.style.height = `${(y1 - y0 + 1) * cellH}px`;
}

/** 指针是否还落在画布上。指针捕获时会收到画布外的坐标，抬起后要靠它决定框收不收 */
function overCanvas(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom;
}

/**
 * Ctrl+点击 = 定位预览：把点击位置换算成经纬度，交给三维预览的镜头转过去。
 * 二维画布本身不移动——定位看的是球面上的结果，不是把这一格拖到屏幕中央。
 * 预览收起时没有可看的视角，钩子不接这次定位。
 */
function locatePreviewAt(canvas, e) {
  const { grid, hooks } = workshop;
  const locate = hooks?.locatePreview;
  if (!grid || !locate) return;
  // 栅格是等经纬投影：x 从左到右 -180°→180°，y 从上到下 90°→-90°。
  // 取格中心而不是左上角，镜头对准的才是这一格中间
  const [gx, gy] = toGrid(canvas, e);
  const col = Math.min(grid.w - 1, Math.max(0, Math.floor(gx)));
  const row = Math.min(grid.h - 1, Math.max(0, Math.floor(gy)));
  const lng = ((col + 0.5) / grid.w) * 360 - 180;
  const lat = 90 - ((row + 0.5) / grid.h) * 180;
  locate(lat, lng);
}

/** 画一笔。画笔参数每次现取 store 里的值，免得闭包留住旧参数 */
function paint(canvas, e) {
  const st = useStore.getState();
  // 笔刷大小是跨网格留在 store 里的，可能来自上一张更宽的网格；夹到当前上限再落笔
  const size = Math.min(st.workshopSize, brushSizeMax());
  const [gx, gy] = toGrid(canvas, e);
  const g = workshop.grid;
  // 上色笔用颜料色；形态笔用高度基色，画笔内部按最终高度和坡度重算颜色
  const brushColor = st.workshopTool === 'paint' ? st.workshopColor : st.workshopHeightColor;
  // 颜色笔直接写目标色，重复点击结果不变；「加入阴影」只影响 paint，按坡度给目标色叠明暗
  const dirty = g.applyBrush(
    st.workshopTool, gx, gy, size, st.workshopStrength,
    st.workshopHard, hexTo565(brushColor), st.workshopPaintShadow,
  );
  if (!dirty) return;
  g.renderColor(dirty);
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
  // 路线/区域参考层是叠在颜色画布上的第二张画布：按屏幕坐标画，
  // 不套画布的 transform，尺寸随容器走；放在最上面，且不吃指针事件。
  const overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;';
  wrap.appendChild(overlay);
  workshop.overlayCanvas = overlay;
  workshop.overlayCtx = overlay.getContext('2d');
  // 笔刷框单独用一个不吃指针事件的 DOM 节点：跟着指针量一个矩形，比每帧重画画布便宜
  const brush = document.createElement('div');
  brush.className = 'wk-brush';
  wrap.appendChild(brush);
  workshop.brushEl = brush;
  workshop.pointer = null;
  workshop.brushVisible = false;
  fitView();
  syncOverlayView();

  let panning = null; // 正在平移时记上一个指针位置

  const onDown = (e) => {
    // Shift+左键 / 中键 / 右键 = 平移；Ctrl+左键 = 定位三维预览；左键 = 涂抹。
    // 画布交互先于画笔判断，组合键不会落笔。
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      panning = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
      workshop.brushVisible = false;
      updateBrush();
      return;
    }
    if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      workshop.pointer = { clientX: e.clientX, clientY: e.clientY };
      workshop.brushVisible = true;
      locatePreviewAt(canvas, e);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    pushUndo(); // 一笔一档：撤销回到这一笔之前
    workshop.painting = true;
    workshop.pointer = { clientX: e.clientX, clientY: e.clientY };
    workshop.brushVisible = true;
    paint(canvas, e);
    updateBrush();
  };

  const onMove = (e) => {
    workshop.pointer = { clientX: e.clientX, clientY: e.clientY };
    if (panning) {
      // 平移期间不显示笔刷框：此时指针不在「准备落笔」的位置上
      workshop.brushVisible = false;
      panBy(e.clientX - panning.x, e.clientY - panning.y);
      panning.x = e.clientX;
      panning.y = e.clientY;
      return;
    }
    workshop.brushVisible = true;
    updateBrush();
    if (workshop.painting) paint(canvas, e);
  };

  const onEnter = (e) => {
    workshop.pointer = { clientX: e.clientX, clientY: e.clientY };
    workshop.brushVisible = true;
    updateBrush();
  };

  const onLeave = () => {
    workshop.brushVisible = false;
    updateBrush();
  };

  const onUp = (e) => {
    workshop.painting = false;
    panning = null;
    canvas.style.cursor = '';
    if (e && e.clientX != null) workshop.pointer = { clientX: e.clientX, clientY: e.clientY };
    workshop.brushVisible = !!e && overCanvas(canvas, e);
    updateBrush();
  };

  const onWheel = (e) => {
    e.preventDefault(); // 不然页面（或底下的相机）也跟着滚
    workshop.pointer = { clientX: e.clientX, clientY: e.clientY };
    workshop.brushVisible = true;
    // deltaMode=1 是按「行」滚的浏览器，换算成像素再看齐
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * WHEEL_K));
  };

  const onContext = (e) => e.preventDefault(); // 右键要用来平移，不出菜单

  // 窗口失焦时收不到 pointerup；不结束绘制标志的话，回到画布移动鼠标会继续涂
  const onBlur = () => {
    workshop.painting = false;
    panning = null;
    workshop.brushVisible = false;
    canvas.style.cursor = '';
    updateBrush();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerenter', onEnter);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  addEventListener('blur', onBlur);

  // 拖窗口时容器会变宽变高，「适应窗口」的比例跟着变，否则图会飘到视野外
  const ro = new ResizeObserver(() => reflow());
  ro.observe(wrap);

  return () => {
    ro.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerenter', onEnter);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContext);
    removeEventListener('blur', onBlur);
    overlay.remove();
    brush.remove();
    workshop.canvas = null;
    workshop.wrap = null;
    workshop.overlayCanvas = null;
    workshop.overlayCtx = null;
    workshop.brushEl = null;
    workshop.pointer = null;
    workshop.brushVisible = false;
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
