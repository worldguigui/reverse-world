/**
 * UI 交互态分片：编辑模式、选中、绘制中数据、表单草稿、浮层开关、提示条。
 * 只管状态数据本身，不碰 DOM，也不碰 three 对象。
 */
import { uid } from '../core/project.js';

export const blankDrawForm = () => ({ title: '', description: '', color: null, from: '', to: '' });

export const createUISlice = (set, get) => ({
  mode: 'browse',        // browse | add-entry | draw-route | draw-region
  selection: null,       // { kind: 'time'|'entry'|'route'|'region', id }
  pendingCoords: null,   // 放置条目时点选的经纬度
  drawCoords: [],        // 绘制路线/区域的 [[lng,lat]…]
  entryDraft: {},        // 新建条目草稿（换位置不丢内容）
  drawForm: blankDrawForm(), // 绘制表单的字段值（球面加点、按 Enter 提交时都从这里取）
  workshopOpen: false,
  // 工坊的画笔参数与撤销可用态。网格、撤销栈太大，放在 ui/workshop-session.js 的模块级会话对象里
  workshopTool: 'raise',   // raise | lower | smooth | river
  workshopSize: 8,
  workshopStrength: 0.08,
  workshopHard: true,      // true=硬笔（无扩散），false=软笔（高斯）
  canUndo: false,
  canRedo: false,
  settingsOpen: false,
  toasts: [],            // [{ id, text }]

  // —— 变更信号 ——
  // 手写 DOM 面板不会自己重绘，得有人告诉它「数据变了、该重画了」。这里把这件事记成
  // 一次计数，具体含义由 bridge 决定；React 接管的区域不再依赖它。
  eraEpoch: 0,    // 底图/地形被就地改动，需重新应用当前切面
  layerEpoch: 0,  // 三维图层该重建了（贴图、材质、配色）
  layoutEpoch: 0, // 内容没变、只有脚下的地形变了 → 重新贴地即可
  touchEra() { set((s) => ({ eraEpoch: s.eraEpoch + 1 })); },
  touchLayers() { set((s) => ({ layerEpoch: s.layerEpoch + 1 })); },
  touchLayout() { set((s) => ({ layoutEpoch: s.layoutEpoch + 1 })); },

  // ---------------------------------------------------------------- 模式与选中

  setMode(mode) {
    const prev = get().mode;
    if (prev === mode) return;
    const patch = { mode };
    // 离开绘制模式：清空正在勾的点
    if (prev === 'draw-route' || prev === 'draw-region') patch.drawCoords = [];
    // 离开放置模式：丢掉待放置坐标
    if (prev === 'add-entry') patch.pendingCoords = null;
    // 每轮绘制重新开始，表单回到初始值（React 侧靠 key 重挂载生效）
    if (mode === 'draw-route' || mode === 'draw-region') patch.drawForm = blankDrawForm();
    set(patch);
  },

  /** 选中：检查器据此换成对应对象的详情表单，三维侧据此改高亮 */
  select(selection) { set({ selection }); },

  editTimePoint(id) { get().select({ kind: 'time', id }); },

  // ---------------------------------------------------------------- 放置 / 绘制

  /** 落点由球面点击写入：放置表单要把坐标回显出来 */
  setPendingCoords(coords) { set({ pendingCoords: coords }); },
  addDrawPoint(point) { set((s) => ({ drawCoords: [...s.drawCoords, point] })); },
  saveDraft(patch) { set((s) => ({ entryDraft: { ...s.entryDraft, ...patch } })); },
  clearDraft() { set({ entryDraft: {} }); },
  saveDrawForm(patch) { set((s) => ({ drawForm: { ...s.drawForm, ...patch } })); },

  // ---------------------------------------------------------------- 浮层

  setWorkshopOpen(open) { set({ workshopOpen: open }); },

  /** 每次开工坊都从默认画笔开始（撤销栈由会话对象自己清零） */
  resetWorkshopBrush() {
    set({
      workshopTool: 'raise', workshopSize: 8, workshopStrength: 0.08,
      workshopHard: true, canUndo: false, canRedo: false,
    });
  },
  setWorkshopBrush(patch) { set(patch); },
  setWorkshopFlags({ canUndo, canRedo }) { set({ canUndo, canRedo }); },
  toggleSettings() { set((s) => ({ settingsOpen: !s.settingsOpen })); },
  setSettingsOpen(open) { set({ settingsOpen: open }); },

  // ---------------------------------------------------------------- 提示条

  toast(text) {
    const item = { id: uid('t'), text };
    set((s) => ({ toasts: [...s.toasts, item] }));
    setTimeout(() => get().dismissToast(item.id), 3000);
    return item.id;
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
});
