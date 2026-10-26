/**
 * 跨分片动作：需要异步 IO、浏览器文件、外部数据下载，或需要直接驱动三维句柄的操作。
 * 单纯的数据增删改放在 world 分片；这里放「一次要协调好几件事」的那些。
 */
import * as P from '../core/project.js';
import { buildRealEarthGrid, EARTH_RES } from '../core/realearth.js';
import { hexTo565 } from '../core/raster.js';
import { importProjectFile } from '../core/storage.js';
import {
  saveProjectToCloud, loadProjectFromCloud, rememberCloudToken, formatCloudTime,
} from '../core/cloud.js';
import { buildSampleProject } from '../core/sample.js';
import { session } from '../session.js';
import { timeYear } from '../core/datetime.js';
import { latLngToVec3, vec3ToLatLng } from '../utils.js';
import { pickFile } from '../utils/files.js';
import { IMAGE_UPLOAD } from '../config.js';

/** 工坊面板的打开方式由 main.js 在组装期注入（它需要拿三维句柄做实时预览） */
let hooks = { openWorkshop: () => {} };
export function setViewHooks(next) { hooks = { ...hooks, ...next }; }

/**
 * 等两次 rAF：一次让 React 把加载页提交到 DOM，一次让它真正上屏。
 * 重活开始前必须先让出这两帧，否则进度条要等重活干完才第一次出现。
 * 后台标签页里 rAF 会停摆，所以加一个定时器兜底——宁可少刷一帧，不能卡住不干活。
 */
const nextPaint = () => new Promise((resolve) => {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(finish, 250);
  requestAnimationFrame(() => requestAnimationFrame(finish));
});

/** 等最近一次舞台贴图结束；bridge 每次 applyStage 开始时替换这个 Promise */
const waitForStage = () => session.stageDone ?? Promise.resolve();

