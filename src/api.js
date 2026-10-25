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
    /** 当前游标下在场的事件（含没有坐标的纯叙事事件） */
    listEvents: () => ctx.activeEvents(),
    addEvent: (data) => ctx.addEventViaApi(data),
    addRoute: (data) => ctx.addRouteViaApi(data),
    addRegion: (data) => ctx.addRegionViaApi(data),
    removeItem: (kind, id) => ctx.removeItem(kind, id),

    // —— 人物 ——
    /** 全部人物。人物不分在场：生卒日期是生平，不拿来筛事件 */
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
    /** 当前视图条件：选中的章节列表与实时人物筛 */
    getViewFilter: () => ctx.currentView(),
    /** 只看某一章（收窄长卷、时间轴刻度与球上的事件；路线与区域不受影响）。替换当前章节选择 */
    filterByGroup: (id) => ctx.setViewFilter({ groupIds: id ? [id] : [] }),
    /**
     * 只看某个人物涉及的事件。这是一层实时的视图条件，与已选中的章节取交集；
     * 与编年史里按姓名搜索新建的章节是两件事：后者是一个普通章节，清单不会自己更新。
     */
    filterByCharacter: (id) => ctx.setViewFilter({ characterId: id ?? null }),
    /** 退出筛选：取消所有选中的集合，章节本身不会被删掉 */
    clearFilter: () => ctx.setViewFilter({ groupIds: [], characterId: null }),

    // —— 相机 ——
    flyTo: (lat, lng, opts = {}) => ctx.flyTo(lat, lng, opts),
    where: () => ctx.where(),
    /** 复位视角：地平线掰回正北，飞回设置里的初始经纬度 */
    resetView: () => ctx.resetView(),

    // —— 地形 ——
    /** 打开地图工坊 */
    openWorkshop: () => ctx.openWorkshop(),
    /** 生成真实地球地图（高程 + 烘焙好的地表颜色） */
    generateRealEarth: () => ctx.generateRealEarth(),
    /** 采样某经纬度的地形高度（0=海平面，设计范围 -4..4；球面渲染按 ±4 截断），无地形返回 null */
    sampleTerrain: (lat, lng) => ctx.sampleTerrain(lat, lng),
    /**
     * 在指定经纬度涂画笔：
     * { tool: 'raise'|'lower'|'smooth'|'paint'|'clearColor',
     *   size, strength, passes, hard, shape: 'round'|'square', color: '#rrggbb' }
     */
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
      + 'world.listEvents()                              当前游标下在场的事件\n'
      + "world.addEvent({ title, lat, lng, from, to, groupIds }) 加事件（from/to 为 Y…YMDHMS，日期与小时用 T，空格后可写备注；lat/lng 可省 = 纯叙事）\n"
      + "world.addRoute({ title, points: [{lat,lng}...] }) 加路线\n"
      + "world.addRegion({ name, ring: [[lng,lat]...] })  加区域\n"
      + 'world.listGroups() / eventsOfGroup(id)          章节清单 / 某章里的事件\n'
      + "world.addGroup({ name })                         加章节\n"
      + 'world.filterByGroup(id) / filterByCharacter(id)  只看某一章 / 某个人物涉及的事件\n'
      + 'world.getViewFilter() / clearFilter()           当前筛选条件 / 退出筛选\n'
      + 'world.listCharacters()                        全部人物\n'
      + "world.addCharacter({ name, aliases, born, died })  加人物（born/died 与事件时间同格式；留空 = 不详）\n"
      + 'world.eventsOfCharacter(id)                     某个人物涉及的事件\n'
      + 'world.flyTo(lat, lng, { level, distance, duration }) 飞到坐标（level = 落到哪一档）\n'
      + 'world.where() / resetView()                     当前视角（经纬度/距离/档位）/ 复位视角\n'
      + 'world.openWorkshop() / generateRealEarth()       地图工坊 / 真实地球\n'
      + 'world.paintTerrain(lat, lng, { tool, size, strength, passes, hard, shape, color }) 涂画笔\n'
      + 'world.sampleTerrain(lat, lng)                    查询地形高度（0=海平面）\n'
      + 'world.getProject() / exportProject()            项目读写\n'
      + 'world.loadSample()                              载入示例世界',
      'background:#6ea8ff;color:#000;padding:2px 6px;border-radius:4px 0 0 4px;font-weight:bold',
      'background:rgba(110,168,255,.15);color:#dfe7ff;padding:2px 8px;border-radius:0 4px 4px 0',
    );
  }

  window.world = api;
  return api;
}
