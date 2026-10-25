/**
 * 世界观数据模型：项目 = 一张脸（舞台）+ 一批内容（事件 / 路线 / 区域）。
 * 纯函数式 CRUD（直接改传入的 project 对象并返回创建的实体），
 * 持久化、渲染都不在这里。
 *
 * 事件与人物时间存 Y / YM / YMD / YMDH / YMDHM / YMDHMS 之一，可带空格备注；
 * 路线、区域仍用数值年（可为负、可为小数）。
 * 所有 from / to 为空表示该端开放，两端都空就是常驻——「常驻」是默认形态，
 * 不写时间的内容一直在场。时间轴与在场判定只取年份，完整时间不把轴细分到月日。
 * 切面不是一个槽位，而是拿游标去求值。
 *
 * 文件只有一种结构：当前代码写出的这一种。读入时字段缺失或格式不对就报错，
 * 不补默认值，也不接受别的形状。
 */
import { compareDateTime, normalizeTime, timeYear } from './datetime.js';

let _seq = (Date.now() % 1e6).toString(36);
export function uid(prefix) {
  return `${prefix}_${_seq}${((Math.random() * 1e6) | 0).toString(36)}`;
}

export function createProject({ name = '未命名世界', description = '' } = {}) {
  return {
    name,
    description,
    // 舞台：球自己的那张脸，与时间无关，最多一张
    baseRasterId: null, // 地图 id（工坊可编辑的那种），空 = 深色空球
    rasterMaps: [], // { id, name, w, h, dataUrl } 地图（R+G=高度、B=水）
    events: [],     // { id, title, description, image, lat, lng, from, to } 事件
                    //   from / to 是 Y…YMDHMS 时间串或 null；空格后是备注
                    //   lat / lng 为空 = 纯叙事事件：不上球、不渲染标注，只进编年史
    routes: [],     // { id, title, description, points: [{lat,lng}...], from, to, color }
                    //   color 为 null = 跟随界面默认配色
    regions: [],    // { id, name, description, ring: [[lng,lat]...], from, to, color }
    // 人物。没有存续区间：born / died 是生平，不参与在场判定，也不撑开时间轴
    characters: [], // { id, name, aliases: [], born, died, description, image, color }
                    //   born / died 与事件时间同一套精度，或 null
                    //   color 是可选的人物颜色，null = 跟随界面默认配色
    // 章节。章节自己拥有一批事件（eventIds），一个事件因此可以同时属于多章；
    // 也可以暂时一个事件都没有（写大纲的常态）。姓名搜索出来的也只是这样一章
    groups: [],     // { id, name, eventIds }
  };
}

function formatError(what) {
  throw new Error(`项目文件格式不对：${what}`);
}

function needObject(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) formatError(`${what} 必须是对象`);
  return v;
}

function needArray(v, what) {
  if (!Array.isArray(v)) formatError(`${what} 必须是数组`);
  return v;
}

function needString(v, what) {
  if (typeof v !== 'string') formatError(`${what} 必须是字符串`);
  return v;
}

function needStrings(v, what) {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    formatError(`${what} 必须是字符串数组`);
  }
  return v;
}

function needNumber(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) formatError(`${what} 必须是数字`);
  return v;
}

function needId(item, what) {
  if (typeof item.id !== 'string' || !item.id) formatError(`${what} 缺少 id`);
  return item.id;
}

const TIME_FORMAT = 'Y、YM、YMD、YMDH、YMDHM 或 YMDHMS';

function needTime(v, what) {
  if (v === null) return null;
  const normalized = normalizeTime(v);
  if (normalized !== v) formatError(`${what} 必须是 ${TIME_FORMAT}，空格后可以写备注`);
  return normalized;
}

/**
 * 读入项目：逐项按当前结构检查并组装。
 *
 * 不做「缺了就给个默认」——当前代码写出的文件每个字段都在，缺字段说明拿到的
 * 不是这个结构，应该让用户看到错误，而不是猜着补。
 */
