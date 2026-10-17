/**
 * 旧项目迁移。
 *
 * v1 的模型是「时间点槽位容器」：每个时间点自带一张地图 / 一套地形，内容是第几个槽位上的东西。
 * v2 换成了「一张脸 + 一根游标」：球只有一张地图，内容自带数值年份，切面由游标求值得到。
 *
 * 迁移的目标是尽量不丢数据：
 *   - 球只剩一张脸 —— 取最后一个带栅格地形的时间点，也就是「世界演进至今的样子」；
 *   - 内容的时间锚点由「时间点 id」换成「数值年」，找不到的锚点留空（等价于旧的开放端点）；
 *   - 旧时间点本身变成一条没有坐标的事件 —— 它本来就是「那个时刻发生的事」，
 *     这样时间轴上仍有刻度。
 * 真正丢掉的是逐时代的地图与地形、旧版的图片底图，以及旧模型里的地点：地点这一等实体已经取消，
 * 它们没有对应的新形状，硬塞成事件只会把「哪一年发生了什么」变成一张地名表。
 */

/** v1 时间点 id → 它在时间轴上的序号；找不到（脏数据）按开放端点处理 */
function yearOf(timePoints, tpId, fallback) {
  if (tpId == null) return null;
  const i = timePoints.findIndex((t) => t.id === tpId);
  return i === -1 ? fallback : i;
}

/** 取最后一个带该字段的时间点的对应地图 id —— 世界演进至今的那张脸 */
function lastOf(timePoints, field) {
  for (let i = timePoints.length - 1; i >= 0; i--) {
    if (timePoints[i]?.[field]) return timePoints[i][field];
  }
  return null;
}

/**
 * v1 → v2。收的是一份原始对象（可能来自 IndexedDB，也可能来自导入的文件），
 * 返回一份 v2 形状的对象；版本认不出来就抛错。字段的兜底校验交给 normalizeProject。
 */
export function migrateProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('不是合法的项目对象');
  if (raw.version !== 1) throw new Error(`不支持的项目版本：${raw.version}`);

  const timePoints = Array.isArray(raw.timePoints) ? raw.timePoints.filter((t) => t?.id) : [];

  // 旧时间点 → 只有年份、没有坐标的瞬时事件。id 原样留着，它是不可解释的字符串，改名没有意义
  const events = timePoints.map((tp, i) => ({
    id: tp.id,
    title: tp.label ?? `第 ${i + 1} 个时间点`,
    description: '',
    image: tp.image ?? null,
    lat: null,
    lng: null,
    from: i,
    to: null,
  }));

  const shift = (list) => (Array.isArray(list) ? list.filter((it) => it && typeof it === 'object') : [])
    .map((it) => ({
      ...it,
      from: yearOf(timePoints, it.from, null),
      to: yearOf(timePoints, it.to, null),
    }));

  return {
    version: 2,
    name: raw.name,
    description: raw.description,
    baseRasterId: lastOf(timePoints, 'rmapId'),
    rasterMaps: raw.rasterMaps,
    events: [...shift(raw.events), ...events],
    routes: shift(raw.routes),
    regions: shift(raw.regions),
  };
}
