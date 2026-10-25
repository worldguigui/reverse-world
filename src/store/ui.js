/**
 * UI 交互态分片：编辑模式、选中、绘制中数据、表单草稿、浮层开关、提示条。
 * 只管状态数据本身，不碰 DOM，也不碰 three 对象。
 */
import { uid, noView } from '../core/project.js';
import { buildDerived } from './world.js';

export const blankDrawForm = () => ({ title: '', description: '', from: null, to: null });

export const createUISlice = (set, get) => ({
  mode: 'browse',        // browse | add-event | draw-route | draw-region
  // 检查器正在展示什么。复数 kind 是清单页（没有 id），单数 kind 是某一条的详情，
  // 让「翻列表」与「看某一个」共用同一份状态，不必再多一个开关去跟选中态对齐
  selection: null,       // { kind: 'event'|'route'|'region'|'character', id } | { kind: 'events'|'characters'|'groups' }
  // 刚新建、还没保存过的人物 id。人物卡是先落数据再编辑的，若用户直接取消或离开，
  // 这个占位人物要跟着消失，否则清单里会越点越多「新人物」。
  newCharacterId: null,
  // 世界概览是否展开。默认开着；点面板上的 ✕ 收起，给球面让出位置。
  // 只有明确从「世界概览」入口回来时才重新打开，单击球面空白处不会把它弹回来。
  overviewOpen: true,
  // 「当前在看什么」是一组同时生效的事件集合：选中的章节（含姓名搜索生成的章节）
  // 与编程接口的实时人物筛，取交集。章节都存在 project.groups 里，取消选中只是退出交集，
  // 章节本身不会消失。
  viewFilter: noView(),
  // 当前镜头档位：1 = 出厂视角，64 = 相机推到底再收满镜头。
  // 滚轮与设置面板滑块读写同一个数，不写进设置存档。
  cameraLevel: 1,
  pendingCoords: null,   // 放置事件时点选的经纬度
  drawCoords: [],        // 绘制路线/区域的 [[lng,lat]…]
  eventDraft: {},        // 新建事件草稿（换位置不丢内容）
  drawForm: blankDrawForm(), // 绘制表单的字段值（球面加点、按 Enter 提交时都从这里取）
  workshopOpen: false,
  // 工坊的画笔参数与撤销可用态。网格、撤销栈太大，放在 ui/workshop-session.js 的模块级会话对象里
  workshopTool: 'raise',   // raise | lower | smooth | water | dry
  workshopSize: 8,
  workshopStrength: 0.08,
  workshopHard: true,      // true=硬笔（无扩散），false=软笔（高斯）
  workshopShowWater: false, // 画布是否改看黑白水陆掩膜（只影响预览）
  workshopShowOverlay: false, // 是否把已有路线/区域作为只读参考叠在画布上
  workshopZoom: 1,         // 画布缩放倍数（1 = 适应窗口），只给顶栏读数用
  canUndo: false,
  canRedo: false,
  settingsOpen: false,
  chronicleOpen: false,  // 编年史长卷浮层是否摊开
  // 全屏加载页：{ title, detail, progress }。progress 为 0..1；null = 不确定进度
  loading: null,
  toasts: [],            // [{ id, text }]

  // —— 变更信号 ——
  // 手写 DOM 面板不会自己重绘，得有人告诉它「数据变了、该重画了」。这里把这件事记成
  // 一次计数，具体含义由 bridge 决定；React 接管的区域不再依赖它。
  stageEpoch: 0,  // 舞台（地图 / 地形）被就地改动，需重新贴一次球面
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
    // 离开放置模式：丢掉待放置坐标与草稿，免得两次新建互相串内容
    if (prev === 'add-event') {
      patch.pendingCoords = null;
      patch.eventDraft = {};
    }
    // 每轮绘制重新开始，表单回到初始值（React 侧靠 key 重挂载生效）
    if (mode === 'draw-route' || mode === 'draw-region') patch.drawForm = blankDrawForm();
    // 新建事件也从头开始：上一次残留的草稿不能带进这一条
    if (mode === 'add-event') patch.eventDraft = {};
    set(patch);
  },

  /** 选中：检查器据此换成对应对象的详情表单，三维侧据此改高亮 */
  select(selection) {
    const { newCharacterId } = get();
    // 离开一张没保存过的新人物卡，就把占位人物一并删掉
    if (newCharacterId && !(selection?.kind === 'character' && selection.id === newCharacterId)) {
      get().deleteItem('character', newCharacterId);
    }
    set({ selection });
  },

  /**
   * 改视图条件。收窄只是换一批「谁在场」，一个像素都不用重画，
   * 所以走 derived 这一路、不碰 contentRev。
   *
   * 章节与实时人物筛都在这一个对象里；长卷、时间轴、球面与方向键
   * 读到的因此永远是同一批事件。
   */
  setViewFilter(patch) {
    const viewFilter = { ...get().viewFilter, ...patch };
    const p = get().project;
    set({ viewFilter, derived: buildDerived(p, get().cursor, viewFilter) });
  },

  setOverviewOpen(open) { set({ overviewOpen: open }); },

  /** 回到世界概览：既取消选中，也确保面板是展开的（它可能被 ✕ 收起过） */
  openOverview() {
    set({ overviewOpen: true });
    get().select(null);
  },

  /** 当前视图条件的一份副本，给编程接口读 */
  currentView() {
    const v = get().viewFilter;
    return {
      groupIds: [...v.groupIds],
      characterId: v.characterId,
    };
  },

  /** 镜头把实际落定的档位报回来（滚轮、飞行、复位都会触发），滑块据此跟随 */
  syncCameraLevel(level) { set({ cameraLevel: level }); },

  // ---------------------------------------------------------------- 放置 / 绘制

  /** 落点由球面点击写入：放置表单要把坐标回显出来 */
  setPendingCoords(coords) { set({ pendingCoords: coords }); },
  addDrawPoint(point) { set((s) => ({ drawCoords: [...s.drawCoords, point] })); },
  saveDraft(patch) { set((s) => ({ eventDraft: { ...s.eventDraft, ...patch } })); },
  clearDraft() { set({ eventDraft: {} }); },
  saveDrawForm(patch) { set((s) => ({ drawForm: { ...s.drawForm, ...patch } })); },

  // ---------------------------------------------------------------- 浮层

  setWorkshopOpen(open) { set({ workshopOpen: open }); },

  /** 每次开工坊都从默认画笔开始（撤销栈由会话对象自己清零） */
  resetWorkshopBrush() {
    set({
      workshopTool: 'raise', workshopSize: 8, workshopStrength: 0.08,
      workshopHard: true, workshopShowWater: false, workshopShowOverlay: false, workshopZoom: 1,
      canUndo: false, canRedo: false,
    });
  },
  setWorkshopBrush(patch) { set(patch); },
  setWorkshopZoom(zoom) { set({ workshopZoom: zoom }); },
  setWorkshopFlags({ canUndo, canRedo }) { set({ canUndo, canRedo }); },
  toggleSettings() { set((s) => ({ settingsOpen: !s.settingsOpen })); },
  setSettingsOpen(open) { set({ settingsOpen: open }); },
  toggleChronicle() { set((s) => ({ chronicleOpen: !s.chronicleOpen })); },
  setChronicleOpen(open) { set({ chronicleOpen: open }); },

  /** 打开/更新/关闭全屏加载页；传 null 关闭 */
  setLoading(loading) { set({ loading }); },

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
