/**
 * 世界数据分片：项目对象、当前切面下标，以及由两者算出的派生快照。
 *
 * core/project.js 的增删改都是就地修改，对象与数组的引用不变，React 靠引用比较
 * 感知不到变化。因此所有对 project 的写入都必须走 mutateProject()：它重建 derived
 * 快照（引用必然更新）并触发防抖保存。
 */
import * as P from '../core/project.js';
import { downloadProject } from '../core/storage.js';
import { session } from '../session.js';

/** 由项目数据算出的一份派生快照；每次数据变更后重建，引用必然更新 */
export function buildDerived(project, timeIndex) {
  if (!project) {
    return { counts: null, timePoint: null, activeEntries: [], activeRoutes: [], activeRegions: [] };
  }
  const i = Math.min(Math.max(timeIndex, 0), Math.max(project.timePoints.length - 1, 0));
  return {
    counts: P.stats(project),
    timePoint: project.timePoints[i] ?? null,
    activeEntries: P.activeItems(project, 'entry', i),
    activeRoutes: P.activeItems(project, 'route', i),
    activeRegions: P.activeItems(project, 'region', i),
  };
}

export const createWorldSlice = (set, get) => ({
  project: null,
  timeIndex: 0,
  derived: buildDerived(null, 0),

  /** 项目数据变更的唯一收口：改数据 → 重建快照 → 防抖保存 */
  mutateProject(fn) {
    const p = get().project;
    if (!p) return null;
    const out = fn?.(p);
    set({ derived: buildDerived(p, get().timeIndex) });
    session.autosaver?.save(p);
    return out;
  },

  // ---------------------------------------------------------------- 切面

  setTime(index) {
    const p = get().project;
    if (!p?.timePoints.length) return;
    const i = Math.min(Math.max(index, 0), p.timePoints.length - 1);
    set({ timeIndex: i, derived: buildDerived(p, i) });
  },

  step(delta) { get().setTime(get().timeIndex + delta); },

  addTimePoint({ label } = {}) {
    const p = get().project;
    if (!p) return null;
    const tp = P.addTimePoint(p, { label: label ?? `时间点 ${p.timePoints.length + 1}` });
    set({ timeIndex: p.timePoints.length - 1, selection: { kind: 'time', id: tp.id } });
    get().mutateProject(() => {});
    get().toast(`已添加「${tp.label}」，可在右侧上传这个时代的底图`);
    return tp;
  },

  updateTimePoint(id, patch) {
    if (!get().project) return;
    get().mutateProject((p) => P.updateTimePoint(p, id, patch));
    get().touchEra(); // mapId / rmapId 可能变了
  },

  deleteTimePoint(id) {
    const p = get().project;
    if (!p) return;
    P.removeTimePoint(p, id);
    set({ selection: null, timeIndex: Math.min(get().timeIndex, Math.max(0, p.timePoints.length - 1)) });
    get().mutateProject(() => {});
    get().touchEra(); // 删掉的可能正是当前切面沿用的那张底图，重取一次
  },

  // ---------------------------------------------------------------- 项目

  updateProject(patch) {
    if (!get().project) return;
    get().mutateProject((p) => Object.assign(p, patch));
  },

  /** 新建空白世界；有线内容未导出时先确认（与原行为一致） */
  newProject() {
    const p = get().project;
    const s = p ? P.stats(p) : null;
    if (s && (s.entries || s.routes || s.regions || s.timePoints)
        && !confirm('当前世界尚未导出，新建会覆盖自动保存的内容，确定？')) return;
    set({
      project: P.createProject(), timeIndex: 0, selection: null,
      entryDraft: {}, drawCoords: [], pendingCoords: null,
    });
    get().mutateProject(() => {});
    get().touchEra();
    get().addTimePoint({ label: '第一纪' }); // 直接带出时间点编辑器，引导上传底图
  },

  /** 启动时从 IndexedDB 恢复：只装载并对齐三维视图，不回写保存 */
  hydrateProject(project) {
    set({ project, timeIndex: 0, derived: buildDerived(project, 0) });
    get().touchEra();
  },

  /** 载入一份完整项目（示例世界 / 导入文件共用） */
  loadProjectInto(project) {
    set({ project, timeIndex: 0, selection: null, entryDraft: {}, drawCoords: [], pendingCoords: null });
    get().mutateProject(() => {});
    get().touchEra();
  },

  exportProject() {
    const p = get().project;
    if (!p) return;
    downloadProject(p);
    get().toast('项目文件已导出（含全部图片）');
  },

  // ---------------------------------------------------------------- 内容

  /** 改条目/路线/区域：derived 一变，bridge 会重建三维图层 */
  updateItem(kind, id, patch) {
    get().mutateProject((p) => P.updateItem(p, kind, id, patch));
  },

  deleteItem(kind, id) {
    set({ selection: null });
    get().mutateProject((p) => P.removeItem(p, kind, id));
  },

  /** 新建条目：草稿 + 落点 → 条目，并飞过去 */
  commitEntry() {
    const p = get().project;
    const { pendingCoords: c, entryDraft: d, timeIndex } = get();
    if (!p || !c) return;
    const item = P.addItem(p, 'entry', {
      title: d.title || '新条目',
      description: d.description || '',
      image: d.image ?? null,
      lat: c.lat,
      lng: c.lng,
      from: d.from || p.timePoints[timeIndex]?.id || null,
      to: d.to || null,
    });
    set({ entryDraft: {}, selection: { kind: 'entry', id: item.id } });
    get().setMode('browse');
    get().mutateProject(() => {});
    get().flyToItem('entry', item);
  },

  /**
   * 提交绘制。values 缺省时取 store 里的 drawForm（React 表单路径）；
   * 旧手写面板会显式传值，两者兼容。
   */
  commitDraw(kind, values) {
    const p = get().project;
    const coords = get().drawCoords;
    if (!p || !coords.length) return;
    // 点数不够就什么都不做：按 Enter 提交时「完成」按钮本来就是禁用的
    if (coords.length < (kind === 'route' ? 2 : 3)) return;
    const form = { ...get().drawForm, ...(values || {}) };
    if (form.color == null) delete form.color; // 未指定 → 交给 core 的调色板轮换
    const named = form.title || (kind === 'route' ? '新路线' : '新区域');
    const common = {
      description: form.description || '',
      color: form.color,
      from: form.from || null,
      to: form.to || null,
    };
    // 区域在 core 里的名称字段是 name，路线是 title：两边的表单都只叫「名称」，
    // 所以在这里翻译一次，否则区域永远只会拿到默认名
    const data = kind === 'region' ? { ...common, name: named } : { ...common, title: named };
    const item = kind === 'route'
      ? P.addItem(p, 'route', { ...data, points: coords.map(([lng, lat]) => ({ lat, lng })) })
      : P.addItem(p, 'region', { ...data, ring: coords.map(([lng, lat]) => [lng, lat]) });
    set({ selection: { kind, id: item.id } });
    get().setMode('browse');
    get().mutateProject(() => {});
    get().toast(kind === 'route' ? '路线已创建' : '区域已创建');
  },

  // ---------------------------------------------------------------- 编程接口用

  /** 当前切面可见条目（api.js#listEntries） */
  activeEntries() {
    return get().derived.activeEntries.map((e) => ({ ...e }));
  },

  addEntryViaApi(data) {
    const item = get().mutateProject((p) => P.addItem(p, 'entry', data));
    return item?.id;
  },

  addRouteViaApi(data) {
    const item = get().mutateProject((p) => P.addItem(p, 'route', data));
    return item?.id;
  },

  addRegionViaApi(data) {
    const item = get().mutateProject((p) => P.addItem(p, 'region', data));
    return item?.id;
  },
});
