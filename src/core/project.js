/**
 * 世界观数据模型：项目 = 一张脸（舞台）+ 一批内容（事件 / 路线 / 区域）。
 * 纯函数式 CRUD（直接改传入的 project 对象并返回创建的实体），
 * 持久化、渲染都不在这里。
 *
 * 时间一律是数值年：可为负（公元前）、可为小数。内容的 from / to 为空表示该端开放，
 * 两端都空就是常驻——「常驻」是默认形态，不写时间的内容一直在场。
 * 切面不是一个槽位，而是拿游标去求值。
 */
import { migrateProject } from './migrate.js';

let _seq = (Date.now() % 1e6).toString(36);
export function uid(prefix) {
  return `${prefix}_${_seq}${((Math.random() * 1e6) | 0).toString(36)}`;
}

/** 内容默认配色轮换 */
export const PALETTE = ['#ffb545', '#4dd0ff', '#ff6e6e', '#8dff70', '#c78dff', '#ffd54d', '#7da7ff', '#ff9ad5'];

export const PROJECT_VERSION = 2;

export function createProject({ name = '未命名世界', description = '' } = {}) {
  return {
    version: PROJECT_VERSION,
    name,
    description,
    // 舞台：球自己的那张脸，与时间无关，最多一张
    baseRasterId: null, // 地图 id（工坊可编辑的那种），空 = 深色空球
    rasterMaps: [], // { id, name, w, h, dataUrl, format } 地图（format 2：R+G=高度、B=水）
    events: [],     // { id, title, description, image, lat, lng, color, from, to } 事件
                    //   lat / lng 为空 = 纯叙事事件：不上球、不渲染标注，只进编年史
    routes: [],     // { id, title, description, color, points: [{lat,lng}...], from, to }
    regions: [],    // { id, name, description, color, ring: [[lng,lat]...], from, to }
    // 人物。没有存续区间：born / died 是生平，不参与在场判定，也不撑开时间轴
    characters: [], // { id, name, aliases: [], born, died, description, image, color }
    // 章节。独立对象，事件用 groupId 挂上来；可以暂时一个事件都没有（写大纲的常态）
    groups: [],     // { id, name }
  };
}

/** 导入/恢复时兜底：补齐缺失字段，旧版本先迁移，失败抛错 */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('不是合法的项目对象');
  const src = raw.version === PROJECT_VERSION ? raw : migrateProject(raw);
  const p = createProject({ name: src.name, description: src.description });
  p.baseRasterId = src.baseRasterId ?? null;
  p.rasterMaps = Array.isArray(src.rasterMaps)
    ? src.rasterMaps.filter((m) => m?.id && typeof m.dataUrl === 'string' && m.w > 0 && m.h > 0)
    : [];
  const okItem = (it) => it && typeof it === 'object';
  const okList = (v) => (Array.isArray(v) ? v : []);
  p.characters = okList(src.characters).filter(okItem)
    .map((c) => ({ ...c, aliases: toAliases(c.aliases) }));
  // 事件的「涉及人物」与「所属章节」在旧文件里整个键都可能不在，读进来统一补齐，
  // 面板、筛选与渲染层拿到的永远是数组 / null，不必各自兜底
  p.events = okList(src.events).filter(okItem).map((ev) => ({
    ...ev, characters: okList(ev.characters), groupId: ev.groupId ?? null,
  }));
  p.routes = okList(src.routes).filter(okItem);
  p.regions = okList(src.regions).filter(okItem);
  p.groups = okList(src.groups).filter(okItem);
  return p;
}

/**
 * 姓名快照：按姓名搜索时固化下来的一批事件 id，在界面上表现为一个临时章节。
 *
 * 它不属于项目数据，不随自动保存落盘；只在显式导出时写进文件，导入时按当前项目
 * 校验一遍——项目里已经不存在的 id 直接丢掉，免得长卷指向空处。
 */
export function normalizeTempChronicle(raw, project) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.eventIds)) return null;
  const known = new Set(project.events.map((e) => e.id));
  const eventIds = [...new Set(raw.eventIds)].filter((id) => known.has(id));
  if (!eventIds.length) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('snap'),
    title: title || '临时编年史',
    characterId: typeof raw.characterId === 'string' ? raw.characterId : null,
    eventIds,
  };
}

