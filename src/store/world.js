/**
 * 世界数据分片：项目对象、游标所在的那一年，以及由两者算出的派生快照。
 *
 * core/project.js 的增删改都是就地修改，对象与数组的引用不变，React 靠引用比较
 * 感知不到变化。因此所有对 project 的写入都必须走 mutateProject()：它重建 derived
 * 快照（引用必然更新）并触发防抖保存。
 *
 * 游标不是项目数据，是「此刻在看哪一年」，所以不进 project；它一变 derived 就换出一份新的，
 * 三维层据此只翻可见性，一个像素都不重画。
 */
import * as P from '../core/project.js';
import { downloadProject } from '../core/storage.js';
import { defaultCursor, clampCursor, nextTickEvent, nextTickYear, timeTicks, roundYear } from '../core/timeline.js';
import { timeYear } from '../core/datetime.js';
import { session } from '../session.js';

/**
 * 由项目数据、游标与视图条件算出的一份派生快照；每次数据变更、游标走动或换视图后重建，
 * 引用必然更新。
 *
 * 只有事件多叠一道视图条件（在场 ∩ 属于当前视图）：选中的各章与实时人物筛
 * 都在这一个条件里，球面看到的与长卷、时间轴是同一批事件。
 * 路线与区域的存续区间照旧，不受视图条件影响。
 */
export function buildDerived(project, cursor, viewFilter = null) {
  if (!project) {
    return {
      counts: null,
      activeEvents: [], activeRoutes: [], activeRegions: [],
    };
  }
  return {
    counts: P.stats(project),
    activeEvents: P.activeItems(project, 'event', cursor)
      .filter((e) => P.inView(project, viewFilter, e)),
    activeRoutes: P.activeItems(project, 'route', cursor),
    activeRegions: P.activeItems(project, 'region', cursor),
  };
}

/** 绘制表单的初始值；换世界时与模式一起复位，免得旧世界的名称和年份跟过来 */
const blankDrawForm = () => ({ title: '', description: '', from: null, to: null });

