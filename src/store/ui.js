/**
 * UI 交互态分片：编辑模式、选中、绘制中数据、表单草稿、浮层开关、提示条。
 * 只管状态数据本身，不碰 DOM，也不碰 three 对象。
 */
import { uid, noView } from '../core/project.js';
import { buildDerived } from './world.js';

export const blankDrawForm = () => ({ title: '', description: '', color: null, from: null, to: null });

export const createUISlice = (set, get) => ({
  mode: 'browse',        // browse | add-entry | add-event | draw-route | draw-region
  // 检查器正在展示什么。kind='characters'（复数、没有 id）是人物清单那一页，
  // 让「翻列表」与「看某一个」共用同一份状态，不必再多一个开关去跟选中态对齐
  selection: null,       // { kind: 'entry'|'event'|'route'|'region'|'character', id } | { kind: 'characters' | 'groups' }
  // 「当前在看什么」是一个视图条件，不是数据：指向章节时 groupId 有值，
  // 按人物筛时 characterId 有值（那一组是算出来的，用完就没了，不落盘）。同时给就是交集。
  viewFilter: noView(),
  pendingCoords: null,   // 放置地点/事件时点选的经纬度
  drawCoords: [],        // 绘制路线/区域的 [[lng,lat]…]
  entryDraft: {},        // 新建地点/事件草稿（换位置不丢内容）
  drawForm: blankDrawForm(), // 绘制表单的字段值（球面加点、按 Enter 提交时都从这里取）
  workshopOpen: false,
  // 工坊的画笔参数与撤销可用态。网格、撤销栈太大，放在 ui/workshop-session.js 的模块级会话对象里
  workshopTool: 'raise',   // raise | lower | smooth | river
  workshopSize: 8,
  workshopStrength: 0.08,
  workshopHard: true,      // true=硬笔（无扩散），false=软笔（高斯）
  workshopZoom: 1,         // 画布缩放倍数（1 = 适应窗口），只给顶栏读数用
  canUndo: false,
  canRedo: false,
  settingsOpen: false,
  chronicleOpen: false,  // 编年史长卷浮层是否摊开
  toasts: [],            // [{ id, text }]

  // —— 变更信号 ——
  // 手写 DOM 面板不会自己重绘，得有人告诉它「数据变了、该重画了」。这里把这件事记成
  // 一次计数，具体含义由 bridge 决定；React 接管的区域不再依赖它。
  stageEpoch: 0,  // 舞台（底图 / 地形）被就地改动，需重新贴一次球面
  layerEpoch: 0,  // 三维图层该重建了（贴图、材质、配色）
  layoutEpoch: 0, // 内容没变、只有脚下的地形变了 → 重新贴地即可
  touchStage() { set((s) => ({ stageEpoch: s.stageEpoch + 1 })); },
  touchLayers() { set((s) => ({ layerEpoch: s.layerEpoch + 1 })); },
  touchLayout() { set((s) => ({ layoutEpoch: s.layoutEpoch + 1 })); },

  // ---------------------------------------------------------------- 模式与选中

  setMode(mode) {
    const prev = get().mode;
    if (prev === mode) return;
    const patch = { mode };
    // 离开绘制模式：清空正在勾的点
    if (prev === 'draw-route' || prev === 'draw-region') patch.drawCoords = [];
    // 离开放置模式：丢掉待放置坐标与草稿，免得地点和事件互相串内容
    if (prev === 'add-entry' || prev === 'add-event') {
      patch.pendingCoords = null;
      patch.entryDraft = {};
    }
    // 每轮绘制重新开始，表单回到初始值（React 侧靠 key 重挂载生效）
    if (mode === 'draw-route' || mode === 'draw-region') patch.drawForm = blankDrawForm();
    set(patch);
  },

  /** 选中：检查器据此换成对应对象的详情表单，三维侧据此改高亮 */
  select(selection) { set({ selection }); },

  /**
   * 改视图条件。收窄只是换一批「谁在场」，一个像素都不用重画，
   * 所以走 derived 这一路、不碰 contentRev。
   */
  setViewFilter(patch) {
    const viewFilter = { ...get().viewFilter, ...patch };
    const p = get().project;
    set({ viewFilter, derived: buildDerived(p, get().cursor, viewFilter) });
  },

  /** 当前视图条件的一份副本。编程接口走 getter 现取，读快照上的字段会停在初始值 */
  currentView() {
    return { ...get().viewFilter };
  },

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
      workshopHard: true, workshopZoom: 1, canUndo: false, canRedo: false,
    });
  },
  setWorkshopBrush(patch) { set(patch); },
  setWorkshopZoom(zoom) { set({ workshopZoom: zoom }); },
  setWorkshopFlags({ canUndo, canRedo }) { set({ canUndo, canRedo }); },
  toggleSettings() { set((s) => ({ settingsOpen: !s.settingsOpen })); },
  setSettingsOpen(open) { set({ settingsOpen: open }); },
  toggleChronicle() { set((s) => ({ chronicleOpen: !s.chronicleOpen })); },
  setChronicleOpen(open) { set({ chronicleOpen: open }); },

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
