import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import { LAYER_MASK } from '../render-layers.js';
import { WorldShape } from './world-shape.js';

/** 板面尺寸（世界单位）。外接半径 √(0.9²+0.45²)≈1.006≈referenceScale，相机公式处处有效 */
const SLAB_W = 1.8;
const SLAB_D = 0.9;
/** 板身厚度：顶面 y=0，向下到 y=-THICK。负地形沉入板身之内 */
const SLAB_THICK = 0.3;
/** 相机在目标点正上方的最低余量（与球体 minDistance 1.25 − 1 同值） */
const CAMERA_MIN_CLEARANCE = 0.25;
/** 平面相机的仰角（视线与板面的夹角，朝南俯视）：正俯视没立体感，太斜图压得扁。55° 起步，可调 */
const PLANAR_ELEVATION = (55 * Math.PI) / 180;
/** 侧壁/底面的岩层色：与近黑场景底色同族的暖炭色 */
const ROCK_COLOR = 0x272219;

const EPS = 1e-9;

const uOf = (lng) => (lng + 180) / 360;

function wrapLng(lng) {
  while (lng > 180) lng -= 360;
  while (lng < -180) lng += 360;
  return lng;
}

/**
 * 把环展开到连续的 u 域：相邻顶点的 u 挪到前一个的邻域（每步 ±360° 内），
 * 跨边缘的环因此保持连续，跨度记进 min/max。
 */
function unwrapRing(ring) {
  const out = [];
  let prevU = null;
  let min = Infinity;
  let max = -Infinity;
  for (const [lng, lat] of ring) {
    let u = uOf(lng);
    if (prevU !== null) {
      while (u - prevU > 0.5) u -= 1;
      while (prevU - u > 0.5) u += 1;
    }
    prevU = u;
    out.push([u, lat]);
    if (u < min) min = u;
    if (u > max) max = u;
  }
  return { ring: out, min, max, mid: (min + max) / 2 };
}

/** 孔洞的展开参考外环：整体平移整数圈，让孔洞落在包含它的外环同一侧 */
function alignTo(hole, outer) {
  const k = Math.round(outer.mid - hole.mid);
  if (!k) return hole;
  const ring = hole.ring.map(([u, lat]) => [u + k, lat]);
  return { ring, min: hole.min + k, max: hole.max + k, mid: hole.mid + k };
}

/** u 环 → lng 环（折回 [-180,180]；Martinez 输出的闭合点若首尾重复则去掉） */
function toLngRing(ring, k) {
  const pts = ring.slice();
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12) pts.pop();
  }
  return pts.map(([u, lat]) => [wrapLng((u - k) * 360 - 180), lat]);
}

/** 一块多边形的经度侧向：取非边缘点的平均符号（0 = 全贴在边缘，零面积）。
 * 箱内 u→lng 单调，一块不可能同时含 ±179 两侧的点，符号判定可靠 */
function sideOf(ring) {
  let s = 0;
  let n = 0;
  for (const [lng] of ring) {
    if (Math.abs(Math.abs(lng) - 180) > 1e-7) { s += Math.sign(lng); n++; }
  }
  return n ? Math.sign(s) : 0;
}

const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();

/**
 * 平板世界：一张等距圆柱地图铺在一块有厚度的板面上。
 * 经度沿 x（东 = +x），纬度沿 z（北 = −z，像从南缘看一张桌面地图）；
 * 高度沿 +y 位移，正高度隆起于顶面（y=0）之上，负高度沉入板身之内。
 *
 * 遮挡双机制（见 world-shape.js 头注释）：
 *  - 「地形不挡内容」由渲染趟次的 clearDepth() 直接保证（平板掩膜无事可做，
 *    返回一个隐藏网格占住 LAYER_MASK 的位置）；
 *  - 「世界底面不露内容」由 contentVisible（相机高于顶面 y=0）整体显隐保证——
 *    一张水平平面挡不住相机两侧的内容，这条规则必须由显隐开关直接执行。
 */