export const createWorldSlice = (set, get) => ({
  project: null,
  cursor: 0,
  derived: buildDerived(null, 0),
  /**
   * 内容改动次数。游标走动也会换出一份新的 derived，但那只是同一批内容换了一批在场者，
   * 三维层看到它只需要翻可见性；真正要重建贴图与几何的只有内容本身变了，由这个计数标记。
   */
  contentRev: 0,

  /** 项目数据变更的唯一收口：改数据 → 重建快照 → 防抖保存 */
  mutateProject(fn) {
    const p = get().project;
    if (!p) return null;
    const out = fn?.(p);
    // 改内容可能同时收窄时间轴的定义域（删掉最早/最晚的一条）；游标不能留在域外，
    // 派生快照也按夹取后的游标算，轴上的位置与实际上场的内容才对得上
    const cursor = clampCursor(p, get().cursor);
    set({
      cursor,
      derived: buildDerived(p, cursor, get().viewFilter),
      contentRev: get().contentRev + 1,
    });
    session.autosaver?.save(p);
    return out;
  },

  // ---------------------------------------------------------------- 游标

  /** 游标走到某一年。取整是给拖动与「落在刻度的边距上」这两种情况兜底 */
  setCursor(year) {
    const p = get().project;
    if (!p) return;
    const y = clampCursor(p, year);
    if (y === get().cursor) return;
    set({ cursor: y, derived: buildDerived(p, y, get().viewFilter) });
  },

  /** 跳到内容里出现过的整年；输入框与「此刻」按钮走这条 */
  setCursorYear(year) {
    get().setCursor(roundYear(year));
  },

  /**
   * 前后跳一条事件（方向键与 ◀▶ 走这条）。
   *
   * 落点是事件而不是年份：与点时间轴上的刻度是同一件事，所以走同一条 jumpToEvent——
   * 设游标、选中、把镜头带过去三件事一起做，两种操作的结果因此完全一致。
   * 只挪游标不换选中，就会出现「按了右箭头，检查器里还是上一条事件」。
   */
  stepCursor(dir) {
    const p = get().project;
    if (!p) return;
    const view = get().viewFilter;
    // 带上视图条件：筛出某一章或某个人之后，方向键在筛出来的刻度上走，
    // 与长卷、时间轴和球面是同一批事件
    const sel = get().selection;
    const ev = nextTickEvent(p, get().cursor, dir, view, sel?.kind === 'event' ? sel.id : null);
    if (ev) {
      // 正在放点或勾线时只挪游标，不抢走检查器里那份填到一半的表单
      if (get().mode === 'browse') {
        get().jumpToEvent(ev.id);
      } else {
        const year = timeYear(ev.from);
        if (year != null) get().setCursor(year);
      }
      return;
    }
    // 还有刻度却已经走到头：原地不动，别让游标滑到轴的边距上
    if (timeTicks(p, view).length) return;
    // 一条刻度都没有（只有带区间的路线与区域）：按定义域百分之一挪一步，
    // 否则方向键在整个世界里都是死的
    get().setCursor(nextTickYear(p, get().cursor, dir, view));
  },

  // ---------------------------------------------------------------- 项目

  updateProject(patch) {
    if (!get().project) return;
    get().mutateProject((p) => Object.assign(p, patch));
  },

  /** 新建空白世界；有线内容未导出时先确认（与原行为一致） */
  newProject() {
    if (P.hasContent(get().project)
        && !confirm('当前世界尚未导出，新建会覆盖自动保存的内容，确定？')) return;
    // 缓存键是地图 id，同一份世界的旧导出/云存档会沿用同一个 id；
    // 不清掉的话，之后载入的旧档会直接命中上一份网格
    session.gridCache.clear();
    const fresh = P.createProject();
    set({
      project: fresh, cursor: 0, selection: null, mode: 'browse', newCharacterId: null,
      overviewOpen: true,
      eventDraft: {}, drawCoords: [], pendingCoords: null, drawForm: blankDrawForm(),
      // 换了世界就回到「全部」：上一个世界的章节 id 与姓名快照在新世界里毫无意义
      viewFilter: P.noView(),
    });
    get().mutateProject(() => {});
    get().touchStage();
  },

  /** 启动时从 IndexedDB 恢复：只装载并对齐三维视图，不回写保存 */
  hydrateProject(project) {
    session.gridCache.clear();
    const cursor = defaultCursor(project);
    const viewFilter = P.noView();
    set({
      project, cursor, viewFilter,
      derived: buildDerived(project, cursor, viewFilter),
      contentRev: get().contentRev + 1,
    });
    get().touchStage();
  },

  /**
   * 载入一份完整项目（示例世界 / 导入文件 / 云存档共用）。
   * @param {object} project
   * @param {{ grid?: object }} [options] grid：调用方已经解好的网格，直接回填缓存
   */
  loadProjectInto(project, { grid } = {}) {
    // 同一个世界 id 会在不同版本之间复用，旧网格必须作废：
    // 否则 applyStage 命中的是会话里那份更新的地形，载入的旧档根本不显示，
    // 之后工坊点「完成」还会把这份旧地形写回项目。
    session.gridCache.clear();
    if (grid && project.baseRasterId) session.gridCache.set(project.baseRasterId, grid);
    const cursor = defaultCursor(project);
    const viewFilter = P.noView();
    set({
      project, cursor, viewFilter,
      derived: buildDerived(project, cursor, viewFilter),
      selection: null, mode: 'browse', newCharacterId: null, overviewOpen: true,
      eventDraft: {}, drawCoords: [], pendingCoords: null, drawForm: blankDrawForm(),
    });
    get().mutateProject(() => {});
    get().touchStage();
    // 载入的内容未必落在初始视角那一片天底下，把镜头带过去（见 aimAtContent）。
    // 只在「载入一份新世界」时做，恢复上次打开的项目不动镜头——那是用户自己转出来的位置
    get().aimAtContent();
  },

  exportProject() {
    const p = get().project;
    if (!p) return;
    // 章节就在 project 里，随项目一起写出，没有额外的视图字段
    downloadProject(p);
    get().toast('项目文件已导出（含全部图片）');
  },

  // ---------------------------------------------------------------- 内容

  /** 改事件/路线/区域/人物/章节：derived 一变，bridge 会重建三维图层 */
  updateItem(kind, id, patch) {
    // 人物卡按下保存：从此它就是正式条目，离开时不该再被当成占位删掉
    if (kind === 'character' && get().newCharacterId === id) set({ newCharacterId: null });
    get().mutateProject((p) => P.updateItem(p, kind, id, patch));
  },

  deleteItem(kind, id) {
    if (kind === 'character' && get().newCharacterId === id) set({ newCharacterId: null });
    // 只清掉正被删的那一项的选中；删章节不该把检查器里正在看的事件也一并关掉
    const sel = get().selection;
    if (sel?.kind === kind && sel.id === id) set({ selection: null });
    get().mutateProject((p) => P.removeItem(p, kind, id));
    // 正选着它的话，选中项跟着一起没了：留一个指向空处的条件会把整条长卷筛空
    const v = get().viewFilter;
    if (kind === 'group' && v.groupIds.includes(id)) {
      get().setViewFilter({ groupIds: v.groupIds.filter((x) => x !== id) });
    }
    if (kind === 'character' && v.characterId === id) get().setViewFilter({ characterId: null });
  },

  /**
   * 新建事件：草稿 + 落点 → 事件，并飞过去。
   * 没点球面就是「纯叙事事件」——它照样是一条正经事件，只是不上球、只进编年史。
   *
   * 出现于留空就是「自始」：事件的起点开放，游标走到任何一年它都在场。
   * 不自动填入当前游标年份，用户没写时间就不该被写上一个具体年份。
   */
  commitEvent() {
    const p = get().project;
    const { pendingCoords: c, eventDraft: d } = get();
    if (!p) return;
    const item = P.addItem(p, 'event', {
      title: d.title || '新事件',
      description: d.description || '',
      image: d.image ?? null,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
      from: d.from ?? null,
      to: d.to ?? null,
      characters: d.characters ?? [],
      groupIds: d.groupIds ?? [],
    });
    set({ eventDraft: {}, selection: { kind: 'event', id: item.id } });
    get().setMode('browse');
    get().mutateProject(() => {});
    if (c) get().flyToItem('event', item);
  },

  /** 提交绘制：坐标来自球面，名称与时间等字段来自 drawForm */
  commitDraw(kind) {
    const p = get().project;
    const coords = get().drawCoords;
    if (!p || !coords.length) return;
    // 点数不够就什么都不做：按 Enter 提交时「完成」按钮本来就是禁用的
    if (coords.length < (kind === 'route' ? 2 : 3)) return;
    const form = get().drawForm;
    const named = form.title || (kind === 'route' ? '新路线' : '新区域');
    const common = {
      description: form.description || '',
      from: form.from ?? null,
      to: form.to ?? null,
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

  // ---------------------------------------------------------------- 人物

  /** 新建人物并直接选中：录入整张卡都在面板里完成，不必再点一次 */
  addCharacter() {
    const item = get().mutateProject((p) => P.addItem(p, 'character', {}));
    if (item) set({ selection: { kind: 'character', id: item.id }, newCharacterId: item.id });
    return item;
  },

  /** 全部人物。数组顺序就是录入先后，不做二次排序 */
  characters() {
    return get().project?.characters ?? [];
  },

  /** 某个人物涉及的事件，按时间先后。人往事件上挂，反向清单靠这条现算 */
  eventsOfCharacter(id) {
    const p = get().project;
    return p ? P.eventsOfCharacter(p, id) : [];
  },

  // ---------------------------------------------------------------- 章节

  /** 新建章节。建完留在清单里改名字，不跳走——章节的正文是它装的事件，不是自己 */
  addGroup(name) {
    return get().mutateProject((p) => P.addItem(p, 'group', { name: name || '新章节' }));
  },

  /**
   * 姓名搜索：把此人**此刻**涉及的事件取成一份清单，新建一个章节并选中。
   *
   * 这就是一个普通章节，和「新建章节」得到的东西没有区别：清单是此刻的一份拷贝，
   * 事件之后改章不会自动回写它——普通章节本来也不会自动回写。再搜一次就是再建一章。
   */
  chapterFromCharacter(c) {
    if (!c) return null;
    const g = get().mutateProject((p) => {
      const eventIds = p.events
        .filter((e) => e.characters?.includes(c.id))
        .map((e) => e.id);
      return P.addItem(p, 'group', { name: c.name, eventIds });
    });
    if (!g) return null;
    const { groupIds } = get().viewFilter;
    get().setViewFilter({ groupIds: [...groupIds, g.id] });
    return g.id;
  },

  /** 全部章节，按录入先后 */
  groups() {
    return get().project?.groups ?? [];
  },

  /** 某个章节里的事件，按时间先后 */
  eventsOfGroup(id) {
    const p = get().project;
    return p ? P.eventsOfGroup(p, id) : [];
  },

  /** 章节覆盖的时间范围，由组内事件的年份算出来；空章节是 null */
  groupSpan(id) {
    const p = get().project;
    return p ? P.groupSpan(p, id) : null;
  },

  // ---------------------------------------------------------------- 编程接口用

  /** 当前游标下在场的事件（api.js#listEvents） */
  activeEvents() {
    return get().derived.activeEvents.map((e) => ({ ...e }));
  },

  addEventViaApi(data) {
    const item = get().mutateProject((p) => P.addItem(p, 'event', data));
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

  addCharacterViaApi(data) {
    const item = get().mutateProject((p) => P.addItem(p, 'character', data));
    return item?.id;
  },

  addGroupViaApi(data) {
    const item = get().mutateProject((p) => P.addItem(p, 'group', data));
    return item?.id;
  },
});
