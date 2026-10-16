/**
 * 对外编程接口，挂在 window.world 上：
 * 可在控制台、自动化脚本（scripts/verify-world.mjs）里驱动整个工具。
 *
 * 时间轴只有一根游标（数值年，负数为公元前），没有「第几个切面」这种槽位概念：
 * setCursor(1914) 就是「看 1914 年那一刻的全场」。
 */
import { timeDomain } from './core/timeline.js';

export function installAPI({ ctx, project, cursor }) {
  const get = () => project();

  const api = {
    // —— 时间轴 ——
    /** 游标停在哪一年。走 getter 现取：ctx 是组装那一刻的状态快照，读它的字段会一直停在初始值 */
    getCursor: () => cursor(),
    setCursor: (year) => ctx.setCursor(year),
    /** 时间轴定义域 { min, max, start, end }；没有任何内容带时间时是 null */
    getDomain: () => timeDomain(get()),
    /** 前后跳一个刻度 */
    stepCursor: (dir) => ctx.stepCursor(dir),
    /** 跳到某条事件发生的那一年，并把它飞进视野 */
    jumpToEvent: (id) => ctx.jumpToEvent(id),
    /** 摊开 / 收起编年史长卷 */
    showChronicle: (open = true) => ctx.setChronicleOpen(open),

    // —— 内容 ——
    /** 当前游标下在场的地点 */
    listEntries: () => ctx.activeEntries(),
    addEntry: (data) => ctx.addEntryViaApi(data),
    /** 当前游标下在场的事件（含没有地点的纯叙事事件） */
    listEvents: () => ctx.activeEvents(),
    addEvent: (data) => ctx.addEventViaApi(data),
    addRoute: (data) => ctx.addRouteViaApi(data),
    addRegion: (data) => ctx.addRegionViaApi(data),
    removeItem: (kind, id) => ctx.removeItem(kind, id),

    // —— 人物 ——
    /** 全部人物。人物不分在场：生卒是生平，不拿来筛事件 */
    listCharacters: () => ctx.characters(),
    addCharacter: (data) => ctx.addCharacterViaApi(data),
    /** 某个人物涉及的事件，按时间先后。反向关系现算，人物上不存清单 */
    eventsOfCharacter: (id) => ctx.eventsOfCharacter(id),

    // —— 章节与视图条件 ——
    /** 全部章节，按录入先后 */
    listGroups: () => ctx.groups(),
    addGroup: (data) => ctx.addGroupViaApi(data),
    /** 某个章节里的事件，按时间先后 */
    eventsOfGroup: (id) => ctx.eventsOfGroup(id),
    /** 当前视图条件 { groupId, characterId }，两者都空就是「全部」 */
    getViewFilter: () => ctx.currentView(),
    /** 只看某一章（收窄长卷、时间轴刻度与球上的事件；地点路线区域不受影响） */
    filterByGroup: (id) => ctx.setViewFilter({ groupId: id ?? null, characterId: null }),
    /**
     * 只看某个人物涉及的事件。这一组是**算出来的**——不落盘、不进 chapters，
     * 换成别的筛选就没了。收窄的是事件的在场集合，不是数据本身。
     */
    filterByCharacter: (id) => ctx.setViewFilter({ groupId: null, characterId: id ?? null }),
    /** 退出筛选，长卷与时间轴回到「全部」 */
    clearFilter: () => ctx.setViewFilter({ groupId: null, characterId: null }),

    // —— 相机 ——
    flyTo: (lat, lng, opts = {}) => ctx.flyTo(lat, lng, opts),
    where: () => ctx.where(),
    /** 复位视角：地平线掰回正北，飞回设置里的初始经纬度 */
    resetView: () => ctx.resetView(),

    // —— 地形 ——
    /** 打开地形工坊 */
    openWorkshop: () => ctx.openWorkshop(),
    /** 生成真实地球地形（高程+河流） */
    generateRealEarth: () => ctx.generateRealEarth(),
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
      + 'world.getCursor() / setCursor(year)             游标停在哪一年（负数 = 公元前）\n'
      + 'world.getDomain()                               时间轴定义域，没有内容带时间时是 null\n'
      + 'world.stepCursor(±1) / jumpToEvent(id)          前后跳一个刻度 / 跳到某条事件\n'
      + 'world.showChronicle(true)                       摊开 / 收起编年史长卷\n'
      + 'world.listEntries()                             当前游标下在场的地点\n'
      + "world.addEntry({ title, lat, lng, from, to })    加地点（from/to 是年份，留空 = 常驻）\n"
      + 'world.listEvents()                              当前游标下在场的事件\n'
      + "world.addEvent({ title, lat, lng, from, to })    加事件（lat/lng 可省 = 纯叙事，不上球）\n"
      + "world.addRoute({ title, points: [{lat,lng}...] }) 加路线\n"
      + "world.addRegion({ name, ring: [[lng,lat]...] })  加区域\n"
      + 'world.listGroups() / eventsOfGroup(id)          章节清单 / 某章里的事件\n'
      + "world.addGroup({ name })                         加章节\n"
      + 'world.filterByGroup(id) / filterByCharacter(id)  只看某一章 / 某个人物涉及的事件\n'
      + 'world.getViewFilter() / clearFilter()           当前筛选条件 / 退出筛选\n'
      + 'world.listCharacters()                        全部人物\n'
      + "world.addCharacter({ name, aliases, born, died })  加人物（born/died 留空 = 不详）\n"
      + 'world.eventsOfCharacter(id)                     某个人物涉及的事件\n'
      + 'world.flyTo(lat, lng, { level, distance, duration }) 飞到坐标（level = 落到哪一档）\n'
      + 'world.where() / resetView()                     当前视角（经纬度/距离/档位）/ 复位视角\n'
      + 'world.openWorkshop() / generateRealEarth()       地形工坊 / 真实地球\n'
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
