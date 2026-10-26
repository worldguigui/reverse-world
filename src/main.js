import * as THREE from 'three';
import { latLngToVec3, vec3ToLatLng, TweenManager } from './utils.js';
import { CameraRig } from './view/camera.js';
import { Globe } from './view/globe.js';
import { EventDotLayer } from './view/event-dot.js';
import { RouteLayer } from './view/routes.js';
import { RegionLayer } from './view/regions.js';
import * as P from './core/project.js';
import { TerrainGrid, OCEAN_COLOR } from './core/raster.js';
import { buildRealEarthGrid, EARTH_RES } from './core/realearth.js';
import { loadStoredProject, createAutoSaver } from './core/storage.js';
import { createPanels } from './ui/registry.js';
import * as W from './ui/workshop-session.js';
import { installAPI } from './api.js';
import { useStore } from './store/index.js';
import { setViewHooks } from './store/actions.js';
import { session } from './session.js';
import { initBridge, relayoutLayers, applyStage, getGridCached, waitForStage } from './bridge.js';
import { LAYER_SCENE, LAYER_MASK, LAYER_CONTENT } from './view/render-layers.js';

const $ = (id) => document.getElementById(id);

async function main() {
  const store = useStore;
  const config = store.getState().viewConfig;

  // ---------------------------------------------------------- 渲染基础
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.autoClear = false; // 一帧要分三趟画，清屏由 render() 自己掌握
  // 太空底色是略暖的黑炭色，而不是纯黑：星场边缘不再与周围 UI 割裂
  renderer.setClearColor(0x0d0c0b, 1);
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

  // 光点/路线/区域始终贴着实际地形走，包括海平面以下的凹陷。
  // 高度要先按球面的实际渲染口径夹到 [-4, 4] 再插值：球面顶点读的是
  // 逐格 clamp 后的纹理，直接用原始采样值会把内容抬到实际地形上方。
  const terrainRadius = (lat, lng) => {
    const grid = session.currentGrid;
    if (!grid) return 0;
    return grid.sampleClamped(lat, lng) * viewConfig().terrain.exaggeration;
  };
  eventDot.terrainRadius = terrainRadius;
  routes.terrainRadius = terrainRadius;
  regions.terrainRadius = terrainRadius;

  // ---------------------------------------------------------- 地图工坊面板
  // 解码地图是异步的：连点两次入口会让两次打开交错，第二次换掉网格时画布已经绑在第一次上
  let workshopOpening = false;
  /**
   * 打开地图工坊。球只有一张脸，所以工坊改的就是这一次性的全局地图：
   * 已有地图就直接编辑它，没有就先给一片汪洋。
   */
  async function openWorkshopPanel() {
    const s = store.getState();
    if (workshopOpening || s.workshopOpen) return;
    const p = s.project;
    if (!p) { s.toast('先新建一个世界再画地图'); return; }

    workshopOpening = true;
    try {
      let grid;
      let binding = null; // 直接编辑已存在的地图时记下它的 id
      const rmap = P.getRasterMap(p, p.baseRasterId);
      if (rmap) {
        grid = await getGridCached(rmap);
        binding = { rmapId: rmap.id };
      } else {
        // 白纸起步的画布与真实地球同分辨率：画到一半按「真实地球」不会突然换一档精度
        grid = new TerrainGrid(EARTH_RES, EARTH_RES / 2);
        grid.fill(-0.45, OCEAN_COLOR); // 一片汪洋：高度压到海平面以下，整张表刷上海洋色
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
                rmapId = P.addRasterMap(proj, { name: '地图', w: g.w, h: g.h, dataUrl: png }).id;
                proj.baseRasterId = rmapId;
              }
              // 刚编好的网格就在手上，直接回填缓存：下次打开工坊或贴地都不必再解一次 PNG
              session.gridCache.set(rmapId, g);
            });
            st.setWorkshopOpen(false);
            st.toast('地图已保存');
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
    } finally {
      workshopOpening = false;
    }
  }

  // ---------------------------------------------------------- UI 组装
  createPanels({
    topbar: $('topbar'),
    timeline: $('timeline'),
    inspector: $('inspector'),
    settings: $('settings'),
    workshop: $('workshop'),
    loading: $('loading'),
  });

  setViewHooks({ openWorkshop: openWorkshopPanel });
  initBridge();

  // 档位变化（滚轮、拖动面板滑块、飞行、复位）同步给设置面板
  rig.onLevelChange = (level) => store.getState().syncCameraLevel(level);
  // 自转的每一帧把同样的旋转交给星场，背景星空在屏幕上不跟着转
  rig.onAutoSpin = (q) => globe.spinStars(q);
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
    // 路线画在区域之上（半径更高），拾取也按同一顺序：否则整条河落在一个国家里时，
    // 点河永远先命中那大片区域，只能从区域外露出来的那截河选中
    const routeId = routes.pick(raycaster, camera.position);
    if (routeId) return { kind: 'route', id: routeId };
    const regionId = regions.pick(raycaster, camera.position);
    if (regionId) return { kind: 'region', id: regionId };
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
    // 加载页、地图工坊与编年史都是全屏浮层：键盘先归它们，别在背后改动编辑状态
    if (s.loading || s.workshopOpen || s.chronicleOpen) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    // 输入框里的 Esc / Enter 属于控件本身（收起候选、提交输入），中文组字时同理
    if (typing || e.isComposing || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (s.mode !== 'browse') s.setMode('browse');
      // 鼠标点过的顶栏按钮会一直持有焦点；再按 Esc 属于键盘操作，浏览器会给它
      // 补上 :focus-visible 轮廓，看上去像一圈卡住的高亮。退出时把焦点交还给页面。
      const active = document.activeElement;
      if (active?.closest?.('.topbar-inner')) active.blur();
    }
    // Enter 是按钮/链接的标准激活键，不能同时当成「完成绘制」；
    // 方向键也只在画布这类非交互区域上才接管，免得抢走控件自己的键盘操作
    if (e.target.closest?.('button, a, [role="button"]')) return;
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
  if (restored) {
    // 恢复的世界可能在球上贴一张大图：先立起加载页，等舞台贴完再让它退场。
    // 这里不等 rAF：地图解码本身是异步的，浏览器总有机会先把加载页画出来；
    // 反过来在后台标签页里等 rAF 会一直等不到，把整个启动卡住。
    store.getState().setLoading({ title: '正在恢复上次的世界', detail: '准备地图…', progress: null });
    try {
      store.getState().hydrateProject(restored);
      await waitForStage();
    } finally {
      // 恢复失败也要收掉：加载页在最上层，留着会把下面的启动失败提示一起盖住
      store.getState().setLoading(null);
    }
  }
  installAPI({
    ctx: store.getState(),
    project: () => store.getState().project,
    cursor: () => store.getState().cursor,
  });
  console.info(
    '%c window.world ',
    'background:#c56b3e;color:#11100f;padding:2px 6px;border-radius:4px;font-weight:bold',
    'API 就绪，输入 world.help() 查看；首次使用可从 ☰ 菜单载入示例世界',
  );

  /**
   * 一帧三趟，靠 render-layers.js 里的层号分工：
   *   ① 球体/大气/星空 —— 正常写颜色和深度
   *   ② 深度掩膜平面（过球心、正对相机，只写深度不写颜色）
   *   ③ 事件光点/路线/区域 —— 对着②留下的深度做测试
   * ① 的地形深度在第二趟前被清掉，所以山体不会挡住内容；② 只按近/远半球
   * 做遮挡：近半球内容（包括贴到海平面以下凹陷的路线与区域）可见，
   * 转到背面时被平面挡住。末尾把相机层号复位成默认，免得影响拾取或别处。
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
    rig.update(dt); // 自转按真实秒数走，帧率高低都转一样快
    // 掩膜平面要按这一帧最终的相机朝向摆放，所以排在 rig.update 之后
    globe.update?.(dt, camera);
    // 光点的大小只跟相机有关，所以每帧现算，不走 store 的信号
    eventDot.update(camera);
    processHover();
    render();
  });
}

main().catch((err) => {
  console.error(err);
  // 出错时无论卡在哪个阶段，都先把加载页撤掉，否则提示被它盖着看不见
  useStore.getState().setLoading(null);
  $('error-msg').textContent = String(err?.message ?? err);
  $('error').hidden = false;
});
