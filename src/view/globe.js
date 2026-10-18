import * as THREE from 'three';
import { LAYER_MASK } from './render-layers.js';

/**
 * 世界之球：一张地图 + 大气辉光 + 星空 + 固定光照。
 * 地图有两种状态：
 *  - 无地图 setBlank()：深色空球，高度全是海平面，没有任何起伏
 *  - 有地图 setRaster(grid)：颜色纹理 + 高度纹理，顶点着色器做真实位移，
 *    「画一笔山，球面上当场鼓起来」
 * 高度纹理用线性色空间 + 双线性采样：
 *  - 色空间必须是线性的，高度值才不会被 sRGB 曲线拉歪；
 *  - 采样要插值：最近点采样把每一格铺成一整块平地、格与格之间高度直接跳变，
 *    栅格细到省级尺度之后，这些方块就是斜看时满屏的硬块。
 *    高度按 R+G 打包成 16-bit，双线性对它无害——解包是两通道的线性运算，
 *    各自插值再解包，与先解包再插值只差一次逐通道取整。
 */
export class Globe {
  /**
   * @param {THREE.Scene} scene
   * @param {object} config 画面设置（保持引用）
   * @param {number} maxAnisotropy
   */
  constructor(scene, config, maxAnisotropy = 8) {
    this.scene = scene;
    this.config = config;
    this.maxAnisotropy = maxAnisotropy;
    this.group = new THREE.Group();
    scene.add(this.group);
    // 空球与无位移共用的两张 1×1 贴图：始终有 map 和 uHeightTex，
    // 着色器从构造起就走同一条分支，换地图时不会触发重编译
    this._blankTex = makeBlankTexture();
    this._flatHeightTex = makeBlackTexture();

    // 位移/法线着色器共享的 uniform（onBeforeCompile 里挂进程序）
    this._uHeightTex = { value: this._flatHeightTex };
    this._uExaggeration = { value: config.terrain.exaggeration };
    // 一格的高度纹理步长，供着色器取邻域差分算法线；这里先按占位贴图（1×1）配一套，
    // 真正上栅格时由 setRaster 按网格尺寸改写
    this._uHeightTexel = { value: new THREE.Vector2(1, 1) };
    this._segments = null;
    this._colorTex = null;
    this._heightTex = null;
    this._lastStarsCount = config.stars.count;
    // 自转时相机转了多少，星场也转多少；重建星场后要沿用这个累积量，否则星空会跳一下
    this._starsSpin = new THREE.Quaternion();

    this._buildSphere();
    this._buildOverlayMask();
    this._buildAtmosphere();
    this._buildLights();
    this._buildStars();
    this.setConfig(config);
  }

