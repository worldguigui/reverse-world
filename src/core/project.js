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

/**
 * 新建内容的默认颜色：按类别固定，不随创建顺序轮换。
 * 路线与区域在球上走统一的语义配色（普通灰金、选中铜橙），
 * 这两个值只为数据兼容保留；人物颜色仍用于列表里的小圆点。
 */
export const DEFAULT_ITEM_COLORS = {
  route: '#b5a17b',
  region: '#b5a17b',
  character: '#c78dff',
};

export const PROJECT_VERSION = 3;

export function createProject({ name = '未命名世界', description = '' } = {}) {
  return {
    version: PROJECT_VERSION,
    name,
    description,
    // 舞台：球自己的那张脸，与时间无关，最多一张
    baseRasterId: null, // 地图 id（工坊可编辑的那种），空 = 深色空球
    rasterMaps: [], // { id, name, w, h, dataUrl, format } 地图（format 2：R+G=高度、B=水）
    events: [],     // { id, title, description, image, lat, lng, from, to } 事件
                    //   lat / lng 为空 = 纯叙事事件：不上球、不渲染标注，只进编年史
    routes: [],     // { id, title, description, color, points: [{lat,lng}...], from, to }
    regions: [],    // { id, name, description, color, ring: [[lng,lat]...], from, to }
    // 人物。没有存续区间：born / died 是生平，不参与在场判定，也不撑开时间轴
    characters: [], // { id, name, aliases: [], born, died, description, image, color }
    // 章节。章节自己拥有一批事件（eventIds），一个事件因此可以同时属于多章；
    // 也可以暂时一个事件都没有（写大纲的常态）。姓名搜索出来的也只是这样一章
    groups: [],     // { id, name, eventIds }
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
  // 事件的「涉及人物」在旧文件里整个键都可能不在，读进来统一补齐。
  // 章节关系不放在事件上：章节自己拥有 eventIds，一个事件才能同时出现在多章里
  p.events = okList(src.events).filter(okItem)
    .map(({ groupId: _legacy, color: _unusedColor, ...ev }) => ({
      ...ev, characters: okList(ev.characters),
    }));
  p.routes = okList(src.routes).filter(okItem);
  p.regions = okList(src.regions).filter(okItem);
  // 章节清单由章节持有。导入时按当前事件表校验：悬空 id 与重复项一律摘掉。
  // 章节只有 id / name / eventIds 三个字段，没有「来源」之类的类型标记
  const knownEvents = new Set(p.events.map((e) => e.id));
  p.groups = okList(src.groups).filter((g) => g?.id).map((g) => {
    const ids = okList(g.eventIds).filter((id) => knownEvents.has(id));
    return {
      id: g.id,
      name: typeof g.name === 'string' ? g.name : '未命名章节',
      eventIds: [...new Set(ids)],
    };
  });
  return p;
}

/** 别名一律存成数组：手写的文件里可能直接给一串，读进来补齐，不要悄悄丢掉 */
const toAliases = (v) => (v == null ? [] : (Array.isArray(v) ? v : [String(v)]));

/**
 * 每种内容的台账，外加它自带哪些通用字段。
 * `timed` = 有存续区间（两端留空即常驻）；`colored` = 创建时带该类别的默认颜色。
 * 事件与章节没有颜色；人物没有存续区间。
 */
const KINDS = {
  event: { list: (p) => p.events, timed: true },
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
  // 事件上常驻 characters 一个键（哪怕空的），筛起来不必到处兜底
  event: (d) => ({
    title: '新事件', description: '', image: null,
    lat: null, lng: null, characters: [], ...d,
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
  group: (d) => ({ name: '新章节', eventIds: [], ...d }),
};

const ID_PREFIX = {
  event: 'ev', route: 'r', region: 'rg', character: 'ch', group: 'g',
};

/**
 * 改写某条事件挂在哪几章下。清单的所有者是章节，所以这里是往各章的 eventIds 里
 * 加或删这条 id，事件对象上不留副本。所有章节一视同仁。
 */
export function setEventGroups(project, eventId, groupIds = []) {
  const want = new Set(groupIds);
  for (const g of project.groups) {
    const has = g.eventIds.includes(eventId);
    if (want.has(g.id) && !has) g.eventIds.push(eventId);
    else if (!want.has(g.id) && has) g.eventIds = g.eventIds.filter((id) => id !== eventId);
  }
}

export function addItem(project, kind, data = {}) {
  // 过滤掉显式传入的 undefined，避免覆盖 id/color 等默认值
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  // 事件没有颜色字段：旧面板或脚本仍可能传进来，直接丢掉
  if (kind === 'event') delete clean.color;
  // 章节关系写在章节那一侧：创建时把新事件的 id 同步进各章清单，事件上不存副本。
  // groupId 是旧版的单章字段，仍接受，按一章处理
  let groupIds = null;
  if (kind === 'event' && ('groupIds' in clean || 'groupId' in clean)) {
    groupIds = clean.groupIds ?? (clean.groupId ? [clean.groupId] : []);
    delete clean.groupIds;
    delete clean.groupId;
  }
  const caps = KINDS[kind];
  const item = {
    id: uid(ID_PREFIX[kind]),
    ...(caps.colored ? { color: DEFAULT_ITEM_COLORS[kind] } : {}),
    // 两端留空 = 常驻；填了才进时间轴
    ...(caps.timed ? { from: null, to: null } : {}),
    ...DEFAULTS[kind](clean),
  };
  getList(project, kind).push(item);
  if (groupIds) setEventGroups(project, item.id, groupIds);
  return item;
}

export function updateItem(project, kind, id, patch) {
  const item = getItem(project, kind, id);
  if (!item) return null;
  // 事件没有颜色字段：旧面板或脚本仍可能传进来，直接丢掉
  if (kind === 'event' && 'color' in patch) {
    const { color: _unusedColor, ...rest } = patch;
    patch = rest;
  }
  // 与创建同一条规则：groupIds 不是事件上的字段，而是各章节清单的增删
  if (kind === 'event' && ('groupIds' in patch || 'groupId' in patch)) {
    const { groupIds, groupId, ...rest } = patch;
    Object.assign(item, rest);
    setEventGroups(project, id, groupIds ?? (groupId ? [groupId] : []));
    return item;
  }
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
  // 事件一走，各章清单里那份 id 也随之摘掉。删章节则相反：清单随章节一起消失，
  // 事件本身一条都不少，也不存在「退回未分组」——事件与章节是多对多关系
  if (kind === 'event') {
    for (const g of project.groups) {
      if (g.eventIds?.includes(id)) g.eventIds = g.eventIds.filter((x) => x !== id);
    }
  }
  return true;
}

// ---------------------------------------------------------------- 视图条件

/**
 * 当前视图条件：一组**同时生效**的集合，事件必须落在每一个集合里（交集）。
 *
 * 两种集合只是来源不同，本质都是「一批事件」：
 *   - `groupIds`：选中的章节（可多选）。手动建的、姓名搜索生成的都是章节，
 *     都在 `project.groups` 里，用同一套选择与交集逻辑；
 *   - `characterId`：编程接口的实时人物筛。
 *
 * 任何一项为空就不参与交集；全部为空就是「全部」。长卷、时间轴与球面都只读这一个条件。
 * 章节拥有事件清单，一个事件可以同时属于多章，因此任意多个章节的交集都是有意义的。
 */
export const noView = () => ({
  groupIds: [],
  characterId: null,
});

/** 是否正在筛选（任一来源有值） */
export function isViewFiltered(view) {
  return !!(view?.groupIds?.length || view?.characterId);
}

export function inView(project, view, item) {
  if (!view) return true;
  // 选中的每一章都必须把这条事件列在自己的清单里（交集）
  for (const id of view.groupIds ?? []) {
    const group = project.groups.find((g) => g.id === id);
    if (!group || !group.eventIds?.includes(item.id)) return false;
  }
  if (view.characterId && !item.characters?.includes(view.characterId)) return false;
  return true;
}

/**
 * 一个章节覆盖的时间范围，由组内事件的年份算出来（取出现与消失两端）。
 * 组里没有事件、或事件都没填年份时返回 null——此时标签上就不写范围。
 */
export function groupSpan(project, groupId) {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return null;
  const ids = new Set(group.eventIds);
  let min = Infinity;
  let max = -Infinity;
  for (const ev of project.events) {
    if (!ids.has(ev.id)) continue;
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

/** 某条事件挂在哪些章节下。清单在章节那一侧，这里反向扫一遍 */
export function groupsOfEvent(project, eventId) {
  return project.groups.filter((g) => g.eventIds?.includes(eventId));
}

/** 某个章节里的事件，按时间先后 */
export function eventsOfGroup(project, id) {
  const group = project.groups.find((g) => g.id === id);
  if (!group) return [];
  const ids = new Set(group.eventIds);
  return project.events
    .filter((ev) => ids.has(ev.id))
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
