/**
 * 世界观数据模型：项目 = 时间点 + 底图 + 条目/路线/区域。
 * 纯函数式 CRUD（直接改传入的 project 对象并返回创建的实体），
 * 持久化、渲染都不在这里。
 */

let _seq = (Date.now() % 1e6).toString(36);
export function uid(prefix) {
  return `${prefix}_${_seq}${((Math.random() * 1e6) | 0).toString(36)}`;
}

/** 内容默认配色轮换 */
export const PALETTE = ['#ffb545', '#4dd0ff', '#ff6e6e', '#8dff70', '#c78dff', '#ffd54d', '#7da7ff', '#ff9ad5'];

export function createProject({ name = '未命名世界', description = '' } = {}) {
  return {
    version: 1,
    name,
    description,
    timePoints: [], // { id, label, mapId, rmapId }（图片底图 / 栅格底图，空 = 继承上一个时间点）
    maps: [],       // { id, name, dataUrl } 图片底图
    rasterMaps: [], // { id, name, w, h, dataUrl } 栅格底图（PNG：R=高度 G=河流）
    entries: [],    // { id, title, description, image, lat, lng, color, from, to }
    routes: [],     // { id, title, description, color, points: [{lat,lng}...], from, to }
    regions: [],    // { id, name, description, color, ring: [[lng,lat]...], from, to }
  };
}

/** 导入/恢复时兜底：补齐缺失字段，失败抛错 */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('不是合法的项目对象');
  if (raw.version !== 1) throw new Error(`不支持的项目版本：${raw.version}`);
  const p = createProject({ name: raw.name, description: raw.description });
  p.timePoints = Array.isArray(raw.timePoints) ? raw.timePoints.filter((t) => t?.id) : [];
  p.maps = Array.isArray(raw.maps) ? raw.maps.filter((m) => m?.id && typeof m.dataUrl === 'string') : [];
  p.rasterMaps = Array.isArray(raw.rasterMaps)
    ? raw.rasterMaps.filter((m) => m?.id && typeof m.dataUrl === 'string' && m.w > 0 && m.h > 0)
    : [];
  const okRange = (it) => it && typeof it === 'object';
  p.entries = Array.isArray(raw.entries) ? raw.entries.filter(okRange) : [];
  p.routes = Array.isArray(raw.routes) ? raw.routes.filter(okRange) : [];
  p.regions = Array.isArray(raw.regions) ? raw.regions.filter(okRange) : [];
  return p;
}

const KINDS = {
  entry: { list: (p) => p.entries },
  route: { list: (p) => p.routes },
  region: { list: (p) => p.regions },
};

export function getList(project, kind) {
  return KINDS[kind].list(project);
}

export function getItem(project, kind, id) {
  return getList(project, kind).find((it) => it.id === id) ?? null;
}

function nextColor(project) {
  const used = ['entry', 'route', 'region'].flatMap((k) => getList(project, k).map((it) => it.color));
  return PALETTE.find((c) => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length];
}

// ---------------------------------------------------------------- 时间点

export function addTimePoint(project, { label = '新时间点', mapId = null, rmapId = null, id = uid('tp') } = {}) {
  const tp = { id, label, mapId, rmapId };
  project.timePoints.push(tp);
  return tp;
}

export function updateTimePoint(project, id, patch) {
  const tp = project.timePoints.find((t) => t.id === id);
  if (!tp) return null;
  if ('label' in patch) tp.label = String(patch.label || tp.label);
  if ('mapId' in patch) tp.mapId = patch.mapId;   // null 表示继承
  if ('rmapId' in patch) tp.rmapId = patch.rmapId; // 栅格底图优先于图片底图
  return tp;
}

/**
 * 删除时间点，并级联修复内容的时间范围引用：
 * from 指向被删点 → 改为前一个点（没有则 null 自始）；
 * to 指向被删点 → 改为后一个点（没有则 null 至今）。
 */
