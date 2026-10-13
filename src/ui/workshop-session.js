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
  binding: null,     // 直接编辑已存在的栅格底图时记下 { rmapId }
  tp: null,          // 正在编辑哪个时间点
  hooks: null,       // { onChange, onCommit, onCancel, loadRealEarth }
  undoStack: [],
  redoStack: [],
  painting: false,   // 指针是否按住（按住拖动时连续涂抹）
  dirty: false,      // 本次打开后是否真的改过
  previewed: false,  // 球体是否已经建过预览纹理
};

/** 撤销步数：网格越大，一份快照越贵 */
const undoLimit = () => (workshop.grid?.w >= 1024 ? 8 : 15);

/** 把撤销/重做的可用态同步给按钮 */
function syncFlags() {
  useStore.getState().setWorkshopFlags({
    canUndo: workshop.undoStack.length > 0,
    canRedo: workshop.redoStack.length > 0,
  });
}

export function beginWorkshop({ grid, binding = null, tp, hooks }) {
  workshop.grid = grid;
  workshop.binding = binding;
  workshop.tp = tp;
  workshop.hooks = hooks;
  workshop.undoStack = [];
  workshop.redoStack = [];
  workshop.painting = false;
  workshop.dirty = false;
  workshop.previewed = false;
  syncFlags();
}

export function endWorkshop() {
  workshop.grid = null;
  workshop.binding = null;
  workshop.tp = null;
  workshop.hooks = null;
  workshop.undoStack = [];
  workshop.redoStack = [];
  workshop.painting = false;
}

// ---------------------------------------------------------------- 撤销 / 重做

const snapshot = () => ({ h: workshop.grid.height.slice(), r: workshop.grid.river.slice() });

function pushUndo() {
  workshop.undoStack.push(snapshot());
  if (workshop.undoStack.length > undoLimit()) workshop.undoStack.shift();
  workshop.redoStack.length = 0;
  syncFlags();
}

function restore(snap) {
  const g = workshop.grid;
  g.height.set(snap.h);
  g.river.set(snap.r);
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
  workshop.grid.fill(-0.45);
  workshop.dirty = true;
  workshop.hooks.onChange(workshop.grid);
}

/** 用真实地球高程覆盖整张网格（下载解码由调用方提供） */
export async function copyFromRealEarth() {
  pushUndo();
  const real = await workshop.hooks.loadRealEarth();
  workshop.grid.copyFrom(real);
  workshop.dirty = true;
  workshop.hooks.onChange(workshop.grid);
}

// ---------------------------------------------------------------- 指针绘制

/** 屏幕坐标 → 网格坐标（画布按 object-fit: contain 铺满，直接按比例换算） */
function toGrid(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return [
    ((e.clientX - rect.left) / rect.width) * workshop.grid.w,
    ((e.clientY - rect.top) / rect.height) * workshop.grid.h,
  ];
}

/** 画一笔。画笔参数每次现取 store 里的值，免得闭包留住旧参数 */
function paint(canvas, e) {
  const { workshopTool: tool, workshopSize: size, workshopStrength: strength, workshopHard: hard } =
    useStore.getState();
  const [gx, gy] = toGrid(canvas, e);
  const g = workshop.grid;
  const dirty = g.applyBrush(tool, gx, gy, size, strength, hard);
  if (!dirty) return;
  g.renderColor(dirty);
  workshop.dirty = true;
  workshop.hooks.onChange(g);
}

/**
 * 给画布装上绘制用的指针事件。画布本身是网格自带的 DOM 节点、由调用方插进页面，
 * 不是 React 元素，所以这里用命令式绑定；返回解绑函数。
 */
export function attachCanvas(canvas) {
  const onDown = (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    pushUndo(); // 一笔一档：撤销回到这一笔之前
    workshop.painting = true;
    paint(canvas, e);
  };
  const onMove = (e) => { if (workshop.painting) paint(canvas, e); };
  const onUp = () => { workshop.painting = false; };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
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
