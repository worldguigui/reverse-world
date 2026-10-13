import * as THREE from 'three';
import { latLngToVec3, vec3ToLatLng, TweenManager } from './utils.js';
import { CameraRig } from './view/camera.js';
import { Globe } from './view/globe.js';
import { MarkerLayer } from './view/markers.js';
import { RouteLayer } from './view/routes.js';
import { RegionLayer } from './view/regions.js';
import * as P from './core/project.js';
import { TerrainGrid } from './core/raster.js';
import { buildRealEarthGrid } from './core/realearth.js';
import { loadStoredProject, createAutoSaver } from './core/storage.js';
import { createPanels } from './ui/registry.js';
import * as W from './ui/workshop-session.js';
import { installAPI } from './api.js';
import { useStore } from './store/index.js';
import { setViewHooks } from './store/actions.js';
import { session } from './session.js';
import { initBridge, refreshLayers, relayoutLayers, getGridCached } from './bridge.js';
import { LAYER_SCENE, LAYER_MASK, LAYER_CONTENT } from './view/render-layers.js';

const $ = (id) => document.getElementById(id);

async function main() {
  const store = useStore;
  const config = store.getState().viewConfig;

  // ---------------------------------------------------------- 渲染基础
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.autoClear = false; // 一帧要分三趟画，清屏由 render() 自己掌握
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(config.camera.fov, innerWidth / innerHeight, 0.01, 300);
  camera.position.copy(latLngToVec3(config.camera.lat, config.camera.lon, config.camera.distance));

  const tweens = new TweenManager();
  const rig = new CameraRig(camera, renderer.domElement, { ...config.camera, ...config.rotation }, tweens);

  const globe = new Globe(scene, config, renderer.capabilities.getMaxAnisotropy());
  // 画面设置随时可能被改，图层每次都现取当前值，不缓存对象引用
  const viewConfig = () => store.getState().viewConfig;
  const markers = new MarkerLayer(globe.group, viewConfig);
  const routes = new RouteLayer(globe.group, viewConfig);
  const regions = new RegionLayer(globe.group, viewConfig);
  routes.setSize(innerWidth, innerHeight);

  Object.assign(session, {
    renderer, scene, camera, globe, markers, routes, regions, rig, tweens,
    autosaver: createAutoSaver(500),
  });

  // 标注/路线/区域贴着地形走。海面以下是负高度，只贴到海平面为止——
  // 否则海上的条目会沉到球面以下（比深度掩膜还低），直接看不见。
  const terrainRadius = (lat, lng) => {
    const grid = session.currentGrid;
    if (!grid) return 0;
    return Math.max(0, grid.sample(lat, lng)) * viewConfig().terrain.exaggeration;
  };
  markers.terrainRadius = terrainRadius;
  routes.terrainRadius = terrainRadius;
  regions.terrainRadius = terrainRadius;

  // ---------------------------------------------------------- 地形工坊面板
  /**
   * 打开当前（或指定）时间点的地形工坊。
   * 已有栅格底图时直接编辑它；被多个时代共享则先复制一份专属快照，避免改一处动全部。
   */
  async function openWorkshopPanel(tpId) {
    const s = store.getState();
    const p = s.project;
    const idx = p ? p.timePoints.findIndex((t) => t.id === (tpId ?? p.timePoints[s.timeIndex]?.id)) : -1;
    if (idx < 0) { s.toast('请先在底部时间轴创建时间点'); return; }
    s.setTime(idx);

    const tp = p.timePoints[idx];
    let grid;
    let binding = null; // 直接编辑已存在的栅格底图时记下它的 id
    if (tp.rmapId) {
      const rmap = P.getRasterMap(p, tp.rmapId);
      if (P.rasterUsersAt(p, rmap.id, idx) > 1) {
        grid = (await getGridCached(rmap)).clone();
        s.toast('该地形被多个时代共享：已复制为本时代专属快照');
      } else {
        grid = await getGridCached(rmap);
        binding = { rmapId: rmap.id };
      }
    } else {
      const inherited = P.rasterAt(p, idx);
      if (inherited) {
        grid = (await getGridCached(inherited)).clone();
        s.toast('已从上一时代复制地形快照，本时代可独立修改');
      } else {
        grid = new TerrainGrid(512, 256);
        grid.fill(-0.45);
        s.toast('一片汪洋：拿画笔造出你的大陆吧');
      }
    }

    s.resetWorkshopBrush();
    W.beginWorkshop({
      grid,
      binding,
      tp,
      hooks: {
        onChange(g) {
          // 球体实时预览：第一次建纹理，之后只刷新内容
          if (!W.workshop.previewed) { globe.setRaster(g); W.workshop.previewed = true; }
          else globe.updateRasterTextures();
          session.currentGrid = g;
          // 只重定位，不重建：这里每次指针移动都会被调用，
          // 重建一遍标注贴图 + 路线 + 区域正是「地形编辑卡顿」的来源
          relayoutLayers();
        },
        loadRealEarth: () => buildRealEarthGrid(grid.w),
        onCommit(g) {
          const st = store.getState();
          const png = g.encodePNG();
          st.mutateProject((proj) => {
            if (binding) {
              const rmap = P.getRasterMap(proj, binding.rmapId);
              rmap.dataUrl = png;
              session.gridCache.set(rmap.id, g);
            } else {
              const rmap = P.addRasterMap(proj, { name: `地形 · ${tp.label}`, w: g.w, h: g.h, dataUrl: png });
              P.updateTimePoint(proj, tp.id, { rmapId: rmap.id });
              session.gridCache.set(rmap.id, g);
            }
          });
          session.currentGrid = g;
          globe.setRaster(g);
          refreshLayers(); // 这里数据真的变了（mutateProject 已换过 derived），要整层重建
          st.setWorkshopOpen(false);
          st.toast(`「${tp.label}」的地形已保存`);
        },
        onCancel() {
          session.currentGrid = null;
          store.getState().setWorkshopOpen(false);
          relayoutLayers(); // 只是贴地半径回到 0，内容本身没变
        },
      },
    });
    s.setWorkshopOpen(true);
  }

  // ---------------------------------------------------------- UI 组装
  createPanels({
    topbar: $('topbar'),
    timeline: $('timeline'),
    inspector: $('inspector'),
    settings: $('settings'),
    workshop: $('workshop'),
  });

  setViewHooks({ openWorkshop: openWorkshopPanel });
  initBridge();

  // 飞行开始时暂停自动旋转，避免「飞到了又被转走」
  rig.onFlyStart = () => {
    if (store.getState().viewConfig.rotation.enabled) {
      store.getState().setViewConfig({ rotation: { enabled: false } });
    }
  };

  // ---------------------------------------------------------- 鼠标交互
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enable(LAYER_CONTENT); // 内容在单独一层，拾取要显式打开
  const ndc = new THREE.Vector2();
  const pointerClient = { x: 0, y: 0 };
  let pointerDirty = false;
  let downInfo = null;
  const canvas = renderer.domElement;

  const toNdc = (e) => ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

  function pickAt(ndcVec) {
    raycaster.setFromCamera(ndcVec, camera);
    const entryId = markers.pick(raycaster, camera);
    if (entryId) return { kind: 'entry', id: entryId };
    const regionId = regions.pick(raycaster);
    if (regionId) return { kind: 'region', id: regionId };
    const routeId = routes.pick(raycaster);
    if (routeId) return { kind: 'route', id: routeId };
    return null;
  }

  function pickSphere(ndcVec) {
    raycaster.setFromCamera(ndcVec, camera);
    const hit = raycaster.intersectObject(globe.sphere, false)[0];
    return hit ? vec3ToLatLng(hit.point) : null;
  }

  canvas.addEventListener('pointermove', (e) => {
    pointerClient.x = e.clientX;
    pointerClient.y = e.clientY;
    toNdc(e);
    pointerDirty = true;
  });
  canvas.addEventListener('pointerdown', (e) => {
    downInfo = { x: e.clientX, y: e.clientY, t: performance.now() };
  });

  // 单击（区分拖拽）按模式分发
  canvas.addEventListener('pointerup', (e) => {
    if (!downInfo) return;
    const dx = e.clientX - downInfo.x;
    const dy = e.clientY - downInfo.y;
    const isClick = dx * dx + dy * dy < 36 && performance.now() - downInfo.t < 500;
    downInfo = null;
    if (!isClick) return;

    const s = store.getState();
    if (!s.project) return;
    toNdc(e);

    if (s.mode === 'browse') {
      s.select(pickAt(ndc));
    } else if (s.mode === 'add-entry') {
      const ll = pickSphere(ndc);
      if (ll) s.setPendingCoords({ lat: ll.lat, lng: ll.lng });
    } else if (s.mode === 'draw-route' || s.mode === 'draw-region') {
      const ll = pickSphere(ndc);
      if (!ll) return;
      // 勾画区域时点在起点附近 → 闭合
      if (s.mode === 'draw-region' && s.drawCoords.length >= 3 && nearFirstVertex(e)) {
        s.commitDraw('region');
        return;
      }
      s.addDrawPoint([ll.lng, ll.lat]);
    }
  });

  function nearFirstVertex(e) {
    const coords = store.getState().drawCoords;
    if (!coords.length) return false;
    const [lng, lat] = coords[0];
    const p = worldToScreen(latLngToVec3(lat, lng, 1));
    return Math.hypot(p.x - e.clientX, p.y - e.clientY) < 16;
  }

  function worldToScreen(v3) {
    const v = v3.clone().project(camera);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }

  // 双击：定位到球面上的点并拉近
  canvas.addEventListener('dblclick', (e) => {
    const s = store.getState();
    if (s.mode !== 'browse') return;
    toNdc(e);
    const ll = pickSphere(ndc);
    if (!ll) return;
    s.flyTo(ll.lat, ll.lng, { distance: Math.max(viewConfig().camera.minDistance + 0.05, camera.position.length() * 0.55) });
  });

  // 悬停：浏览模式下提示内容名称（逐帧写入，走 DOM 而不是 store）
  const tooltipEl = $('tooltip');
  function processHover() {
    const s = store.getState();
    if (!pointerDirty || s.mode !== 'browse' || !s.project) return;
    pointerDirty = false;
    const hit = pickAt(ndc);
    markers.setHover(hit?.kind === 'entry' ? hit.id : null);
    regions.setHover(hit?.kind === 'region' ? hit.id : null);
    if (hit) {
      const item = P.getItem(s.project, hit.kind, hit.id);
      tooltipEl.textContent = item ? (item.title ?? item.name) : '';
      tooltipEl.style.left = `${pointerClient.x + 14}px`;
      tooltipEl.style.top = `${pointerClient.y + 14}px`;
      tooltipEl.hidden = false;
      canvas.style.cursor = 'pointer';
    } else {
      tooltipEl.hidden = true;
      canvas.style.cursor = '';
    }
  }

  // ---------------------------------------------------------- 键盘
  addEventListener('keydown', (e) => {
    const s = store.getState();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Escape' && s.mode !== 'browse') s.setMode('browse');
    if (typing) return;
    if (e.key === 'Enter' && (s.mode === 'draw-route' || s.mode === 'draw-region')) {
      s.commitDraw(s.mode === 'draw-route' ? 'route' : 'region'); // 点数不足时 commitDraw 自己会忽略
    }
    if (e.key === 'ArrowLeft') s.step(-1);
    if (e.key === 'ArrowRight') s.step(1);
  });

  // ---------------------------------------------------------- 尺寸与退出
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    routes.setSize(innerWidth, innerHeight);
  });
  addEventListener('beforeunload', () => session.autosaver.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) session.autosaver.flush();
  });

  // ---------------------------------------------------------- 启动
  const restored = await loadStoredProject();
  if (restored) store.getState().hydrateProject(restored);
  installAPI({ ctx: store.getState(), project: () => store.getState().project });
  console.info(
    '%c window.world ',
    'background:#6ea8ff;color:#000;padding:2px 6px;border-radius:4px;font-weight:bold',
    'API 就绪，输入 world.help() 查看；首次使用可从 ☰ 菜单载入示例世界',
  );

  /**
   * 一帧三趟，靠 render-layers.js 里的层号分工：
   *   ① 球体/大气/星空 —— 正常写颜色和深度
   *   ② 深度掩膜球（半径 1 的光滑正球，只写深度不写颜色）
   *   ③ 条目/路线/区域 —— 对着②留下的深度做测试
   * 于是内容不会被鼓起来的山挡住，转到球背面时又会被②挡住。
   * 末尾把相机层号复位成默认，免得影响拾取或别处。
   */
  function render() {
    renderer.clear();
    camera.layers.set(LAYER_SCENE);
    renderer.render(scene, camera);
    renderer.clearDepth();
    camera.layers.set(LAYER_MASK);
    renderer.render(scene, camera);
    camera.layers.set(LAYER_CONTENT);
    renderer.render(scene, camera);
    camera.layers.set(LAYER_SCENE);
  }

  const clock = { last: performance.now() };
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - clock.last) / 1000, 0.05);
    clock.last = now;
    tweens.update();
    globe.update?.(dt, camera);
    rig.update();
    processHover();
    render();
  });
}

main().catch((err) => {
  console.error(err);
  $('error-msg').textContent = String(err?.message ?? err);
  $('error').hidden = false;
});