export class SlabShape extends WorldShape {
  id = 'slab';
  // target 就落在板面上，净距 = 距 target 距离，不再减任何东西
  referenceScale = 0;
  heightScale = 0.5; // P2 初始值：比等斜率等效（0.29）更突出，最终以同机位截图定值
  topology = Object.freeze({ longitudeWrap: false, latitudeWrap: false });
  subdivides = false;
  hasAtmosphere = true; // 氛围效果 = 十二棱描边，沿用大气强度设置
  planarCamera = true;
  atmosphereColorKey = 'colorSlab'; // 平板默认暗金：项目色板的旧金边界色
  /** 平板自己的高度比例 uniform：球体 shader 没有这个量，不能挂进共享 uniform */
  _uHeightScale = { value: this.heightScale };

  // ---------------------------------------------------------- 坐标映射

  surfacePoint(lat, lng, lift = 0, target = new THREE.Vector3()) {
    const u = (lng + 180) / 360;
    const v = (lat + 90) / 180;
    return target.set(
      (u - 0.5) * SLAB_W,
      lift,
      (0.5 - v) * SLAB_D, // v=1（北）→ −z
    );
  }

  pointToLatLng(v) {
    return {
      lng: (v.x / SLAB_W + 0.5) * 360 - 180,
      lat: (0.5 - v.z / SLAB_D) * 180 - 90,
    };
  }

  interpolate(a, b, t, lift = 0, target = new THREE.Vector3()) {
    // 平面上就是线性插值（u 域的最短路径由 projectPath 的展开保证）
    const lat = a.lat + (b.lat - a.lat) * t;
    const lng = a.lng + (b.lng - a.lng) * t;
    return this.surfacePoint(lat, lng, lift, target);
  }

