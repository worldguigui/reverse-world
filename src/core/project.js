/**
 * 世界观数据模型：项目 = 一张脸（舞台）+ 一批内容（地点 / 事件 / 路线 / 区域）。
 * 纯函数式 CRUD（直接改传入的 project 对象并返回创建的实体），
 * 持久化、渲染都不在这里。
 *
 * 时间一律是数值年：可为负（公元前）、可为小数。内容的 from / to 为空表示该端开放，
 * 两端都空就是常驻——这就是「地点」的默认形态。切面不是一个槽位，而是拿游标去求值。
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
    // 舞台：球自己的那张脸，与时间无关，各最多一张；栅格优先于图片
    baseRasterId: null, // 栅格底图 id（工坊可编辑的那种），空 = 没有地形起伏
    baseMapId: null,    // 图片底图 id，空 = 用引擎自带的地球贴图
    maps: [],       // { id, name, dataUrl } 图片底图
    rasterMaps: [], // { id, name, w, h, dataUrl } 栅格底图（PNG：R=高度 G=河流）
    entries: [],    // { id, title, description, image, lat, lng, color, from, to } 地点
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
  p.baseMapId = src.baseMapId ?? null;
  p.baseRasterId = src.baseRasterId ?? null;
  p.maps = Array.isArray(src.maps) ? src.maps.filter((m) => m?.id && typeof m.dataUrl === 'string') : [];
  p.rasterMaps = Array.isArray(src.rasterMaps)
    ? src.rasterMaps.filter((m) => m?.id && typeof m.dataUrl === 'string' && m.w > 0 && m.h > 0)
    : [];
  const okItem = (it) => it && typeof it === 'object';
  const okList = (v) => (Array.isArray(v) ? v : []);
  p.characters = okList(src.characters).filter(okItem)
    .map((c) => ({ ...c, aliases: toAliases(c.aliases) }));
  p.entries = okList(src.entries).filter(okItem);
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

/** 别名一律存成数组：手写的文件里可能直接给一串，读进来补齐，不要悄悄丢掉 */
const toAliases = (v) => (v == null ? [] : (Array.isArray(v) ? v : [String(v)]));

/**
 * 每种内容的台账，外加它自带哪些通用字段。
 * `timed` = 有存续区间（两端留空即常驻）；`colored` = 参与配色轮换。
 * 人物没有存续区间，章节只是一个归类——两者都不该占掉配色池的额度。
 */
const KINDS = {
  entry: { list: (p) => p.entries, timed: true, colored: true },
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

export function addMap(project, { name = '底图', dataUrl }) {
  const map = { id: uid('map'), name, dataUrl };
  project.maps.push(map);
  return map;
}

export function addRasterMap(project, { name = '地形底图', w, h, dataUrl }) {
  const map = { id: uid('rm'), name, w, h, dataUrl };
  project.rasterMaps.push(map);
  return map;
}

export function getMap(project, id) {
  return project.maps.find((m) => m.id === id) ?? null;
}

export function getRasterMap(project, id) {
  return project.rasterMaps.find((m) => m.id === id) ?? null;
}

// ---------------------------------------------------------------- 地点/事件/路线/区域

const DEFAULTS = {
  entry: (d) => ({
    title: '新地点', description: '', image: null,
    lat: 0, lng: 0, ...d,
  }),
  // 事件与地点同形，差别只在坐标可以缺省——缺省就是纯叙事事件，不上球。
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
  entry: 'e', event: 'ev', route: 'r', region: 'rg', character: 'ch', group: 'g',
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
 * 当前视图条件：`{ groupId, characterId }`，两个都可空，同时给就是交集。
 *
 * 指向章节时 `groupId` 有值；指向按人物筛时 `characterId` 有值——后者那一组是**算出来的**，
 * 用完就没了，不落盘、不进 groups。长卷与时间轴只管照着这个条件筛，不关心它是哪一种，
 * 于是「翻章」与「按人物筛」共用同一条路径，不用写两份。
 */
/** 未筛选：全都看。每次给一份新的，免得两处引用到同一个对象 */
export const noView = () => ({ groupId: null, characterId: null });

export function inView(view, item) {
  if (!view) return true;
  if (view.groupId && item.groupId !== view.groupId) return false;
  if (view.characterId && !item.characters?.includes(view.characterId)) return false;
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
 * 内容在游标时刻是否在场。两端为空即开放，所以「常驻地点」= 两个都留空。
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
    entries: project.entries.length,
    events: project.events.length,
    routes: project.routes.length,
    regions: project.regions.length,
    characters: project.characters.length,
  };
}