export function normalizeProject(raw) {
  needObject(raw, '项目');
  const p = createProject({
    name: needString(raw.name, 'name'),
    description: needString(raw.description, 'description'),
  });
  if (raw.baseRasterId !== null && typeof raw.baseRasterId !== 'string') {
    formatError('baseRasterId 必须是地图 id 或 null');
  }
  p.baseRasterId = raw.baseRasterId;
  const maps = needArray(raw.rasterMaps, 'rasterMaps').map((m, i) => {
    const what = `rasterMaps[${i}]`;
    needObject(m, what);
    needId(m, what);
    if (!Number.isFinite(m.w) || m.w <= 0 || !Number.isFinite(m.h) || m.h <= 0) {
      formatError(`${what} 的宽高不对`);
    }
    return {
      id: m.id,
      name: needString(m.name, `${what}.name`),
      w: m.w,
      h: m.h,
      dataUrl: needString(m.dataUrl, `${what}.dataUrl`),
    };
  });
  // 球只有一张脸：只留 baseRasterId 指向的那张。
  // 旧文件里可能躺着不再使用的舞台图，不清掉会跟着每次导出一起复制几 MB 的 base64。
  p.rasterMaps = maps.filter((m) => m.id === p.baseRasterId);
  p.characters = needArray(raw.characters, 'characters').map((c, i) => {
    const what = `characters[${i}]`;
    needObject(c, what);
    needId(c, what);
    return {
      id: c.id,
      name: needString(c.name, `${what}.name`),
      aliases: needStrings(c.aliases, `${what}.aliases`),
      born: needTime(c.born, `${what}.born`),
      died: needTime(c.died, `${what}.died`),
      description: needString(c.description, `${what}.description`),
      image: c.image === null ? null : needString(c.image, `${what}.image`),
      color: c.color === null ? null : needString(c.color, `${what}.color`),
    };
  });
  // 章节关系不放在事件上：章节自己拥有 eventIds，一个事件才能同时出现在多章里
  p.events = needArray(raw.events, 'events').map((ev, i) => {
    const what = `events[${i}]`;
    needObject(ev, what);
    needId(ev, what);
    return {
      id: ev.id,
      title: needString(ev.title, `${what}.title`),
      description: needString(ev.description, `${what}.description`),
      image: ev.image === null ? null : needString(ev.image, `${what}.image`),
      lat: ev.lat === null ? null : needNumber(ev.lat, `${what}.lat`),
      lng: ev.lng === null ? null : needNumber(ev.lng, `${what}.lng`),
      from: needTime(ev.from, `${what}.from`),
      to: needTime(ev.to, `${what}.to`),
      characters: needStrings(ev.characters, `${what}.characters`),
    };
  });
  p.routes = needArray(raw.routes, 'routes').map((r, i) => {
    const what = `routes[${i}]`;
    needObject(r, what);
    needId(r, what);
    return {
      id: r.id,
      title: needString(r.title, `${what}.title`),
      description: needString(r.description, `${what}.description`),
      from: r.from === null ? null : needNumber(r.from, `${what}.from`),
      to: r.to === null ? null : needNumber(r.to, `${what}.to`),
      color: r.color === null ? null : needString(r.color, `${what}.color`),
      points: needArray(r.points, `${what}.points`).map((pt, j) => {
        const at = `${what}.points[${j}]`;
        needObject(pt, at);
        return { lat: needNumber(pt.lat, `${at}.lat`), lng: needNumber(pt.lng, `${at}.lng`) };
      }),
    };
  });
  p.regions = needArray(raw.regions, 'regions').map((r, i) => {
    const what = `regions[${i}]`;
    needObject(r, what);
    needId(r, what);
    return {
      id: r.id,
      name: needString(r.name, `${what}.name`),
      description: needString(r.description, `${what}.description`),
      from: r.from === null ? null : needNumber(r.from, `${what}.from`),
      to: r.to === null ? null : needNumber(r.to, `${what}.to`),
      color: r.color === null ? null : needString(r.color, `${what}.color`),
      ring: needArray(r.ring, `${what}.ring`).map((pair, j) => {
        const at = `${what}.ring[${j}]`;
        if (!Array.isArray(pair) || pair.length !== 2) formatError(`${at} 必须是 [lng, lat]`);
        return [needNumber(pair[0], `${at}[0]`), needNumber(pair[1], `${at}[1]`)];
      }),
    };
  });
  // 章节只有 id / name / eventIds 三个字段；引用的必须是这份文件里真实存在的事件
  const knownEvents = new Set(p.events.map((e) => e.id));
  p.groups = needArray(raw.groups, 'groups').map((g, i) => {
    const what = `groups[${i}]`;
    needObject(g, what);
    needId(g, what);
    const eventIds = needStrings(g.eventIds, `${what}.eventIds`);
    if (new Set(eventIds).size !== eventIds.length) formatError(`${what}.eventIds 有重复`);
    for (const id of eventIds) {
      if (!knownEvents.has(id)) formatError(`${what} 引用了不存在的事件 ${id}`);
    }
    return { id: g.id, name: needString(g.name, `${what}.name`), eventIds };
  });
  return p;
}

/** 别名始终是字符串数组；别的形状属于调用错误，不在这里改写 */
const toAliases = (v) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new Error('aliases 必须是字符串数组');
  }
  return v;
};

