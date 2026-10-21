/**
 * store 与三维之间的唯一订阅点：数据一变，由这里决定三维该怎么跟着动。
 * 面板不在这一层驱动——React 面板自己订阅 store。main.js 组装完场景后调用 initBridge()。
 */
import * as P from './core/project.js';
import { TerrainGrid } from './core/raster.js';
import { useStore } from './store/index.js';
import { session } from './session.js';

export function initBridge() {
  const { subscribe } = useStore;

  // 内容真的变了 → 三层整层重建（新贴图、新几何）。放在 derived 前面，
  // 这样同一次写入先重建再定在场，不会出现「刚建好就漏了一次开关」
  subscribe((s) => s.contentRev, () => rebuildLayers());
  // 游标走动或数据变了 → 重算「谁在场」。拖游标只走这一条，一个像素都不重画
  subscribe((s) => s.derived, () => applyActiveLayers());
  // 舞台变了（换地图、载入项目）→ 重新贴一次球面
  subscribe((s) => s.stageEpoch, () => applyStage());
  // 几何本身要重建（改标记尺寸、换配色）
  subscribe((s) => s.layerEpoch, () => rebuildLayers());
  // 只有地形动了（画笔涂抹、脚本改高度）→ 把已有图层重新贴回地表即可
  subscribe((s) => s.layoutEpoch, () => relayoutLayers());
  // 选中变化 → 只改高亮，不动几何
  subscribe((s) => s.selection, () => applySelectionToLayers());
  // 编辑模式 → 光标样式 + 清掉上一次的绘制预览
  subscribe((s) => s.mode, (mode, prev) => applyMode(mode, prev));
  // 绘制中新增了顶点 → 更新预览线与点数（不能整体重绘，否则会打断正在填写的表单）
  subscribe((s) => s.drawCoords, (coords) => applyDrawPreview(coords));
  // 提示条
  subscribe((s) => s.toasts, () => renderToast());
}

/** 解码并缓存地图（同一张只解码一次，工坊编辑后会回填） */
export async function getGridCached(rmap) {
  if (session.gridCache.has(rmap.id)) return session.gridCache.get(rmap.id);
  const grid = await TerrainGrid.fromPNG(rmap.dataUrl);
  session.gridCache.set(rmap.id, grid);
  return grid;
}

/** 事件可以没有地点；这类事件不上球，只进编年史 */
const hasCoords = (e) => e.lat != null && e.lng != null;

/**
 * 内容变了：三层整层重建，没有项目时整层隐藏。
 * 收的是项目里的全部内容，不是当前游标下在场的那批——在场与否改由 applyActiveLayers 单独负责，
 * 于是重建一次之后，游标怎么走都不必再建。
 */
export function rebuildLayers() {
  const s = useStore.getState();
  const p = s.project;
  const visible = !!p;
  session.eventDot.group.visible = visible;
  session.routes.group.visible = visible;
  session.regions.group.visible = visible;
  // 没有地点的事件不上球：它是一条正经事件，只是没有坐标，只进编年史。
  // 这里先筛掉，否则会照 null 经纬度算出一个 NaN 位置的光点
  session.eventDot.build(p ? p.events.filter(hasCoords) : []);
  session.routes.build(p ? p.routes : []);
  session.regions.build(p ? p.regions : []);
  applyActiveLayers();
  applySelectionToLayers();
}

/**
 * 重算「谁在场」，把不在场的藏起来。
 * 与 rebuildLayers 的差别是「翻开关」与「重建」：贴图、几何、材质一律不动，
 * 所以游标每扫过一次都可以放心调，成本只有 N 次布尔赋值。
 */
export function applyActiveLayers() {
  const d = useStore.getState().derived;
  // 光点跟的是选中而不是游标：从长卷里点开一条旧事件时，游标可能已经不在那一年了，
  // 但点该亮还是要亮——所以这一层没有「在场」这回事
  session.eventDot.setActive();
  session.routes.setActive(new Set(d.activeRoutes.map((r) => r.id)));
  session.regions.setActive(new Set(d.activeRegions.map((r) => r.id)));
}

