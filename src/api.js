/**
 * 对外编程接口，挂在 window.world 上：
 * 可在控制台、自动化脚本（scripts/verify-world.mjs）里驱动整个工具。
 */
export function installAPI({ ctx, project }) {
  const get = () => project();

  const api = {
    // —— 时间轴 ——
    listTimePoints: () => get()?.timePoints.map((t, i) => ({ index: i, id: t.id, label: t.label })) ?? [],
    setTime: (index) => ctx.setTime(index),
    addTimePoint: (label = '新时间点') => { const tp = ctx.addTimePoint({ label }); return tp?.id; },

    // —— 内容 ——
    /** 当前切面可见的条目 */
    listEntries: () => ctx.activeEntries(),
    addEntry: (data) => ctx.addEntryViaApi(data),
    addRoute: (data) => ctx.addRouteViaApi(data),
    addRegion: (data) => ctx.addRegionViaApi(data),
    removeItem: (kind, id) => ctx.removeItem(kind, id),

    // —— 相机 ——
    flyTo: (lat, lng, opts = {}) => ctx.flyTo(lat, lng, opts),
    where: () => ctx.where(),

    // —— 地形 ——
    /** 打开当前时代的地形工坊 */
    openWorkshop: () => ctx.openWorkshop(),
    /** 为当前时代生成真实地球地形（高程+河流） */
    generateRealEarth: () => ctx.generateRealEarth(),
    /** 导入真实城市（Natural Earth 243 城）为条目 */
    importCities: () => ctx.importCities(),
    /** 采样某经纬度的归一化高度（-1..1，0=海平面），无地形返回 null */
    sampleTerrain: (lat, lng) => ctx.sampleTerrain(lat, lng),
    /** 在指定经纬度涂画笔：{ tool: 'raise'|'lower'|'smooth'|'river', size, strength, passes } */
    paintTerrain: (lat, lng, opts) => ctx.paintTerrain(lat, lng, opts),

    // —— 项目 ——
    getProject: () => structuredClone(get()),
    exportProject: () => ctx.exportProject(),
    loadSample: () => ctx.loadSample(),

    help,
  };

  function help() {
    // eslint-disable-next-line no-console
    console.log(
      '%c window.world API %c\n'
      + 'world.listTimePoints()                          时间点列表\n'
      + 'world.setTime(index)                            切换切面\n'
      + "world.addTimePoint('第三纪')                     新增时间点\n"
      + 'world.listEntries()                             当前切面的条目\n'
      + "world.addEntry({ title, lat, lng, from, to })    加条目（from/to 传时间点 id 或 null）\n"
      + "world.addRoute({ title, points: [{lat,lng}...] }) 加路线\n"
      + "world.addRegion({ name, ring: [[lng,lat]...] })  加区域\n"
      + 'world.flyTo(lat, lng, { distance, duration })    飞到坐标\n'
      + 'world.openWorkshop() / generateRealEarth()       地形工坊 / 真实地球\n'
      + 'world.importCities()                             导入真实城市\n'
      + 'world.paintTerrain(lat, lng, { tool, size, strength, passes }) 涂画笔\n'
      + 'world.sampleTerrain(lat, lng)                    查询归一化高度\n'
      + 'world.getProject() / exportProject()            项目读写\n'
      + 'world.loadSample()                              载入示例世界',
      'background:#6ea8ff;color:#000;padding:2px 6px;border-radius:4px 0 0 4px;font-weight:bold',
      'background:rgba(110,168,255,.15);color:#dfe7ff;padding:2px 8px;border-radius:0 4px 4px 0',
    );
  }

  window.world = api;
  return api;
}