/** 别名一律存成数组：手写的文件里可能直接给一串，读进来补齐，不要悄悄丢掉 */
const toAliases = (v) => (v == null ? [] : (Array.isArray(v) ? v : [String(v)]));

/**
 * 每种内容的台账，外加它自带哪些通用字段。
 * `timed` = 有存续区间（两端留空即常驻）；`colored` = 参与配色轮换。
 * 人物没有存续区间，章节只是一个归类——两者都不该占掉配色池的额度。
 */
const KINDS = {
  event: { list: (p) => p.events, timed: true, colored: true },
  route: { list: (p) => p.routes, timed: true, colored: true },
  region: { list: (p) => p.regions, timed: true, colored: true },
  character: { list: (p) => p.characters, colored: true },
  group: { list: (p) => p.groups },
};

export function getList(project, kind) {
  return KINDS[kind].list(project);
}

export function getItem(project, kind, id) {
  return getList(project, kind).find((it) => it.id === id) ?? null;
}

function nextColor(project) {
  const kinds = Object.keys(KINDS).filter((k) => KINDS[k].colored);
  const used = kinds.flatMap((k) => getList(project, k).map((it) => it.color));
  return PALETTE.find((c) => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length];
}

// ---------------------------------------------------------------- 舞台

/**
 * 地图。format 是 PNG 的通道约定：2 = R+G 高度、B 水；
 * 没有这个字段的是旧项目（B 是河流），解码时按旧规则迁移。
 */
export function addRasterMap(project, { name = '地图', w, h, dataUrl }) {
  const map = { id: uid('rm'), name, w, h, dataUrl, format: 2 };
  project.rasterMaps.push(map);
  return map;
}

export function getRasterMap(project, id) {
  return project.rasterMaps.find((m) => m.id === id) ?? null;
}

// ---------------------------------------------------------------- 事件/路线/区域

const DEFAULTS = {
  // 坐标可以缺省——缺省就是纯叙事事件，不上球。
  // 每一条事件都常驻 characters / groupId 两个键（哪怕是空的），筛起来不必到处兜底
  event: (d) => ({
    title: '新事件', description: '', image: null,
    lat: null, lng: null, characters: [], groupId: null, ...d,
  }),
  route: (d) => ({
    title: '新路线', description: '', points: [], ...d,
  }),
  region: (d) => ({
    name: '新区域', description: '', ring: [], ...d,
  }),
  character: (d) => ({
    name: '新人物', born: null, died: null, description: '', image: null, ...d,
    // 写在展开之后：编程接口那边可能直接给一串，面板与搜索都按数组读
    aliases: toAliases(d.aliases),
  }),
  group: (d) => ({ name: '新章节', ...d }),
};

const ID_PREFIX = {
  event: 'ev', route: 'r', region: 'rg', character: 'ch', group: 'g',
};

export function addItem(project, kind, data = {}) {
  // 过滤掉显式传入的 undefined，避免覆盖 id/color 等默认值
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const caps = KINDS[kind];
  const item = {
    id: uid(ID_PREFIX[kind]),
    ...(caps.colored ? { color: nextColor(project) } : {}),
    // 两端留空 = 常驻；填了才进时间轴
    ...(caps.timed ? { from: null, to: null } : {}),
    ...DEFAULTS[kind](clean),
  };
  getList(project, kind).push(item);
  return item;
}

export function updateItem(project, kind, id, patch) {
  const item = getItem(project, kind, id);
  if (!item) return null;
  Object.assign(item, patch);
  return item;
}

export function removeItem(project, kind, id) {
  const list = getList(project, kind);
  const i = list.findIndex((it) => it.id === id);
  if (i === -1) return false;
  list.splice(i, 1);
  // 人物一走，事件上的那串引用就成了悬空 id，渲染时会指向不存在的人：一并摘掉
  if (kind === 'character') {
    for (const ev of project.events) {
      if (ev.characters?.includes(id)) ev.characters = ev.characters.filter((c) => c !== id);
    }
  }
  // 章节不走：删章节只是把组里的事件退回「未分组」，事件本身一条都不少
  if (kind === 'group') {
    for (const ev of project.events) if (ev.groupId === id) ev.groupId = null;
  }
  return true;
}

