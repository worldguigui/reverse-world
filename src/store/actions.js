/**
 * 跨分片动作：需要异步 IO、浏览器文件、外部数据下载，或需要直接驱动三维句柄的操作。
 * 单纯的数据增删改放在 world 分片；这里放「一次要协调好几件事」的那些。
 */
import * as P from '../core/project.js';
import { buildRealEarthGrid, importCitiesAsEntries } from '../core/realearth.js';
import { importProjectFile } from '../core/storage.js';
import { buildSampleProject } from '../core/sample.js';
import { session } from '../session.js';
import { fileToDataUrl, pickFile } from '../utils/files.js';

/** 工坊面板的打开方式由 main.js 在组装期注入（它需要拿三维句柄做实时预览） */
let hooks = { openWorkshop: () => {} };
export function setViewHooks(next) { hooks = { ...hooks, ...next }; }

/** 取当前生效的时间点下标；tpId 未指定时用当前切面 */
function resolveTimeIndex(p, tpId, timeIndex) {
  if (!p) return -1;
  return p.timePoints.findIndex((t) => t.id === (tpId ?? p.timePoints[timeIndex]?.id));
}

export const createActionsSlice = (set, get) => ({
  // ---------------------------------------------------------------- 底图与地形

  /** 选图上传为图片底图，并绑定到指定时间点 */
  async uploadMap(tpId) {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file, 4096); // 底图保留高分辨率
      let map;
      get().mutateProject((p) => {
        map = P.addMap(p, { name: file.name.replace(/\.[^.]+$/, ''), dataUrl });
        P.updateTimePoint(p, tpId, { mapId: map.id });
      });
      get().touchEra();
        get().toast(`底图「${map.name}」已上传`);
    } catch (err) {
      get().toast(`底图上传失败：${err.message}`);
    }
  },

  /** 下载并解码真实地球高程+河流，作为当前时间点的栅格底图 */
  async generateRealEarth(tpId) {
    const p = get().project;
    const idx = resolveTimeIndex(p, tpId, get().timeIndex);
    if (idx < 0) { get().toast('请先在底部时间轴创建时间点'); return; }
    get().toast('正在下载/解码真实地球地形…');
    try {
      const grid = await buildRealEarthGrid(512);
      const tp = p.timePoints[idx];
      let rmap;
      get().mutateProject((proj) => {
        rmap = P.addRasterMap(proj, {
          name: `真实地球 · ${tp.label}`, w: grid.w, h: grid.h, dataUrl: grid.encodePNG(),
        });
        P.updateTimePoint(proj, tp.id, { rmapId: rmap.id });
      });
      // 先填缓存再切时间点，切换时的底图解码就能直接命中
      session.gridCache.set(rmap.id, grid);
      get().setTime(idx);
      get().touchEra(); // 时间点没变时 setTime 不会触发换底图，这里补一次
        get().toast('真实地球地形已生成——喜马拉雅就在那里，试试用工坊改造它');
    } catch (err) {
      get().toast(`真实地球生成失败：${err.message}`);
    }
  },

  /** 导入真实城市（含人口）为条目 */
  async importCities(tpId) {
    const p = get().project;
    const tp = p?.timePoints[resolveTimeIndex(p, tpId, get().timeIndex)];
    if (!tp) { get().toast('请先在底部时间轴创建时间点'); return; }
    get().toast('正在导入真实城市…');
    try {
      const n = await importCitiesAsEntries(p, tp.id);
      get().mutateProject(() => {}); // 数据已被就地写入，这里只需重建快照与保存
        get().toast(`已导入 ${n} 座城市（含人口，球面点选可查看）`);
    } catch (err) {
      get().toast(`城市导入失败：${err.message}`);
    }
  },

  openWorkshop(tpId) { hooks.openWorkshop(tpId); },

  /** 采样某经纬度的归一化高度；没有地形时返回 null */
  sampleTerrain(lat, lng) {
    return session.currentGrid ? session.currentGrid.sample(lat, lng) : null;
  },

  /**
   * 用画笔在指定经纬度改地形（编程接口/自动化用）。
   * 画笔改的是内存里的网格，必须重新编码回 PNG 才会被持久化。
   */
  paintTerrain(lat, lng, { tool = 'raise', size = 10, strength = 0.08, passes = 1 } = {}) {
    const g = session.currentGrid;
    const p = get().project;
    if (!g || !p) return null;
    const cx = ((lng + 180) / 360) * g.w;
    const cy = ((90 - lat) / 180) * g.h;
    // 每一笔返回的脏区都一样（同一个圆心、同一个半径），最后那个就是并集；
    // 拿它去重绘颜色画布，省掉整张 512×256 的全量重算
    let dirty = null;
    for (let i = 0; i < passes; i++) dirty = g.applyBrush(tool, cx, cy, size, strength);
    g.renderColor(dirty);
    // 这里刻意不走 mutateProject：它会连 derived 快照一起重建，而 bridge 一见 derived
    // 变化就把标注/路线/区域整层重做（50 张标注贴图全部重画）——条目一条没变，
    // 纯属白干。stats 不含地形像素，跳过重建不会让面板显示过期数据。
    const rmap = P.rasterAt(p, get().timeIndex);
    if (rmap) rmap.dataUrl = g.encodePNG();
    session.autosaver?.save(p);
    session.globe?.updateRasterTextures();
    get().touchLayout(); // 内容没变，只是地形变了 → 重新贴地
    return g.sample(lat, lng);
  },

  // ---------------------------------------------------------------- 项目载入

  async loadSample() {
    const p = await buildSampleProject();
    get().loadProjectInto(p);
    get().toast('示例世界已载入：试试底部时间轴切换两个时代');
  },

  async importFile(file) {
    try {
      const p = await importProjectFile(file);
      get().loadProjectInto(p);
      get().toast(`已导入「${p.name}」`);
    } catch (err) {
      get().toast(`导入失败：${err.message}`);
    }
  },

  // ---------------------------------------------------------------- 相机

  flyTo(lat, lng, opts) { session.rig?.flyToLatLng(lat, lng, opts); },
  where: () => session.rig?.getLatLngZoom(),

  /** 飞到某个内容的代表位置（路线的首个途经点、区域的第一个顶点） */
  flyToItem(kind, item) {
    let lat, lng;
    if (kind === 'entry') { lat = item.lat; lng = item.lng; }
    else if (kind === 'route') { ({ lat, lng } = item.points[0] ?? {}); }
    else { ([, lat, lng] = [null, item.ring[0]?.[1], item.ring[0]?.[0]]); }
    if (lat == null) return;
    get().flyTo(lat, lng);
  },

  // ---------------------------------------------------------------- 其他

  /** 选一张本地图片，返回 File（取消则 null） */
  pickImage: () => pickFile('image/*'),

  /** 编程接口的删除入口，与界面删除同一套逻辑 */
  removeItem(kind, id) { get().deleteItem(kind, id); },
});