  _buildSphere() {
    this.sphereMat = new THREE.MeshPhongMaterial({
      map: this._blankTex,
      shininess: 6,
      specular: new THREE.Color(0x111111),
    });
    this.sphereMat.onBeforeCompile = (shader) => {
      shader.uniforms.uHeightTex = this._uHeightTex;
      shader.uniforms.uExaggeration = this._uExaggeration;
      shader.uniforms.uHeightTexel = this._uHeightTexel;
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
          '    float hC = unpackHeight(texture2D(uHeightTex, uv).rg);',
          '    float hE = unpackHeight(texture2D(uHeightTex, uv + vec2(uHeightTexel.x, 0.0)).rg);',
          '    float hN = unpackHeight(texture2D(uHeightTex, uv + vec2(0.0, uHeightTexel.y)).rg);',
          '    float k = uExaggeration * 8.0;',
          '    objectNormal = normalize(objectNormal + (eastDir * (hC - hE) + northDir * (hN - hC)) * k);',
          '  }',
          '}',
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '// 沿径向按高度位移：h=0 海平面，h>0 山隆起，h<0 海床内凹',
          'transformed += normalize(position) * unpackHeight(texture2D(uHeightTex, uv).rg) * uExaggeration;',
        ].join('\n'));
    };
    this.sphere = new THREE.Mesh(this._makeGeometry(256), this.sphereMat);
    this.sphere.name = 'world-sphere';
    this.group.add(this.sphere);
  }

  /**
   * 内容图层的深度掩膜：一个「不含地形起伏」的正球，只写深度、不写颜色。
   * 主循环第二趟单独画它，第三趟画事件/路线/区域时就有了一份光滑球面的深度——
   * 于是内容不会被鼓起来的山挡住（山在半径 1 之上，掩膜在 1 上），
   * 但转到球背面仍然会被它正确挡住。
   * 分段数取得比球体高：轮廓越接近正圆，贴着地平线的标注越不会闪烁。
   */
  _buildOverlayMask() {
    this.overlayMask = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 64),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true }),
    );
    this.overlayMask.name = 'overlay-depth-mask';
    this.overlayMask.layers.set(LAYER_MASK);
    this.group.add(this.overlayMask);
  }

  /** 球体分段数跟随栅格分辨率，保证顶点密度 ≥ 高度纹理密度 */
  _makeGeometry(segW) {
    segW = Math.min(1024, Math.max(192, segW));
    this._segments = segW;
    return new THREE.SphereGeometry(1, segW, segW / 2);
  }

  /**
   * 换地图时刻意不碰 sphereMat.needsUpdate。
   * three 里 needsUpdate 会让材质 version++，下一帧整个地形着色器要重新编译并链接——
   * 实测一次 100ms 以上，正好落在换地图那一帧上，就是「换一次地图卡一下」的来源。
   * 这里换的只是 map 与几个 uniform，着色器分支（有没有贴图）从构造起就没变过，
   * 根本不需要重编译；真要改分支，改的是 onBeforeCompile 本身，那时才该 needsUpdate。
   */

  /** 没有地图：深色空球，高度回到海平面 */
  setBlank() {
    this._disposeRasterTextures();
    this.sphereMat.map = this._blankTex;
    this._uHeightTex.value = this._flatHeightTex;
  }

  /**
   * 有地图：颜色画布 + 高度画布同时上球。
   * 工坊绘制过程中反复调用 updateRasterTextures() 即可实时看到山体变形。
   */
  setRaster(grid) {
    const segW = Math.min(1024, Math.max(192, grid.w));
    if (this._segments !== segW) {
      this.sphere.geometry.dispose();
      this.sphere.geometry = this._makeGeometry(segW);
    }
    this._disposeRasterTextures();
    this._colorTex = new THREE.CanvasTexture(grid.colorCanvas);
    this._colorTex.colorSpace = THREE.SRGBColorSpace;
    this._colorTex.anisotropy = this.maxAnisotropy;
    this._heightTex = new THREE.CanvasTexture(grid.heightCanvas);
    // 高度纹理用线性色空间 + 双线性采样（理由见文件头）
    this._heightTex.colorSpace = THREE.LinearSRGBColorSpace;
    this._heightTex.magFilter = THREE.LinearFilter;
    this._heightTex.minFilter = THREE.LinearFilter;
    // 不生成 mipmap，缩小过滤就只能配 Linear：给了带 mipmap 的过滤器又不生成，
    // WebGL 采到的是一张不完整的贴图，整颗球会变成黑的
    this._heightTex.generateMipmaps = false;
    this._uHeightTex.value = this._heightTex;
    this._uHeightTexel.value.set(1 / grid.w, 1 / grid.h);
    this.sphereMat.map = this._colorTex;
  }

  /** 栅格画布内容变化后刷新纹理（不重建） */
  updateRasterTextures() {
    if (this._colorTex) this._colorTex.needsUpdate = true;
    if (this._heightTex) this._heightTex.needsUpdate = true;
  }

  _disposeRasterTextures() {
    this._colorTex?.dispose();
    this._heightTex?.dispose();
    this._colorTex = null;
    this._heightTex = null;
  }

  _buildAtmosphere() {
    // 外圈辉光：放大球 + BackSide + 加法混合，只在地平线边缘露出光环
    this.atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(this.config.atmosphere.color) },
        uStrength: { value: this.config.atmosphere.strength },
        uPower: { value: 3.5 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uStrength;
        uniform float uPower;
        varying vec3 vNormal;
        void main() {
          float d = clamp(dot(normalize(vNormal), vec3(0.0, 0.0, -1.0)), 0.0, 1.0);
          float rim = pow(d * 1.9, uPower);
          gl_FragColor = vec4(uColor * rim * uStrength, 1.0);
        }`,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.atmoMesh = new THREE.Mesh(new THREE.SphereGeometry(1.18, 96, 96), this.atmoMat);
    this.group.add(this.atmoMesh);

    // 地表薄雾：FrontSide 菲涅尔
    this.hazeMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(this.config.atmosphere.color) },
        uStrength: { value: this.config.atmosphere.strength * 0.3 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewDir = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uStrength;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0), 2.6);
          gl_FragColor = vec4(uColor * fresnel * uStrength, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.hazeMesh = new THREE.Mesh(new THREE.SphereGeometry(1.004, 96, 96), this.hazeMat);
    this.group.add(this.hazeMesh);
  }

  _buildLights() {
    this.keyLight = new THREE.DirectionalLight(0xffffff, this.config.light.key);
    this.keyLight.position.set(2.5, 1.5, 3).normalize().multiplyScalar(10);
    this.group.add(this.keyLight);
    this.ambient = new THREE.AmbientLight(0xdfe8ff, this.config.light.ambient);
    this.group.add(this.ambient);
  }

  _buildStars() {
    if (this.stars) {
      this.scene.remove(this.stars);
      this.stars.geometry.dispose();
      this.stars.material.dispose();
    }
    const count = this.config.stars.count;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    // 三档星点：多数是低亮度灰白，少数暖白亮星，极少数灰金装饰星。
    // 亮度靠顶点色压暗，不用逐点透明度——PointsMaterial 没有逐顶点 alpha。
    const faint = new THREE.Color('#d8cbb4');
    const bright = new THREE.Color('#e8dfcf');
    const gold = new THREE.Color('#a98b60');
    for (let i = 0; i < count; i++) {
      v.randomDirection().multiplyScalar(40 + Math.random() * 60);
      pos.set([v.x, v.y, v.z], i * 3);
      const roll = Math.random();
      if (roll < 0.78) {
        c.copy(faint).multiplyScalar(0.28 + Math.random() * 0.22);
      } else if (roll < 0.94) {
        c.copy(bright).multiplyScalar(0.62 + Math.random() * 0.2);
      } else {
        c.copy(gold).multiplyScalar(0.34 + Math.random() * 0.18);
      }
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.25,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }));
    this.stars.quaternion.copy(this._starsSpin);
    this.scene.add(this.stars);
  }

  /**
   * 自动旋转时把星场和相机一起转。
   * 星空在屏幕上保持不动，看起来只有地球在转；相机的朝向因此始终对着同一片星空。
   */
  spinStars(q) {
    this._starsSpin.premultiply(q);
    this.stars.quaternion.copy(this._starsSpin);
  }

  setConfig(config = this.config) {
    this.config = config;
    this.keyLight.intensity = config.light.key;
    this.ambient.intensity = config.light.ambient;
    this._uExaggeration.value = config.terrain.exaggeration;
    this.atmoMat.uniforms.uColor.value.set(config.atmosphere.color);
    this.atmoMat.uniforms.uStrength.value = config.atmosphere.strength;
    this.atmoMesh.visible = config.atmosphere.enabled;
    this.hazeMat.uniforms.uColor.value.set(config.atmosphere.color);
    this.hazeMat.uniforms.uStrength.value = config.atmosphere.strength * 0.3;
    this.hazeMesh.visible = config.atmosphere.enabled;
    this.stars.visible = config.stars.enabled;
    if (config.stars.count !== this._lastStarsCount) {
      this._lastStarsCount = config.stars.count;
      this._buildStars();
      this.stars.visible = config.stars.enabled;
    }
  }

  update(dt, camera) {
  }
}

/** 1x1 无位移高度纹理：R+G 解包后 ≈ 0（海平面），空球与无地图时使用 */
function makeBlackTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([127, 255, 0, 255]), 1, 1);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** 1x1 深色空球贴图：没有地图时球体仍然有 map，着色器分支不变 */
function makeBlankTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([12, 20, 34, 255]), 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