export const createActionsSlice = (set, get) => ({
  // ---------------------------------------------------------------- 舞台：地图与地形

  /** 下载并解码真实地球高程与水，作为全局地图 */
  async generateRealEarth() {
    if (!get().project) {
      get().toast('先新建一个世界，再生成地图');
      return;
    }
    if (get().loading) return;
    // 真实地球会换掉当前舞台地形；内容（事件、路线、区域）一条不动，但手绘的地图会被覆盖
    const p = get().project;
    if (P.getRasterMap(p, p.baseRasterId)
        && !confirm('生成真实地球会覆盖当前地形地图，事件、路线与区域都会保留。确定？')) return;
    const title = '正在生成真实地球';
    const show = async (detail, progress) => {
      get().setLoading({ title, detail, progress });
      await nextPaint();
    };
    await show('准备数据…', 0.01);
    try {
      const grid = await buildRealEarthGrid(EARTH_RES, show);
      await show('保存地图…', 0.97);
      let rmap;
      get().mutateProject((p) => {
        const dataUrl = grid.encodePNG();
        // 球只有一张脸：已有舞台就换掉它的内容，不能再往里塞一张新图，
        // 否则旧图会一直留在 rasterMaps 里，每次导出都多背一份几 MB 的 base64
        rmap = P.getRasterMap(p, p.baseRasterId);
        if (rmap) {
          rmap.name = '真实地球';
          rmap.w = grid.w;
          rmap.h = grid.h;
          rmap.dataUrl = dataUrl;
        } else {
          rmap = P.addRasterMap(p, { name: '真实地球', w: grid.w, h: grid.h, dataUrl });
          p.baseRasterId = rmap.id;
        }
      });
      // 先填缓存再换舞台，贴图时就能直接命中，不必再解一次码
      session.gridCache.set(rmap.id, grid);
      get().touchStage();
      await waitForStage();
      await nextPaint();
      get().setLoading(null);
      get().toast('真实地球地图已生成——喜马拉雅就在那里，试试用工坊改造它');
    } catch (err) {
      get().setLoading(null);
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
   * color 只对 paint 笔有效；reliefColor 是高度笔的基色，颜色还会叠加
   * 高度明暗与坡度明暗；shape 对高度笔和颜色笔都有效。
   */
  paintTerrain(lat, lng, {
    tool = 'raise', size = 10, strength = 0.08, passes = 1,
    hard = false, shape = 'round', color = '#2e7aa0', reliefColor = '#6f8f5a',
  } = {}) {
    const g = session.currentGrid;
    const p = get().project;
    if (!g || !p) return null;
    const cx = ((lng + 180) / 360) * g.w;
    const cy = ((90 - lat) / 180) * g.h;
    const color565 = hexTo565(tool === 'paint' ? color : reliefColor);
    // 每一笔返回的脏区都一样（同一个圆心、同一个半径），最后那个就是并集；
    // 拿它去重绘颜色画布，省掉整张网格的全量重算
    let dirty = null;
    for (let i = 0; i < passes; i++) {
      dirty = g.applyBrush(tool, cx, cy, size, strength, hard, shape, color565);
    }
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
    if (get().loading) return;
    const current = get().project;
    if (P.hasContent(current) && !confirm(
      `载入示例世界会替换当前世界「${current.name}」，本机自动保存也会随之更新。确定？`,
    )) return;
    const title = '正在载入示例世界';
    const show = async (detail, progress) => {
      get().setLoading({ title, detail, progress });
      await nextPaint();
    };
    await show('准备数据…', 0.01);
    try {
      const { project, grid } = await buildSampleProject(show);
      // 建好的网格直接进缓存：否则 applyStage 还要把刚编码好的 PNG 再解码一遍
      session.gridCache.set(project.baseRasterId, grid);
      await show('准备舞台…', 0.99);
      get().loadProjectInto(project);
      await waitForStage();
      await nextPaint();
      get().setLoading(null);
      get().toast('示例世界已载入：拖动底部游标，看事件依次登场');
    } catch (err) {
      get().setLoading(null);
      get().toast(`示例世界载入失败：${err.message}`);
    }
  },

  async importFile(file) {
    if (get().loading) return;
    const current = get().project;
    if (P.hasContent(current) && !confirm(
      `导入项目会替换当前世界「${current.name}」，本机自动保存也会随之更新。确定？`,
    )) return;
    get().setLoading({ title: '正在导入项目', detail: '读取文件…', progress: null });
    await nextPaint();
    try {
      // 章节都在 project.groups 里，和手建章节走同一套
      const project = await importProjectFile(file);
      get().setLoading({ title: `正在打开「${project.name}」`, detail: '准备地图…', progress: null });
      await nextPaint();
      get().loadProjectInto(project);
      await waitForStage();
      await nextPaint();
      get().setLoading(null);
      get().toast(`已导入「${project.name}」`);
    } catch (err) {
      get().setLoading(null);
      get().toast(`导入失败：${err.message}`);
    }
  },

  /**
   * 显式上传当前项目。成功后记住令牌，下次打开对话框不必再输入。
   * 云端不参与自动保存：本机的键入仍只落 IndexedDB，只有点这个按钮才会上传。
   */
  async saveToCloud(token) {
    const p = get().project;
    if (!p) throw new Error('当前没有可保存的项目');
    const info = await saveProjectToCloud(p, token);
    rememberCloudToken(token);
    get().toast(`已保存到云端（${formatCloudTime(info.savedAt)}）`);
    return info;
  },

  /**
   * 下载云端项目。先下载并校验，再问是否替换——坏档不会在确认之前污染当前世界。
   * 确认后走 loadProjectInto，因此本机自动保存、三维重建与镜头对准都和导入文件一致。
   */
  async loadFromCloud(token) {
    const info = await loadProjectFromCloud(token);
    rememberCloudToken(token);

    const current = get().project;
    if (P.hasContent(current) && !confirm(
      `载入「${info.project.name}」（云端保存于 ${formatCloudTime(info.savedAt)}）`
      + `会替换当前世界「${current.name}」，本机自动保存也会随之更新。确定？`,
    )) return null;

    get().setLoading({ title: `正在打开「${info.project.name}」`, detail: '准备地图…', progress: null });
    await nextPaint();
    try {
      get().loadProjectInto(info.project);
      await waitForStage();
      await nextPaint();
    } finally {
      get().setLoading(null);
    }
    get().toast(`已从云端载入「${info.project.name}」`);
    return info;
  },

  // ---------------------------------------------------------------- 相机

  flyTo(lat, lng, opts) { session.rig?.flyToLatLng(lat, lng, opts); },
  where: () => session.rig?.getLatLngZoom(),

  /** 复位视角：把地平线掰回正北、飞回初始经纬度。自由翻滚之后靠它回家 */
  resetView() { session.rig?.resetView(); },

  /**
   * 设置面板的档位滑块：不走 viewConfig，直接落到与滚轮相同的当前档位。
   * 镜头会夹取并回调实际值，滑块以回调为准。
   */
  setCameraLevel(level) {
    const applied = session.rig?.setLevel(level);
    get().syncCameraLevel(applied ?? level);
  },

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
    const year = timeYear(ev.from);
    if (year != null) get().setCursorYear(year);
    get().select({ kind: 'event', id });
    if (ev.lat != null && ev.lng != null) {
      get().flyTo(ev.lat, ev.lng, { level: get().viewConfig.camera.eventLevel });
    }
  },

  // ---------------------------------------------------------------- 其他

  /**
   * 选一张本地图片，返回 File（取消则 null）。
   * 超过体积上限的图片在这里就挡掉：不进入压缩与 FileReader，避免把内存顶爆。
   */
  pickImage: async () => {
    const file = await pickFile('image/*');
    if (!file) return null;
    if (file.size > IMAGE_UPLOAD.maxBytes) {
      const mb = Math.round(IMAGE_UPLOAD.maxBytes / (1024 * 1024));
      get().toast(`图片不能超过 ${mb} MB，请先压缩或换一张`);
      return null;
    }
    return file;
  },

  /** 编程接口的删除入口，与界面删除同一套逻辑 */
  removeItem(kind, id) { get().deleteItem(kind, id); },
});