export function removeTimePoint(project, id) {
  const i = project.timePoints.findIndex((t) => t.id === id);
  if (i === -1) return false;
  const prev = project.timePoints[i - 1]?.id ?? null;
  const next = project.timePoints[i + 1]?.id ?? null;
  project.timePoints.splice(i, 1);
  for (const kind of ['entry', 'route', 'region']) {
    for (const it of getList(project, kind)) {
      if (it.from === id) it.from = prev;
      if (it.to === id) it.to = next;
    }
  }
  // 其他时间点若继承的是被删点的底图，向上找到最近的非空 mapId 由 mapIdAt 兜底，无需处理
  return true;
}

/** 解析某时间点的图片底图（沿时间轴向上找最近的非空 mapId），返回 map 对象或 null */
export function mapAt(project, index) {
  for (let i = Math.min(index, project.timePoints.length - 1); i >= 0; i--) {
    const mapId = project.timePoints[i]?.mapId;
    if (mapId) return project.maps.find((m) => m.id === mapId) ?? null;
  }
  return null;
}

/** 解析某时间点的栅格底图（规则同 mapAt），返回 rasterMap 对象或 null */
export function rasterAt(project, index) {
  for (let i = Math.min(index, project.timePoints.length - 1); i >= 0; i--) {
    const rmapId = project.timePoints[i]?.rmapId;
    if (rmapId) return project.rasterMaps.find((m) => m.id === rmapId) ?? null;
  }
  return null;
}

/** 某张栅格底图被多少个时间点沿继承链实际使用（判断共享，编辑前决定是否复制快照） */
export function rasterUsersAt(project, rasterId, uptoIndex) {
  let n = 0;
  for (let i = 0; i <= Math.min(uptoIndex, project.timePoints.length - 1); i++) {
    const tp = project.timePoints[i];
    const effective = (() => {
      for (let j = i; j >= 0; j--) {
        if (project.timePoints[j]?.rmapId) return project.timePoints[j].rmapId;
      }
      return null;
    })();
    if (effective === rasterId) n++;
  }
  return n;
}

// ---------------------------------------------------------------- 底图

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

export function getRasterMap(project, id) {
  return project.rasterMaps.find((m) => m.id === id) ?? null;
}

// ---------------------------------------------------------------- 条目/路线/区域

const DEFAULTS = {
  entry: (d) => ({
    title: '新条目', description: '', image: null,
    lat: 0, lng: 0, ...d,
  }),
  route: (d) => ({
    title: '新路线', description: '', points: [], ...d,
  }),
  region: (d) => ({
    name: '新区域', description: '', ring: [], ...d,
  }),
};

export function addItem(project, kind, data = {}) {
  // 过滤掉显式传入的 undefined，避免覆盖 id/color 等默认值
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const item = {
    id: uid(kind === 'entry' ? 'e' : kind === 'route' ? 'r' : 'rg'),
    color: nextColor(project),
    from: project.timePoints[0]?.id ?? null, // 默认从第一个时间点开始
    to: null,                                 // 默认至今
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
  return true;
}

// ---------------------------------------------------------------- 切面可见性

function indexOfTp(project, tpId, fallback) {
  if (tpId == null) return fallback;
  const i = project.timePoints.findIndex((t) => t.id === tpId);
  return i === -1 ? fallback : i; // 引用了已删除的时间点（脏数据）→ 按端点开放处理
}

/** 内容在某时间点下标处是否可见 */
export function isActiveAt(project, index, item) {
  const fi = indexOfTp(project, item.from, 0);
  const ti = indexOfTp(project, item.to, Infinity);
  return fi <= index && index <= ti;
}

/** 当前切面下应显示的内容 */
export function activeItems(project, kind, index) {
  return getList(project, kind).filter((it) => isActiveAt(project, index, it));
}

/** 统计信息（检查器概览用） */
export function stats(project) {
  return {
    timePoints: project.timePoints.length,
    maps: project.maps.length,
    entries: project.entries.length,
    routes: project.routes.length,
    regions: project.regions.length,
  };
}
