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

  // 项目数据或切面变了 → 三层内容全量重建
  subscribe((s) => s.derived, () => refreshLayers());
  // 切换切面 → 换底图与地形（栅格需异步解码）
  subscribe((s) => s.timeIndex, () => applyEra());
  // 底图/地形被就地改动（改时间点、上传底图、工坊提交）→ 重应用当前切面
  subscribe((s) => s.eraEpoch, () => applyEra());
  // 几何本身要重建（改标注大小、换配色）
  subscribe((s) => s.layerEpoch, () => refreshLayers());
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

/** 解码并缓存栅格底图（同一张只解码一次，工坊编辑后会回填） */
export async function getGridCached(rmap) {
  if (session.gridCache.has(rmap.id)) return session.gridCache.get(rmap.id);
  const grid = await TerrainGrid.fromPNG(rmap.dataUrl);
  session.gridCache.set(rmap.id, grid);
  return grid;
}

/** 预解上限：一张 512×256 的网格连画布约 1.7MB，别把整个项目都摊在内存里 */
const PREHEAT_LIMIT = 6;

/** 尽量在浏览器空闲时做；没有 requestIdleCallback 就退化成定时器 */
const whenIdle = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 3000 })
  : setTimeout(fn, 200));

let preheating = false;

/**
 * 空闲时把别的时间点的栅格底图先解出来。
 * 一张底图的 PNG 解码 + 重新着色要一百毫秒上下，正好压在切面切换那一帧上，
 * 这就是「切过去卡一下」的最后一块：预解掉之后，切的时候只剩换纹理。
 * 一次只解一张、只在空闲时解，不跟画笔和相机抢主线程；离当前切面近的先解，
 * 因为用户多半是沿着时间轴一步步走。
 */
export function preheatEras() {
  if (preheating) return;
  const s = useStore.getState();
  const p = s.project;
  if (!p) return;

  const seen = new Set();
  const ids = [];
  for (let d = 1; d < p.timePoints.length && ids.length < PREHEAT_LIMIT; d++) {
    for (const i of [s.timeIndex + d, s.timeIndex - d]) {
      const tp = p.timePoints[i];
      if (!tp) continue;
      const rmap = P.rasterAt(p, i);
      if (!rmap || seen.has(rmap.id)) continue;
      seen.add(rmap.id);
      if (!session.gridCache.has(rmap.id)) ids.push(rmap.id);
    }
  }
  if (!ids.length) return;

  preheating = true;
  const step = () => {
    const id = ids.shift();
    const rmap = id && P.getRasterMap(useStore.getState().project, id);
    if (!rmap) { preheating = false; return; } // 项目换了或底图删了，就此打住
    getGridCached(rmap).then(() => whenIdle(step), () => { preheating = false; });
  };
  whenIdle(step);
}

/** 按当前切面重建条目/路线/区域三层；没有项目时整层隐藏 */
export function refreshLayers() {
  const s = useStore.getState();
  const p = s.project;
  const visible = !!p;
  session.markers.group.visible = visible;
  session.routes.group.visible = visible;
  session.regions.group.visible = visible;
  if (!p) return;
  const i = s.timeIndex;
  session.markers.refresh(P.activeItems(p, 'entry', i));
  session.routes.refresh(P.activeItems(p, 'route', i));
  session.regions.refresh(P.activeItems(p, 'region', i));
  applySelectionToLayers();
}

/**
 * 内容一条没变、只是脚下的地形变了：把已有图层重新贴回地表。
 * 与 refreshLayers 的差别是「重建」与「重定位」——标注贴图、路线材质、区域颜色
 * 都原样留着，只重算半径。画笔每移动一下都会走到这里，必须便宜。
 */
export function relayoutLayers() {
  if (!useStore.getState().project) return;
  session.markers.relayout();
  session.routes.relayout();
  session.regions.relayout();
}

/**
 * 切面切换 / 底图地形变化：栅格优先于图片底图。
 * 幂等：目标（哪张栅格 / 哪张图片底图）与上一次相同就直接返回。
 * 一次 setTime 会同时改 derived 与 timeIndex，两个订阅都会触发；
 * 载入项目、工坊提交又会各自 touchEra 一次——没有这道闸，切一下要重来两三次。
 */
export async function applyEra() {
  const s = useStore.getState();
  const p = s.project;
  const timeIndex = s.timeIndex;
  const rmap = p ? P.rasterAt(p, timeIndex) : null;
  const mapUrl = rmap ? null : (P.mapAt(p, timeIndex)?.dataUrl ?? null);
  const key = rmap ? `raster:${rmap.id}` : `map:${mapUrl ?? ''}`;
  const isTarget = (rec) => !!rec && rec.project === p && rec.key === key;
  if (isTarget(session.appliedEra) || isTarget(session.applyingEra)) return;

  const token = ++session.eraToken;
  session.applyingEra = { project: p, key };
  try {
    if (!rmap) {
      // 没有栅格地形：退回图片底图。这里不动 currentGrid——
      // 内容照旧贴着上一次的地形，等新地形解码好再换，中途不会跳一下。
      session.currentGrid = null;
      session.globe.setMap(mapUrl);
      return;
    }
    const grid = await getGridCached(rmap);
    if (token !== session.eraToken) return; // 等待期间又切了切面，丢弃这次结果
    session.currentGrid = grid;
    session.globe.setRaster(grid);
  } catch (err) {
    if (token !== session.eraToken) return;
    session.currentGrid = null;
    useStore.getState().toast(`地形底图解码失败：${err.message}`);
    session.globe.setMap(mapUrl);
  } finally {
    // 被后来者顶掉的那次不写状态，也不重排图层
    if (token === session.eraToken) {
      session.applyingEra = null;
      session.appliedEra = { project: p, key };
      relayoutLayers();
      preheatEras(); // 当前切面已经好了，趁空闲把别的切面也解出来
    }
  }
}

function applySelectionToLayers() {
  const sel = useStore.getState().selection;
  const id = sel && sel.kind !== 'time' ? sel.id : null;
  session.markers.setSelected(id);
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
