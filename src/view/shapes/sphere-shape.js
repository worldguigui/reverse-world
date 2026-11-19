import * as THREE from 'three';
import { latLngToVec3, vec3ToLatLng, slerpLatLng } from '../../utils.js';
import { LAYER_MASK } from '../render-layers.js';
import { WorldShape } from './world-shape.js';

/** 掩膜平面的基础半边长：每帧再按相机远近与宽高比放大到屏幕四角之外 */
const MASK_HALF = 20;

/**
 * 球形世界：一张等距圆柱地图卷在半径 1 的球面上。
 * 从 Globe 与 utils.js 的原实现整体迁移而来（P1 纯重构，数学逐行未动）：
 *  - 经纬映射与 three.js SphereGeometry 的 UV 展开一致；
 *  - 高度沿径向位移，法线用高度场邻域差分扰动；
 *  - 掩膜是过球心、正对相机的平面——近半球内容永远在它之前
 *   （贴进凹陷的内容也不被裁），远半球被它挡住；
 *  - 内容层恒可见：近/远半球的显隐完全由掩膜几何承担，
 *   球体没有「世界的底面」，contentVisible 恒为 true。
 */
export class SphereShape extends WorldShape {
  id = 'sphere';
  referenceScale = 1;
  heightScale = 1;
  topology = Object.freeze({ longitudeWrap: true, latitudeWrap: false });
  subdivides = true;
  hasAtmosphere = true;
  atmosphereColorKey = 'colorSphere'; // 球体默认蓝：外圈辉光的经典配色

  // ---------------------------------------------------------- 坐标映射

  surfacePoint(lat, lng, lift = 0, target = new THREE.Vector3()) {
    return latLngToVec3(lat, lng, 1 + lift, target);
  }

  pointToLatLng(v) {
    return vec3ToLatLng(v);
  }

  /**
   * 单段插值原语：a→b 之间取 t 处的点。projectPath 用它逐点铺折线，
   * 消费者不直接调它（跨边缘的多段表达是 projectPath 的职责）。
   * 球体走大圆短弧（三维向量插值的免费性质）。
   */
  interpolate(a, b, t, lift = 0, target = new THREE.Vector3()) {
    return slerpLatLng(a.lat, a.lng, b.lat, b.lng, t, 1 + lift, target);
  }