/**
 * 内容一条没变、只是脚下的地形变了：把已有图层重新贴回地表。
 * 与 rebuildLayers 的差别是「重建」与「重定位」——光点贴图、路线材质、区域颜色
 * 都原样留着，只重算半径。画笔每移动一下都会走到这里，必须便宜。
 */
export function relayoutLayers() {
  if (!useStore.getState().project) return;
  session.eventDot.relayout();
  session.routes.relayout();
  session.regions.relayout();
}

/**
 * 等最近一次舞台贴图完成。
 * 加载页在 loadProjectInto 之后调它：地图解码与纹理创建都结束，遮罩才退场。
 */
export function waitForStage() {
  return session.stageDone ?? Promise.resolve();
}

/**
 * 舞台变了：把球那张脸重新贴一次。
 * 只在载入项目 / 换地图时跑，与游标无关——拖游标不换脸，只重刷内容层。
 *
 * 令牌是给异步解码兜底的：换栅格要等 PNG 解码，等待期间用户若又换了一张，
 * 先回来的那次必须作废，否则 currentGrid 会停在前一张上，与球面显示的对不上。
 */
export async function applyStage() {
  const s = useStore.getState();
  const p = s.project;
  const rmap = p ? P.getRasterMap(p, p.baseRasterId) : null;

  const token = ++session.stageToken;
  session.applyingStage = true;
  let finishStage;
  session.stageDone = new Promise((resolve) => { finishStage = resolve; });
  try {
    if (!rmap) {
      // 没有地图：深色空球。内容跟着回到球面，不再贴着上一张地图的高度。
      session.currentGrid = null;
      session.globe.setBlank();
      return;
    }
    const grid = await getGridCached(rmap);
    if (token !== session.stageToken) return; // 等待期间换过脸了，丢弃这次结果
    session.currentGrid = grid;
    session.globe.setRaster(grid);
  } catch (err) {
    if (token !== session.stageToken) return;
    session.currentGrid = null;
    useStore.getState().toast(`地图解码失败：${err.message}`);
    session.globe.setBlank();
  } finally {
    finishStage();
    // 被后来者顶掉的那次不重排图层，否则会把新地形的贴地半径算成旧的
    if (token === session.stageToken) {
      session.applyingStage = false;
      relayoutLayers();
    }
  }
}

function applySelectionToLayers() {
  const sel = useStore.getState().selection;
  const id = sel?.id ?? null;
  // 光点只认事件：选中路线、区域或人物时它必须消失，否则球上会留着一个无主的亮点
  session.eventDot.setSelected(sel?.kind === 'event' ? id : null);
  session.routes.setSelected(id);
  session.regions.setSelected(id);
}

function applyMode(mode, prev) {
  document.body.classList.toggle('mode-draw', mode !== 'browse');
  if (prev === 'draw-route' || prev === 'draw-region') {
    session.routes?.hidePreview();
    session.regions?.hidePreview();
  }
}

/** 绘制中新增了顶点：预览线跟着走，点数由绘制表单自己订阅 store */
function applyDrawPreview(coords) {
  if (!coords.length) {
    session.routes?.hidePreview();
    session.regions?.hidePreview();
  } else {
    session.routes?.showPreview(coords.map(([lng, lat]) => ({ lat, lng })));
    session.regions?.showPreview(coords);
  }
}

/** 把 store 里最新一条提示显示出来；队列空了就淡出 */
function renderToast() {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'glass';
    el.style.cssText = 'position:fixed;bottom:76px;left:50%;transform:translateX(-50%);'
      + 'padding:8px 16px;font-size:12px;z-index:60;pointer-events:none;transition:opacity .3s;opacity:0';
    document.body.appendChild(el);
  }
  const { toasts } = useStore.getState();
  const latest = toasts[toasts.length - 1];
  if (latest) {
    el.textContent = latest.text;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  } else {
    el.style.opacity = '0';
  }
}
