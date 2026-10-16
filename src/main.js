import * as THREE from 'three';
import { latLngToVec3, vec3ToLatLng, TweenManager } from './utils.js';
import { CameraRig } from './view/camera.js';
import { Globe } from './view/globe.js';
import { EventDotLayer } from './view/event-dot.js';
import { RouteLayer } from './view/routes.js';
import { RegionLayer } from './view/regions.js';
import * as P from './core/project.js';
import { TerrainGrid } from './core/raster.js';
import { buildRealEarthGrid, EARTH_RES } from './core/realearth.js';
import { loadStoredProject, createAutoSaver } from './core/storage.js';
import { createPanels } from './ui/registry.js';
import * as W from './ui/workshop-session.js';
import { installAPI } from './api.js';
import { useStore } from './store/index.js';
import { setViewHooks } from './store/actions.js';
import { session } from './session.js';
import { initBridge, relayoutLayers, applyStage, getGridCached } from './bridge.js';
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
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const eventDot = new EventDotLayer(globe.group, viewConfig, maxAniso);
  const routes = new RouteLayer(globe.group, viewConfig);
  const regions = new RegionLayer(globe.group, viewConfig);
  routes.setSize(innerWidth, innerHeight);
  eventDot.setViewport(innerWidth, innerHeight);

  Object.assign(session, {
    renderer, scene, camera, globe, eventDot, routes, regions, rig, tweens,
    autosaver: createAutoSaver(500),
  });

  // 光点/路线/区域贴着地形走。海面以下是负高度，只贴到海平面为止——
  // 否则海上那条内容会沉到球面以下（比深度掩膜还低），直接看不见。
  const terrainRadius = (lat, lng) => {
    const grid = session.currentGrid;
    if (!grid) return 0;
    return Math.max(0, grid.sample(lat, lng)) * viewConfig().terrain.exaggeration;
  };
  eventDot.terrainRadius = terrainRadius;
  routes.terrainRadius = terrainRadius;
  regions.terrainRadius = terrainRadius;

  // ---------------------------------------------------------- 地形工坊面板
  /**
   * 打开地形工坊。球只有一张脸，所以工坊改的就是这一次性的全局地形：
   * 已有栅格底图就直接编辑它，没有就先给一片汪洋。
   */
  async function openWorkshopPanel() {
    const s = store.getState();
    const p = s.project;
    if (!p) { s.toast('先新建一个世界再画地形'); return; }

    let grid;
    let binding = null; // 直接编辑已存在的栅格底图时记下它的 id
    const rmap = P.getRasterMap(p, p.baseRasterId);
    if (rmap) {
      grid = await getGridCached(rmap);
      binding = { rmapId: rmap.id };
    } else {
      // 白纸起步的画布与真实地球同分辨率：画到一半按「真实地球」不会突然换一档精度
      grid = new TerrainGrid(EARTH_RES, EARTH_RES / 2);
      grid.fill(-0.45);
      s.toast('一片汪洋：拿画笔造出你的大陆吧');
    }

    s.resetWorkshopBrush();
    W.beginWorkshop({
      grid,
      binding,
      hooks: {
        onChange(g) {
          // 球体实时预览：第一次建纹理，之后只刷新内容
          if (!W.workshop.previewed) { globe.setRaster(g); W.workshop.previewed = true; }
          else globe.updateRasterTextures();
          session.currentGrid = g;
          // 只重定位，不重建：这里每次指针移动都会被调用，
          // 重建一遍路线 + 区域正是「地形编辑卡顿」的来源
          relayoutLayers();
        },
        loadRealEarth: () => buildRealEarthGrid(grid.w),
        onCommit(g) {
          const st = store.getState();
          const png = g.encodePNG();
          // 先把新地形接上，再改数据——改数据会立刻触发整层重建，
          // 那时 terrainRadius 读到的必须是新网格，否则内容会按旧高度贴一次地
          session.currentGrid = g;
          globe.setRaster(g);
          st.mutateProject((proj) => {
            let rmapId = binding?.rmapId;
            if (rmapId) {
              P.getRasterMap(proj, rmapId).dataUrl = png;
            } else {
              rmapId = P.addRasterMap(proj, { name: '地形', w: g.w, h: g.h, dataUrl: png }).id;
              proj.baseRasterId = rmapId;
            }
            // 刚编好的网格就在手上，直接回填缓存：下次打开工坊或贴地都不必再解一次 PNG
            session.gridCache.set(rmapId, g);
          });
          st.setWorkshopOpen(false);
          st.toast('地形已保存');
        },
        onCancel() {
          // 工坊是在缓存里那份网格上就地改的，取消时必须把它丢掉重新解码，
          // 否则球上会一直留着改到一半的样子
          if (binding) session.gridCache.delete(binding.rmapId);
          store.getState().setWorkshopOpen(false);
          applyStage();
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
  // 用户自己动了镜头：打断进行中的 flyTo，让用户立即接管镜头
  rig.onUserInterrupt = () => {}; // 回调保留，便于将来扩展镜头相关行为

  // ---------------------------------------------------------- 鼠标交互
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enable(LAYER_CONTENT); // 内容在单独一层，拾取要显式打开
  const ndc = new THREE.Vector2();
  const pointerClient = { x: 0, y: 0 };
  let pointerDirty = false;
  let downInfo = null;
  const canvas = renderer.domElement;

  const toNdc = (e) => ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

  /**
   * 球面拾取：只有区域与路线。
   * 事件不在球上拾取——它一多就会把球面铺满光点，也会让人以为「点上去能选中」；
   * 事件的入口是时间轴刻度与编年史长卷，球上只把选中那一条的坐标点亮。
   */
  function pickAt(ndcVec) {
    raycaster.setFromCamera(ndcVec, camera);
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
    } else if (s.mode === 'add-event') {
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
    if (e.key === 'ArrowLeft') s.stepCursor(-1);
    if (e.key === 'ArrowRight') s.stepCursor(1);
  });

  // ---------------------------------------------------------- 尺寸与退出
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    routes.setSize(innerWidth, innerHeight);
    eventDot.setViewport(innerWidth, innerHeight);
  });
  addEventListener('beforeunload', () => session.autosaver.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) session.autosaver.flush();
  });

  // ---------------------------------------------------------- 启动
  const restored = await loadStoredProject();
  if (restored) store.getState().hydrateProject(restored);
  installAPI({
    ctx: store.getState(),
    project: () => store.getState().project,
    cursor: () => store.getState().cursor,
  });
  console.info(
    '%c window.world ',
    'background:#6ea8ff;color:#000;padding:2px 6px;border-radius:4px;font-weight:bold',
    'API 就绪，输入 world.help() 查看；首次使用可从 ☰ 菜单载入示例世界',
  );

  /**
   * 一帧三趟，靠 render-layers.js 里的层号分工：
   *   ① 球体/大气/星空 —— 正常写颜色和深度
   *   ② 深度掩膜球（半径 1 的光滑正球，只写深度不写颜色）
   *   ③ 事件光点/路线/区域 —— 对着②留下的深度做测试
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
    rig.update(dt); // 自转按真实秒数走，帧率高低都转一样快
    // 光点的大小只跟相机有关，所以每帧现算，不走 store 的信号
    eventDot.update(camera);
    processHover();
    render();
  });
}

main().catch((err) => {
  console.error(err);
  $('error-msg').textContent = String(err?.message ?? err);
  $('error').hidden = false;
});