  projectPath(points, liftFn) {
    // 大圆插值按单位方向走，跨 ±180° 天然取短弧——这是三维向量插值的免费性质，
    // 所以球体永远一条折线，没有「跨边缘拆段」这回事
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (i === 0) {
        const p = this.surfacePoint(points[0].lat, points[0].lng, liftFn(points[0].lat, points[0].lng), new THREE.Vector3());
        out.push(p.x, p.y, p.z);
        continue;
      }
      const a = points[i - 1];
      const b = points[i];
      const steps = Math.max(1, Math.ceil(this.segmentAngleDeg(a, b) / 2)); // 细分到 ≤2°，防止弦陷
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        // 浮空量在两端间过渡（中段细化由地形采样在渲染时体现，这里做线性混合够用）
        const lA = liftFn(a.lat, a.lng);
        const lB = liftFn(b.lat, b.lng);
        const p = this.interpolate(a, b, t, lA + (lB - lA) * t, new THREE.Vector3());
        out.push(p.x, p.y, p.z);
      }
    }
    return out.length ? [out] : [];
  }

  clipPolygon(outer, holes = []) {
    // 球面经度环绕，没有「地图边缘」需要裁；环原样交给 earcut（现状行为）
    return [{ outer, holes }];
  }

  segmentAngleDeg(a, b) {
    const angle = latLngToVec3(a.lat, a.lng, 1).angleTo(latLngToVec3(b.lat, b.lng, 1));
    return THREE.MathUtils.radToDeg(angle);
  }

  edgeLengthDeg(lng1, lat1, lng2, lat2) {
    // 考虑纬度收缩：同经度差在高纬对应更短的弧
    const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
    return Math.hypot((lng2 - lng1) * Math.cos(midLat), lat2 - lat1);
  }

  // ---------------------------------------------------------- 表面标架与相机

  getSurfaceFrame(lat, lng) {
    const position = this.surfacePoint(lat, lng, 0);
    const normal = position.clone().normalize();
    // east = 世界北（自转轴）× 法线；极点处退化，兜一个方向免得算出 NaN
    const east = new THREE.Vector3(0, 1, 0).cross(normal);
    if (east.length() < 1e-4) east.set(1, 0, 0);
    else east.normalize();
    const north = normal.clone().cross(east);
    return { position, normal, east, north };
  }

  cameraDirection(lat, lng, target = new THREE.Vector3()) {
    return this.surfacePoint(lat, lng, 0, target).normalize();
  }

  getCameraPose(lat, lng, { distance = 3 } = {}) {
    // 球体的落点与现行 flyTo/初始视角一致：径向方向 × 距离，视线看向原点
    const position = this.cameraDirection(lat, lng, new THREE.Vector3()).multiplyScalar(distance);
    return { position, target: new THREE.Vector3(0, 0, 0) };
  }

  /** 球体没有「底面」：内容显隐全部由掩膜的近/远半球分界承担 */
  contentVisible() {
    return true;
  }

  raycastSurface(raycaster, logicalMesh) {
    const hit = raycaster.intersectObject(logicalMesh, false)[0];
    return hit ? { ...vec3ToLatLng(hit.point), point: hit.point } : null;
  }

  // ---------------------------------------------------------- 渲染工厂

  buildBodyGeometry(segW) {
    return new THREE.SphereGeometry(1, segW, segW / 2);
  }

  /**
   * GPU 地形位移：高度纹理（R+G 打包 16-bit）双线性采样，沿径向位移顶点，
   * 法线用邻域差分扰动。uniforms 由 Globe 持有，这里只挂进着色器程序。
   * 单面渲染：内壁不渲染，洞里是暗的空腔（产品语义，试过点亮内壁，观感怪，废弃）。
   * 显式声明 side：形状切换时材质复用，slab 的 DoubleSide 不能残留到球体。
   */
  patchBodyMaterial(mat, { uniforms }) {
    mat.side = THREE.FrontSide;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHeightTex = uniforms.uHeightTex;
      shader.uniforms.uExaggeration = uniforms.uExaggeration;
      shader.uniforms.uHeightTexel = uniforms.uHeightTexel;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'uniform sampler2D uHeightTex;',
          'uniform float uExaggeration;',
          'uniform vec2 uHeightTexel;',
          '// R+G 打包 16-bit 无符号 → 浮点 [-4, 4]',
          'float unpackHeight(vec2 rg) {',
          '  float u16 = dot(floor(rg * 255.0 + 0.5), vec2(256.0, 1.0));',
          '  return (u16 / 65535.0) * 8.0 - 4.0;',
          '}',
          '// 极点处经度没有定义：极点那一圈顶点全都落在同一点上，却各自采样到',
          '// 不同经线的高度，位移量一不同，球顶就裂成一圈扇形缝隙。这里让极点',
          '// 统一取中央经线的高度，整圈位移到同一位置，再和下面一圈顶点缝合。',
          'vec2 heightUv(vec2 baseUv) {',
          '  float pole = max(smoothstep(0.999, 1.0, baseUv.y), smoothstep(0.999, 1.0, 1.0 - baseUv.y));',
          '  return vec2(mix(baseUv.x, 0.5, pole), baseUv.y);',
          '}',
        ].join('\n'))
        .replace('#include <beginnormal_vertex>', [
          '#include <beginnormal_vertex>',
          '{ // 用高度场邻域差分扰动法线，让山地光照随起伏变化',
          '  vec3 nUnit = normalize(position);',
          '  vec3 eastDir = cross(vec3(0.0, 1.0, 0.0), nUnit);',
          '  float eastLen = length(eastDir);',
          '  if (eastLen > 1e-4) {',
          '    eastDir /= eastLen;',
          '    vec3 northDir = cross(nUnit, eastDir);',
          '    vec2 huv = heightUv(uv);',
          '    float hC = unpackHeight(texture2D(uHeightTex, huv).rg);',
          '    float hE = unpackHeight(texture2D(uHeightTex, huv + vec2(uHeightTexel.x, 0.0)).rg);',
          '    float hN = unpackHeight(texture2D(uHeightTex, huv + vec2(0.0, uHeightTexel.y)).rg);',
          '    float k = uExaggeration * 8.0;',
          '    objectNormal = normalize(objectNormal + (eastDir * (hC - hE) + northDir * (hN - hC)) * k);',
          '  }',
          '}',
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '// 沿径向按高度位移：h=0 海平面，h>0 山隆起，h<0 海床内凹',
          'transformed += normalize(position) * unpackHeight(texture2D(uHeightTex, heightUv(uv)).rg) * uExaggeration;',
        ].join('\n'));
    };
  }

  applyTextureWrapping(colorTex, heightTex) {
    // 横向环绕：地图首尾两列在球上是同一条经线（经度 ±180°），
    // 球面网格在那条线上的顶点是重复的。夹边采样会让 u=0 和 u=1 各读一侧边缘，
    // 高度不同、位移量就不同，接缝处裂开一条能看进球内的竖缝；颜色上也会留下一条深线。
    // 环绕采样让两侧读到同一组边缘混合值，接缝与别处一样连续。纵向仍是夹边——纬度没有环绕。
    colorTex.wrapS = THREE.RepeatWrapping;
    heightTex.wrapS = THREE.RepeatWrapping;
  }

  /**
   * 内容图层的深度掩膜：一张过球心、正对相机的平面，只写深度、不写颜色。
   * 主循环第二趟画它，第三趟画事件/路线/区域时：
   *  - 近半球的内容在平面之前（朝相机），可见，哪怕地形压低到海平面以下；
   *  - 远半球的内容在平面之后，被正确遮住。
   * 用球壳当掩膜时，半径小于 1 的内容（贴到凹陷地形上）会整块被裁掉，
   * 所以这里只需要「过球心」这一刀，不需要跟随地形起伏。
   */
  buildMaskMesh() {
    const mask = new THREE.Mesh(
      new THREE.PlaneGeometry(MASK_HALF * 2, MASK_HALF * 2),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }),
    );
    mask.name = 'overlay-depth-mask';
    mask.layers.set(LAYER_MASK);
    return mask;
  }

  /**
   * 平面过球心，法线始终对准相机；摄像机绕球怎么转，近/远半球的分界都不动。
   * 屏幕四角的视线落在过球心平面上的最远距离 = 相机距离 × tan(半 FOV) × 宽高比。
   * 留一成余量后按基础半边长放大，超宽窗口拉到最远也不会漏掉边角，
   * 保证任何距离、任何窗口比例下，整屏像素都有一份掩膜深度。
   */
  updateMask(mask, camera) {
    mask.quaternion.copy(camera.quaternion);
    const reach = camera.position.length()
      * Math.tan((camera.fov * Math.PI) / 360)
      * Math.max(1, camera.aspect) * 1.1;
    mask.scale.setScalar(Math.max(1, reach / MASK_HALF));
  }

  // ---------------------------------------------------------- 大气

  /**
   * 外圈辉光：放大球 + BackSide + 加法混合，只在地平线边缘露出光环；
   * 地表薄雾：FrontSide 菲涅尔。都是球体专属效果，平板没有对应物。
   */
  buildAtmosphere(group, config, raster = {}) {
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(config.atmosphere[this.atmosphereColorKey]) },
        uStrength: { value: config.atmosphere.strength },
        uPower: { value: 3.5 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uStrength;
        uniform float uPower;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        void main() {
          // 原版实现：远端内壁片元的法线恰好指向视线方向，view 空间里
          // d ≈ +1，rim 饱和——整个远端内壁渲染成一颗亮蓝光球，透过挖洞
          // 与海洋透镜可见；轮廓外因深度衰减自然成环。
          float d = clamp(dot(normalize(vNormal), vec3(0.0, 0.0, -1.0)), 0.0, 1.0);
          float rim = pow(d * 1.9, uPower);
          // 眼球分层：以「视线到球心最近距离 p」为横坐标的三道同心暗带，
          // 把光球分成四层（瞳心 / 内环 / 中环 / 外环）。分层带全部在
          // p < 0.86 < 地形轮廓内，轮廓外的辉光环与常态画面零影响。
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorldPos - cameraPosition);
          float b = dot(ro, rd);
          float p = sqrt(max(dot(ro, ro) - b * b, 0.0));
          float layers = 1.0
            - 0.28 * smoothstep(0.16, 0.24, p) * (1.0 - smoothstep(0.30, 0.38, p))
            - 0.20 * smoothstep(0.42, 0.50, p) * (1.0 - smoothstep(0.56, 0.64, p))
            - 0.14 * smoothstep(0.66, 0.74, p) * (1.0 - smoothstep(0.80, 0.88, p));
          rim *= layers;
          gl_FragColor = vec4(uColor * rim * uStrength, 1.0);
        }`,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this._atmo = {
      mat: atmoMat,
      mesh: new THREE.Mesh(new THREE.SphereGeometry(1.18, 96, 96), atmoMat),
      hazeMat: null,
      hazeMesh: null,
    };

    // 地表薄雾：FrontSide 菲涅尔，随地形起伏贴合地表（几何半径 1.004 的余量 +
    // 高度位移）。固定半径的雾壳会被抬高的地形整个埋掉（全陆地时雾层直接消失），
    // 所以顶点采样同一张高度纹理做同源位移，永远浮在地表上方一线；
    // 挖掉地形的地方靠颜色贴图的直通 alpha 一刀切开，与顶面/遮挡代理同一套掩膜语义
    const hazeMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(config.atmosphere[this.atmosphereColorKey]) },
        uStrength: { value: config.atmosphere.strength * 0.3 },
        uHeightTex: raster.uHeightTex ?? { value: null },
        uExaggeration: raster.uExaggeration ?? { value: 1 },
        uColorTex: raster.uColorTex ?? { value: null },
      },
      vertexShader: /* glsl */ `
        uniform sampler2D uHeightTex;
        uniform float uExaggeration;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vWorldPos;
        varying vec2 vUv;
        float unpackHeightHaze(vec2 rg) {
          float u16 = dot(floor(rg * 255.0 + 0.5), vec2(256.0, 1.0));
          return (u16 / 65535.0) * 8.0 - 4.0;
        }
        vec2 heightUvHaze(vec2 baseUv) {
          float pole = max(smoothstep(0.999, 1.0, baseUv.y), smoothstep(0.999, 1.0, 1.0 - baseUv.y));
          return vec2(mix(baseUv.x, 0.5, pole), baseUv.y);
        }
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewDir = normalize(-mv.xyz);
          // 沿径向做与地形同源的高度位移：雾壳始终浮在地表上方
          float hC = unpackHeightHaze(texture2D(uHeightTex, heightUvHaze(uv)).rg);
          vec3 displaced = position + normalize(position) * hC * uExaggeration;
          vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(displaced, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uStrength;
        uniform sampler2D uColorTex;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vWorldPos;
        varying vec2 vUv;
        void main() {
          // 透明掩膜挖掉地形的地方，雾也一起切开（直通 alpha，与顶面同一判据）
          if (texture2D(uColorTex, vUv).a < 0.5) discard;
          float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0), 2.6);
          gl_FragColor = vec4(uColor * fresnel * uStrength, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this._atmo.hazeMat = hazeMat;
    this._atmo.hazeMesh = new THREE.Mesh(new THREE.SphereGeometry(1.004, 96, 96), hazeMat);
    group.add(this._atmo.mesh, this._atmo.hazeMesh);
    this.applyAtmosphereConfig(config);
  }

  applyAtmosphereConfig(config) {
    if (!this._atmo) return;
    this._atmo.mat.uniforms.uColor.value.set(config.atmosphere[this.atmosphereColorKey]);
    this._atmo.mat.uniforms.uStrength.value = config.atmosphere.strength;
    this._atmo.mesh.visible = config.atmosphere.enabled;
    this._atmo.hazeMat.uniforms.uColor.value.set(config.atmosphere[this.atmosphereColorKey]);
    this._atmo.hazeMat.uniforms.uStrength.value = config.atmosphere.strength * 0.3;
    this._atmo.hazeMesh.visible = config.atmosphere.enabled;
  }

  disposeAtmosphere(group) {
    if (!this._atmo) return;
    group.remove(this._atmo.mesh, this._atmo.hazeMesh);
    this._atmo.mesh.geometry.dispose();
    this._atmo.mat.dispose();
    this._atmo.hazeMesh.geometry.dispose();
    this._atmo.hazeMat.dispose();
    this._atmo = null;
  }
}