// ---------------------------------------------------------------- 视图条件

/**
 * 当前视图条件：一组**同时生效**的集合，事件必须落在每一个集合里（交集）。
 *
 * 三种集合只是来源不同，本质都是「一批事件」：
 *   - `groupIds`：选中的章节（可多选）；
 *   - `characterId`：编程接口的实时人物筛；
 *   - `activeSnapshotIds`：选中的姓名快照。快照存在 `snapshots` 里，形如
 *     `{ id, title, characterId, eventIds }`，是搜索那一刻算出来的一批事件 id；
 *     它不实时更新，但仍然是「一个章节那样的一批事件」，不是另一种筛选机制。
 *
 * 任何一项为空就不参与交集；全部为空就是「全部」。长卷、时间轴与球面都只读这一个条件。
 * 注意：事件目前只属于一个章节，而多个选中项取的是交集，所以同时选中两个不同章节时
 * 结果为空——这是数据模型与集合语义的直接结果；若以后事件可属于多个章节，这里不用改。
 */
export const noView = () => ({
  groupIds: [],
  characterId: null,
  snapshots: [],
  activeSnapshotIds: [],
});

/** 是否正在筛选（三个来源任一有值） */
export function isViewFiltered(view) {
  return !!(view?.groupIds?.length || view?.characterId || view?.activeSnapshotIds?.length);
}

export function inView(view, item) {
  if (!view) return true;
  // 选中的每一章都必须包含它（交集）；事件只属于一章，所以选两章会得到空集
  for (const id of view.groupIds ?? []) {
    if (item.groupId !== id) return false;
  }
  if (view.characterId && !item.characters?.includes(view.characterId)) return false;
  for (const id of view.activeSnapshotIds ?? []) {
    const snap = view.snapshots?.find((s) => s.id === id);
    if (!snap || !snap.eventIds.includes(item.id)) return false;
  }
  return true;
}

/**
 * 一个章节覆盖的时间范围，由组内事件的年份算出来（取出现与消失两端）。
 * 组里没有事件、或事件都没填年份时返回 null——此时标签上就不写范围。
 */
export function groupSpan(project, groupId) {
  let min = Infinity;
  let max = -Infinity;
  for (const ev of project.events) {
    if (ev.groupId !== groupId) continue;
    for (const v of [ev.from, ev.to]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min === Infinity ? null : { min, max };
}

/**
 * 某个人物涉及的事件，按时间先后排。
 * 反向关系是算出来的：关联只存在事件那一侧，人物上不留清单——否则每加一条事件
 * 都得回头去翻每个人物的卡。几百上千条事件线性扫一遍的开销可以忽略。
 */
export function eventsOfCharacter(project, id) {
  return project.events
    .filter((ev) => ev.characters?.includes(id))
    .sort((a, b) => (a.from ?? -Infinity) - (b.from ?? Infinity));
}

/** 某个章节里的事件，按时间先后 */
export function eventsOfGroup(project, id) {
  return project.events
    .filter((ev) => ev.groupId === id)
    .sort((a, b) => (a.from ?? -Infinity) - (b.from ?? Infinity));
}

// ---------------------------------------------------------------- 在场判定

/**
 * 内容在游标时刻是否在场。两端为空即开放，所以「常驻」= 两个都留空。
 * 缺省端用 ±Infinity 兜底，四种内容共用这一条判据。
 */
export function isActiveAt(cursor, item) {
  const from = item.from ?? -Infinity;
  const to = item.to ?? Infinity;
  return from <= cursor && cursor <= to;
}

/** 游标时刻下应显示的内容 */
export function activeItems(project, kind, cursor) {
  return getList(project, kind).filter((it) => isActiveAt(cursor, it));
}

/** 统计信息（检查器概览用） */
export function stats(project) {
  return {
    events: project.events.length,
    routes: project.routes.length,
    regions: project.regions.length,
    characters: project.characters.length,
  };
}