/**
 * 每种内容的台账，外加它自带哪些通用字段。
 * `timed` = 有存续区间（两端留空即常驻）。
 * 事件与章节没有颜色；人物没有存续区间。
 */
const KINDS = {
  event: { list: (p) => p.events, timed: true },
  route: { list: (p) => p.routes, timed: true },
  region: { list: (p) => p.regions, timed: true },
  character: { list: (p) => p.characters },
  group: { list: (p) => p.groups },
};

export function getList(project, kind) {
  return KINDS[kind].list(project);
}

export function getItem(project, kind, id) {
  return getList(project, kind).find((it) => it.id === id) ?? null;
}

// ---------------------------------------------------------------- 舞台

/** 地图：PNG 里 R+G 是高度、B 是水 */
export function addRasterMap(project, { name = '地图', w, h, dataUrl }) {
  const map = { id: uid('rm'), name, w, h, dataUrl };
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
    title: '新路线', description: '', points: [], color: null, ...d,
  }),
  region: (d) => ({
    name: '新区域', description: '', ring: [], color: null, ...d,
  }),
  character: (d) => ({
    // 颜色不是必填：null 表示不指定，各处按默认配色显示
    name: '新人物', born: null, died: null, description: '', image: null, color: null, ...d,
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

/** 事件时间或人物时间；空值表示该端开放 / 不详 */
function itemTime(v, what) {
  if (v === null) return null;
  const normalized = normalizeTime(v);
  if (normalized !== v) {
    throw new Error(`${what}必须是 ${TIME_FORMAT}，空格后可以写备注：${String(v)}`);
  }
  return normalized;
}

/** 事件收 from/to，人物收 born/died；两者共用同一套时间精度 */
function normalizeTimes(kind, data) {
  const out = { ...data };
  const fields = kind === 'event' ? ['from', 'to'] : ['born', 'died'];
  for (const key of fields) {
    if (key in out) out[key] = itemTime(out[key], kind === 'event' ? '事件时间' : '人物时间');
  }
  return out;
}

export function addItem(project, kind, data = {}) {
  // 过滤掉显式传入的 undefined，避免覆盖 id 等默认值
  let clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if (kind === 'event' || kind === 'character') {
    // 事件没有颜色字段：传入也丢掉
    if (kind === 'event') delete clean.color;
    clean = normalizeTimes(kind, clean);
  }
  // 章节关系写在章节那一侧：创建时把新事件的 id 同步进各章清单，事件上不存副本
  let groupIds = null;
  if (kind === 'event' && 'groupIds' in clean) {
    groupIds = clean.groupIds ?? [];
    delete clean.groupIds;
  }
  const caps = KINDS[kind];
  const item = {
    id: uid(ID_PREFIX[kind]),
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
  if (kind === 'event') {
    // 事件没有颜色字段：传入也丢掉
    const { color: _unusedColor, ...rest } = patch;
    patch = normalizeTimes(kind, rest);
  } else if (kind === 'character') {
    patch = normalizeTimes(kind, patch);
  }
  // 与创建同一条规则：groupIds 不是事件上的字段，而是各章节清单的增删
  if (kind === 'event' && 'groupIds' in patch) {
    const { groupIds, ...rest } = patch;
    Object.assign(item, rest);
    setEventGroups(project, id, groupIds ?? []);
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
      const year = timeYear(v);
      if (year == null) continue;
      if (year < min) min = year;
      if (year > max) max = year;
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
    .sort((a, b) => compareDateTime(a.from, b.from));
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
    .sort((a, b) => compareDateTime(a.from, b.from));
}

// ---------------------------------------------------------------- 在场判定

/**
 * 内容在游标时刻是否在场。两端为空即开放，所以「常驻」= 两个都留空。
 * 缺省端用 ±Infinity 兜底，四种内容共用这一条判据。
 *
 * 事件的时间精确到秒，但游标只有年份、时间轴也不细分到月日：
 * 这里只取时间里的年份比较，完整时间不会让一条事件在同年中间突然出现或消失。
 */
export function isActiveAt(cursor, item) {
  const from = timeYear(item.from) ?? -Infinity;
  const to = timeYear(item.to) ?? Infinity;
  return from <= cursor && cursor <= to;
}

/** 游标时刻下应显示的内容 */
export function activeItems(project, kind, cursor) {
  return getList(project, kind).filter((it) => isActiveAt(cursor, it));
}

/** 项目里是否有用户录入的内容；覆盖、新建或载入前的确认据此决定是否提醒 */
export function hasContent(project) {
  if (!project) return false;
  return Boolean(
    project.events.length
    || project.routes.length
    || project.regions.length
    || project.characters.length
    || project.groups.length
    || project.rasterMaps.length,
  );
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