  /**
   * 折线投影 + 边缘拆段。分两步：
   *  1. 在「u 域」（u = (lng+180)/360，允许越出 [0,1]）里展开并细分——
   *     相邻点的 u 挪到前一点的邻域（最短平面路径），凸缘不再横穿地图；
   *  2. 沿细分的 u 折线走，每越过一条边缘（u 的整数 0/1）就截断：
   *     出缘的点收在边缘上，下一段从对缘的镜像点再入。
   * 返回多条独立折线，路线层对每条各建一根线。
   */
  projectPath(points, liftFn) {
    const unfolded = [];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const lift = liftFn(pt.lat, pt.lng);
      if (i === 0) {
        unfolded.push({ u: uOf(pt.lng), lat: pt.lat, lift });
        continue;
      }
      const prev = unfolded[unfolded.length - 1];
      let u = uOf(pt.lng);
      while (u - prev.u > 0.5) u -= 1; // 最短平面路径：b 的 u 挪到 a 的邻域
      while (prev.u - u > 0.5) u += 1;
      const len = Math.hypot((u - prev.u) * 360, pt.lat - prev.lat);
      const steps = Math.max(1, Math.ceil(len / 2)); // 细分到 ≤2°，与球面路线一致
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        unfolded.push({
          u: prev.u + (u - prev.u) * t,
          lat: prev.lat + (pt.lat - prev.lat) * t,
          lift: prev.lift + (lift - prev.lift) * t,
        });
      }
    }

    const segs = [];
    let cur = [];
    const place = (p) => {
      const v = this.surfacePoint(p.lat, wrapLng(p.u * 360 - 180), p.lift);
      cur.push(v.x, v.y, v.z);
    };
    for (let i = 0; i < unfolded.length; i++) {
      const p = unfolded[i];
      if (i === 0) { place(p); continue; }
      const prev = unfolded[i - 1];
      // floor(u − ε)：恰好在边缘上的顶点归入低段——「触到边缘又折回」不算跨越
      const f0 = Math.floor(prev.u - EPS);
      const f1 = Math.floor(p.u - EPS);
      if (f1 === f0) { place(p); continue; }
      // 细分步长 ≤2°，一步之内只会跨过一条边缘
      const goingUp = f1 > f0;
      const b = goingUp ? f1 : f0; // 被越过的整数边界（u 域的 1 或 0）
      const t = (b - prev.u) / (p.u - prev.u);
      const lat = prev.lat + (p.lat - prev.lat) * t;
      const lift = prev.lift + (p.lift - prev.lift) * t;
      // 出缘点在「离开侧」的边缘：上越缘（从东往西出）收在 u=b（东缘），
      // 下越缘（从西往东出）收在 u=b−1（西缘）；place 内部会折回 [-180,180]
      place({ u: goingUp ? b : b - 1, lat, lift });
      if (cur.length >= 6) segs.push(cur);
      cur = [];
      place({ u: goingUp ? b - 1 : b, lat, lift }); // 从对缘的镜像点再入
      place(p);
    }
    if (cur.length >= 3) segs.push(cur);
    return segs;
  }

  /**
   * 区域裁剪：把跨 ±180° 的环（外环 + 孔洞）拆成左右两块独立多边形。
   * 用 polygon-clipping（Martinez，凹多边形可产出多个连通结果、孔洞自动归属）
   * 对「展开到 u 域的环 × [0,1]×[-90,90] 边界盒」做三次求交：
   *  k=0  原位（落在 [0,1] 内的那部分）
   *  k=-1 整体减一（把越过东缘 u>1 的部分带回盒内）
   *  k=+1 整体加一（把越过西缘 u<0 的部分带回盒内）
   * 求交结果的 u 减回 k 再折回 [-180,180] 即最终经度。不跨边缘的环恒等返回，
   * 与球体路径零差别。
   */
  clipPolygon(outer, holes = []) {
    const o = unwrapRing(outer);
    const hs = holes.map((h) => alignTo(unwrapRing(h), o));
    if ([o, ...hs].every((r) => r.min >= -EPS && r.max <= 1 + EPS)) {
      return [{ outer, holes }];
    }
    const box = [[[0, -90], [1, -90], [1, 90], [0, 90]]];
    const pieces = [];
    for (const k of [0, -1, 1]) {
      // 孔洞随外环做同一个 k 位移，Martinez 自己处理归属
      const poly = [[o.ring, ...hs.map((h) => h.ring)].map((r) => r.map(([u, lat]) => [u + k, lat]))];
      let result;
      try {
        result = polygonClipping.intersection(poly, box);
      } catch { continue; } // 几何退化交给下一帧的数据，不让一枚坏环炸掉整层
      for (const polygon of result ?? []) {
        const ringsLng = polygon.map((r) => toLngRing(r, k));
        // 切边上的点（恰好 ±180）归属到这一块实际占据的一侧：
        // k=−1 的块必在西缘、k=+1 必在东缘，k=0 看内部点的平均侧向。
        // 不贴边的话，西缘块的切边会被 wrap 成 +180，边界线画到对缘去
        const side = sideOf(ringsLng[0]);
        if (!side) continue; // 整块都贴在边缘上：零面积，丢弃
        const snap = (ring) => ring.map(([lng, lat]) => (
          Math.abs(Math.abs(lng) - 180) < 1e-9 ? [side * 180, lat] : [lng, lat]
        ));
        const pieceOuter = snap(ringsLng[0]);
        if (pieceOuter.length < 3) continue;
        const pieceHoles = ringsLng.slice(1).map(snap).filter((r) => r.length >= 3);
        pieces.push({ outer: pieceOuter, holes: pieceHoles });
      }
    }
    return pieces;
  }

  /** 平面距离（度）：没有纬度收缩这回事 */
  segmentAngleDeg(a, b) {
    return this.edgeLengthDeg(a.lng, a.lat, b.lng, b.lat);
  }

  edgeLengthDeg(lng1, lat1, lng2, lat2) {
    return Math.hypot(lng2 - lng1, lat2 - lat1);
  }

  // ---------------------------------------------------------- 表面标架与相机

  getSurfaceFrame(lat, lng) {
    return {
      position: this.surfacePoint(lat, lng, 0),
      normal: new THREE.Vector3(0, 1, 0),
      east: new THREE.Vector3(1, 0, 0),
      north: new THREE.Vector3(0, 0, -1),
    };
  }

  cameraDirection(lat, lng, target = new THREE.Vector3()) {
    // 与球体的径向方向同构：从原点指向「该点上方」，与距离无关。
    // P4 起 flyTo 改吃 getCameraPose 的完整位姿（相机真正朝向目标点）
    return this.surfacePoint(lat, lng, 0, target).setY(1).normalize();
  }

  /**
   * 相机位姿：悬在目标点 (x, 0, z) 正上方、离板面净高 = distance，视线朝向该点。
   * distance 的语义已统一为「到 target 的距离」，不再绕原点距离解 √——
   * 地图边缘不降级，净高直接成立；荒谬的小值由 cMin 夹底。
   */
  getCameraPose(lat, lng, { distance = 2 } = {}) {
    const p = this.surfacePoint(lat, lng, 0);
    const h = Math.max(distance, CAMERA_MIN_CLEARANCE);
    return {
      position: p.clone().add(this.planarCameraOffset(h, p)),
      target: p.clone(),
    };
  }

  /** 相机−target 偏移：从正上方朝南倾到固定仰角（PLANAR_ELEVATION），地形坡面朝向镜头有侧影 */
  planarCameraOffset(distance) {
    return new THREE.Vector3(0, Math.sin(PLANAR_ELEVATION), Math.cos(PLANAR_ELEVATION))
      .multiplyScalar(distance);
  }

  /** 出厂位姿落点 = 板面中心：切换到平板时板心位于画面中心 */
  getHomePose(config, distance) {
    return this.getCameraPose(0, 0, { distance });
  }

  /**
   * 相机潜到顶面（y=0）以下即视为看世界的底面：内容整体隐藏。
   * 正俯视锁死视角下到不了底面，这条判据只是兜底（形状切换瞬间的过渡态）。
   * 这是 V1 的行为规范（产品语义选择，不是渲染推导），观察后再调。
   */
  contentVisible(camera) {
    return camera.position.y >= 0;
  }

  /** 视点中心不许滑出板面：四周留 0.15 的边，画面里永远看得到世界 */
  clampCameraTarget(t) {
    const mx = SLAB_W / 2 - 0.15;
    const mz = SLAB_D / 2 - 0.15;
    t.x = THREE.MathUtils.clamp(t.x, -mx, mx);
    t.z = THREE.MathUtils.clamp(t.z, -mz, mz);
  }

  /**
   * 射线打「名义顶面」无限平面，落点在板面范围内才算命中。
   * 射线必须朝下（direction.y < 0）：绕到板底时仰视顶面不提供命中——
   * intersectPlane 对底面仰视也会给出交点，但那不是编辑语义。
   */
  raycastSurface(raycaster) {
    if (raycaster.ray.direction.y >= 0) return null;
    const hit = raycaster.ray.intersectPlane(_plane, _hit);
    if (!hit) return null;
    if (Math.abs(hit.x) > SLAB_W / 2 || Math.abs(hit.z) > SLAB_D / 2) return null;
    return { ...this.pointToLatLng(hit), point: hit.clone() };
  }

  // ---------------------------------------------------------- 渲染工厂

  buildBodyGeometry(segW) {
    // 顶面：剖分平面承载位移（段数预算与球体一致），法线朝 +y。
    // UV 与 PlaneGeometry 天然一致——无极点、无接缝，极点缝合整段不需要
    const geo = new THREE.PlaneGeometry(SLAB_W, SLAB_D, segW, segW / 2);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  /**
   * 板身（侧壁 + 底面）：侧壁与顶面**共享同一张颜色纹理**，用定制 UV 采样地图边缘，
   * 顶点色沿深度渐暗——断面即「地图边缘往下切开」，与顶面接缝零误差（同源采样）。
   * 侧壁 UV 映射：长度轴采样地图的纬向（v 轴），竖直轴钉在边缘的 u（Clamp 取最边列/行）；
   * 顶缘顶点色 = 1（原色，与顶面无缝），底缘 = 0.4（埋深渐暗）。
   * 底面不封口逻辑同前：顶面位移平面自己就是顶面。
   */
  buildStaticMeshes() {
    const wallMat = new THREE.MeshPhongMaterial({
      color: ROCK_COLOR, shininess: 4, side: THREE.DoubleSide, vertexColors: true,
    });
    const bottomMat = new THREE.MeshPhongMaterial({ color: ROCK_COLOR, shininess: 4, side: THREE.DoubleSide });
    const group = new THREE.Group();
    group.name = 'slab-frame';

    // 按世界 y 给顶点色：顶缘原色，底缘埋深渐暗
    const depthShade = (geo) => {
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const k = pos.getY(i) < 0 ? 0.4 : 1;
        colors[i * 3] = k;
        colors[i * 3 + 1] = k;
        colors[i * 3 + 2] = k;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    };

    // 覆写 UV：mode 决定长度轴采样纬向（v）还是经向（u），竖直轴钉在边缘
    const edgeUV = (geo, mode) => {
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        if (mode === 'north') uv.setXY(i, u, 1);
        else if (mode === 'south') uv.setXY(i, u, 0);
        else if (mode === 'east') uv.setXY(i, 1, u);
        else uv.setXY(i, 0, 1 - u); // 西壁：local +x 朝南，纬向反向
      }
    };

    const wall = (w, h, x, z, ry, mode) => {
      const g = new THREE.PlaneGeometry(w, h);
      if (ry) g.rotateY(ry);
      edgeUV(g, mode);
      depthShade(g);
      const m = new THREE.Mesh(g, wallMat);
      m.position.set(x, -SLAB_THICK / 2, z);
      group.add(m);
      return m;
    };
    wall(SLAB_W, SLAB_THICK, 0, SLAB_D / 2, 0, 'south');
    wall(SLAB_W, SLAB_THICK, 0, -SLAB_D / 2, Math.PI, 'north');
    wall(SLAB_D, SLAB_THICK, -SLAB_W / 2, 0, -Math.PI / 2, 'west');
    wall(SLAB_D, SLAB_THICK, SLAB_W / 2, 0, Math.PI / 2, 'east');
    const bottom = new THREE.PlaneGeometry(SLAB_W, SLAB_D);
    bottom.rotateX(Math.PI / 2); // 朝下
    const bottomMesh = new THREE.Mesh(bottom, bottomMat);
    bottomMesh.position.y = -SLAB_THICK;
    group.add(bottomMesh);

    this._wallMat = wallMat;
    this._wallHasMap = false;
    return [group];
  }

  /**
   * 侧壁共享顶面颜色纹理：断面 = 地图边缘往下切开，与顶面接缝零误差（同源采样）。
   * UV 已在几何里钉死（长度轴采样纬向、竖直轴钉在边缘列/行），
   * 这里只在换栅格时重绑纹理对象。首次绑上 map 需置 needsUpdate（USE_MAP 分支变化）；
   * 之后换栅格只是纹理对象变化，材质已带 map，不触发重编译。
   * 工坊实时预览走 updateRasterTextures()——纹理内容刷新，断面自动跟着变，零额外代码。
   */
  updateFrame(grid, map) {
    if (!this._wallMat || !map) return;
    if (this._wallMat.map !== map) {
      this._wallMat.map = map;
      // sRGB 解码与顶面一致，断面颜色才不会偏；
      // color 归一为白——map 之上的 color 是染色，岩色底会把贴图压成近黑
      this._wallMat.color.set(0xffffff);
      this._wallMat.map.colorSpace = THREE.SRGBColorSpace;
      this._wallMat.needsUpdate = true;
      this._wallHasMap = true;
    }
  }

  /**
   * 位移 shader：与球体同构但更简单——
   *  - 顶点沿 +y 位移（球沿径向），高度乘 heightScale（板的世界尺度与球不同）；
   *  - 基础法线恒为 (0,1,0)，东西/北切框是常量，无极点、无 heightUv 缝合；
   *  - uExaggeration 仍来自 Globe 的共享 uniform（设置滑块实时生效），
   *    uHeightScale 是形状自己的常量，不进共享池。
   */
  patchBodyMaterial(mat, { uniforms }) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHeightTex = uniforms.uHeightTex;
      shader.uniforms.uExaggeration = uniforms.uExaggeration;
      shader.uniforms.uHeightTexel = uniforms.uHeightTexel;
      shader.uniforms.uHeightScale = this._uHeightScale;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'uniform sampler2D uHeightTex;',
          'uniform float uExaggeration;',
          'uniform float uHeightScale;',
          'uniform vec2 uHeightTexel;',
          '// R+G 打包 16-bit 无符号 → 浮点 [-4, 4]（与球体同一套编码）',
          'float unpackHeight(vec2 rg) {',
          '  float u16 = dot(floor(rg * 255.0 + 0.5), vec2(256.0, 1.0));',
          '  return (u16 / 65535.0) * 8.0 - 4.0;',
          '}',
        ].join('\n'))
        .replace('#include <beginnormal_vertex>', [
          '#include <beginnormal_vertex>',
          '{ // 平板：基础法线恒 (0,1,0)，切框是常量；高度场邻域差分让坡向影响光照',
          '  vec3 eastDir = vec3(1.0, 0.0, 0.0);',
          '  vec3 northDir = vec3(0.0, 0.0, -1.0);',
          '  vec2 huv = uv;',
          '  float hC = unpackHeight(texture2D(uHeightTex, huv).rg);',
          '  float hE = unpackHeight(texture2D(uHeightTex, huv + vec2(uHeightTexel.x, 0.0)).rg);',
          '  float hN = unpackHeight(texture2D(uHeightTex, huv + vec2(0.0, uHeightTexel.y)).rg);',
          '  float k = uExaggeration * uHeightScale * 8.0;',
          '  objectNormal = normalize(objectNormal + (eastDir * (hC - hE) + northDir * (hN - hC)) * k);',
          '}',
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '// 沿板法线（+y）按高度位移：h=0 海平面，h>0 隆起，h<0 沉入板身',
          'transformed.y += unpackHeight(texture2D(uHeightTex, uv).rg) * uExaggeration * uHeightScale;',
        ].join('\n'));
    };
  }

  applyTextureWrapping(colorTex, heightTex) {
    // 平板没有经度环绕：地图左右两缘是世界断面，夹边采样，
    // 边缘外不重复（Repeat 会把西缘的地物镜像着长到东缘外去）
    colorTex.wrapS = THREE.ClampToEdgeWrapping;
    heightTex.wrapS = THREE.ClampToEdgeWrapping;
  }

  /**
   * 深度掩膜：平板无事可做，放一个隐藏网格占住 LAYER_MASK 的位置。
   * 球体的掩膜承担「近/远半球分界」；平板的分界是「相机在顶面上/下」，
   * 由 contentVisible 的整体显隐直接执行——一张水平平面挡不住相机两侧
   * 的内容（相机 y=-0.5、掩膜 y=-0.49、内容 y=-1 时射线不穿掩膜），
   * 所以几何遮挡这条路在平板上本来就是死路，显隐开关才是唯一可靠机制。
   * 而「地形不挡内容」由第二趟前的 clearDepth() 无条件保证，掩膜不需要在场。
   */
  buildMaskMesh() {
    const mask = new THREE.Mesh(
      new THREE.PlaneGeometry(0.001, 0.001),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }),
    );
    mask.name = 'overlay-depth-mask';
    mask.layers.set(LAYER_MASK);
    mask.visible = false;
    return mask;
  }

  // ---------------------------------------------------------- 氛围：实体边缘线

  /**
   * 平板的「大气」= 实体边缘线（Core Edge）：立方体 **十二条棱** 的发光线——
   * 顶面 4 条、底面 4 条、竖棱 4 条，世界空间的真实几何（不随相机、不呼吸闪烁），
   * 把整块「地图标本」的轮廓完整勾出来。
   * 「边缘辉光」控件直接驱动它：颜色=线的颜色，强度=线的浓度。
   * 柔光外扩（Soft Halo）暂缓：先看这条线够不够，不够再加第二层。
   */
  buildAtmosphere(group, config) {
    const hw = SLAB_W / 2;
    const hd = SLAB_D / 2;
    const top = 0.001;
    const bottom = -SLAB_THICK - 0.001; // 底缘略低一线，避免与底面 z-fighting
    const corners = [
      [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd],
    ];
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = corners[i];
      const [x2, z2] = corners[(i + 1) % 4];
      pts.push(x1, top, z1, x2, top, z2);           // 顶面 4 条
      pts.push(x1, bottom, z1, x2, bottom, z2);     // 底面 4 条
      pts.push(x1, top, z1, x1, bottom, z1);        // 竖棱 4 条
    }
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(config.atmosphere[this.atmosphereColorKey]),
      transparent: true,
      opacity: Math.min(0.9, config.atmosphere.strength * 0.5),
      depthWrite: false,
      toneMapped: false,
    });
    const edge = new THREE.LineSegments(new THREE.BufferGeometry()
      .setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), edgeMat);
    edge.name = 'slab-edge';

    this._atmo = { edge, edgeMat };
    group.add(edge);
    this.applyAtmosphereConfig(config);
  }

  applyAtmosphereConfig(config) {
    if (!this._atmo) return;
    const on = config.atmosphere.enabled;
    this._atmo.edge.visible = on;
    this._atmo.edgeMat.color.set(config.atmosphere[this.atmosphereColorKey]);
    // 强度滑块直接控制边的浓度：0 = 隐形，滑到顶不超过 0.9
    this._atmo.edgeMat.opacity = Math.min(0.9, config.atmosphere.strength * 0.5);
  }

  disposeAtmosphere(group) {
    if (!this._atmo) return;
    group.remove(this._atmo.edge);
    this._atmo.edge.geometry.dispose();
    this._atmo.edgeMat.dispose();
    this._atmo = null;
  }
}
