/**
 * 跨分片动作：需要异步 IO、浏览器文件、外部数据下载，或需要直接驱动三维句柄的操作。
 * 单纯的数据增删改放在 world 分片；这里放「一次要协调好几件事」的那些。
 */
import * as P from '../core/project.js';
import { buildRealEarthGrid } from '../core/realearth.js';
import { importProjectFile } from '../core/storage.js';
import { buildSampleProject } from '../core/sample.js';
import { session } from '../session.js';
import { latLngToVec3, vec3ToLatLng } from '../utils.js';
import { pickFile } from '../utils/files.js';

/** 工坊面板的打开方式由 main.js 在组装期注入（它需要拿三维句柄做实时预览） */
let hooks = { openWorkshop: () => {} };
export function setViewHooks(next) { hooks = { ...hooks, ...next }; }

export const createActionsSlice = (set, get) => ({
  // ---------------------------------------------------------------- 舞台：地图与地形

  /** 下载并解码真实地球高程与水，作为全局地图 */
  async generateRealEarth() {
    if (!get().project) return;
    get().toast('正在下载/解码真实地球地图…');
    try {
      const grid = await buildRealEarthGrid();
      let rmap;
      get().mutateProject((p) => {
        rmap = P.addRasterMap(p, { name: '真实地球', w: grid.w, h: grid.h, dataUrl: grid.encodePNG() });
        p.baseRasterId = rmap.id;
      });
      // 先填缓存再换舞台，贴图时就能直接命中，不必再解一次码
      session.gridCache.set(rmap.id, grid);
      get().touchStage();
      get().toast('真实地球地图已生成——喜马拉雅就在那里，试试用工坊改造它');
    } catch (err) {
      get().toast(`真实地球生成失败：${err.message}`);
    }
  },

  openWorkshop() { hooks.openWorkshop(); },

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
    // 拿它去重绘颜色画布，省掉整张网格的全量重算
    let dirty = null;
    for (let i = 0; i < passes; i++) dirty = g.applyBrush(tool, cx, cy, size, strength);
    g.renderColor(dirty);
    // 这里刻意不走 mutateProject：它会连 derived 快照一起重建，而 bridge 一见 derived
    // 变化就把路线/区域整层重做——内容一条没变，
    // 纯属白干。stats 不含地形像素，跳过重建不会让面板显示过期数据。
    const rmap = P.getRasterMap(p, p.baseRasterId);
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
    get().toast('示例世界已载入：拖动底部游标，看一战的事件依次登场');
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

  /** 复位视角：把地平线掰回正北、飞回初始经纬度。自由翻滚之后靠它回家 */
  resetView() { session.rig?.resetView(); },

  /**
   * 把镜头对准内容实际占着的那片地方。
   *
   * 载入一份世界之后必须做这件事：初始视角是画面设置里的固定经纬度，
   * 而内容在哪完全是另一回事——落在地球另一面时，打开只看得到一片空球，
   * 得自己转半天才找得到东西。
   *
   * 取的是所有带坐标内容的平均方向（先转成三维向量再平均，
   * 直接在经纬度上取平均会在换日线附近得出一个荒唐的结果）。
   * 内容绕球一圈、平均值缩回原点时作废——那种情况下没有「中心」可言。
   */
  aimAtContent() {
    const p = get().project;
    const rig = session.rig;
    if (!p || !rig) return;
    // 累加器借一个三维向量：半径为 0 时它正好是原点，从零开始加
    const sum = latLngToVec3(0, 0, 0);
    let n = 0;
    const add = (lat, lng) => {
      if (lat == null || lng == null) return;
      sum.add(latLngToVec3(lat, lng, 1));
      n++;
    };
    for (const it of p.events) add(it.lat, it.lng);
    for (const r of p.routes) for (const pt of r.points) add(pt.lat, pt.lng);
    for (const r of p.regions) for (const [lng, lat] of r.ring) add(lat, lng);
    if (!n) return;
    sum.divideScalar(n);
    // 内容绕着球撒了一圈时平均值缩回原点，指向哪边都一样——那就别动镜头
    if (sum.length() < 0.1) return;
    const { lat, lng } = vec3ToLatLng(sum);
    rig.flyToLatLng(lat, lng, { duration: 900 });
  },

  /** 飞到某个内容的代表位置（事件的坐标、路线的首个途经点、区域的第一个顶点） */
  flyToItem(kind, item) {
    let lat, lng;
    if (kind === 'event') { lat = item.lat; lng = item.lng; }
    else if (kind === 'route') { ({ lat, lng } = item.points[0] ?? {}); }
    else if (kind === 'region') { lat = item.ring[0]?.[1]; lng = item.ring[0]?.[0]; }
    // 没有坐标的纯叙事事件、空路线、空环都飞不了，静默返回
    if (lat == null || lng == null) return;
    get().flyTo(lat, lng);
  },

  /**
   * 跳到某条事件发生的那一年，并把镜头带到它那儿。
   *
   * 转过去的同时还要落到「事件档位」上（画面设置里那一档）：只转方向的话，
   * 停在出厂视角点开是一条安静的球，放大到贴地时点开又只挪了挪中心，两头都没有「到了」的意思。
   * 落到固定档位则不管从哪儿点开，看到的都是同一个尺度。
   */
  jumpToEvent(id) {
    const p = get().project;
    const ev = p ? P.getItem(p, 'event', id) : null;
    if (!ev) return;
    if (typeof ev.from === 'number') get().setCursorYear(ev.from);
    get().select({ kind: 'event', id });
    if (ev.lat != null && ev.lng != null) {
      get().flyTo(ev.lat, ev.lng, { level: get().viewConfig.camera.eventLevel });
    }
  },

  // ---------------------------------------------------------------- 其他

  /** 选一张本地图片，返回 File（取消则 null） */
  pickImage: () => pickFile('image/*'),

  /** 编程接口的删除入口，与界面删除同一套逻辑 */
  removeItem(kind, id) { get().deleteItem(kind, id); },
});
