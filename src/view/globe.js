import * as THREE from 'three';
import { DEFAULT_CONFIG, TERRAIN_MESH_SEGMENTS } from '../config.js';
import { SphereShape } from './shapes/sphere-shape.js';

/**
 * 世界主体：一张地图 + 光照 + 星空，外加形状自带的大气与深度掩膜。
 * 「世界长成什么形状」由 WorldShape（view/shapes/）回答：球体是默认形状，
 * 平板等形状各自实现坐标映射、位移 shader、掩膜与相机语义，本类只管
 * 贴图生命周期（setRaster/setBlank）、光照与星空这些与形状无关的机制。
 * 地图有两种状态：
 *  - 无地图 setBlank()：深色空体，高度全是海平面，没有任何起伏
 *  - 有地图 setRaster(grid)：颜色纹理 + 高度纹理，顶点着色器做真实位移，
 *    「画一笔山，表面上当场鼓起来」
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
   * @param {import('./shapes/world-shape.js').WorldShape} [shape] 世界形状，默认球体
   */
  constructor(scene, config, maxAnisotropy = 8, shape = new SphereShape()) {
    this.scene = scene;
    this.config = config;
    this.maxAnisotropy = maxAnisotropy;
    this.shape = shape;
    this.group = new THREE.Group();
    scene.add(this.group);
    // 空体与无位移共用的两张 1×1 贴图：始终有 map 和 uHeightTex，
    // 着色器从构造起就走同一条分支，换地图时不会触发重编译
    this._blankTex = makeBlankTexture();
    this._flatHeightTex = makeBlackTexture();

    // 位移/法线着色器共享的 uniform（形状的 patchBodyMaterial 挂进程序）。
    // 形状只借引用，不自建副本——换地图改 value，各形状同时生效
    this._uHeightTex = { value: this._flatHeightTex };
    this._uExaggeration = { value: config.terrain.exaggeration };
    // 一格的高度纹理步长，供着色器取邻域差分算法线；这里先按占位贴图（1×1）配一套，
    // 真正上栅格时由 setRaster 按网格尺寸改写
    this._uHeightTexel = { value: new THREE.Vector2(1, 1) };
    this._segments = null;
    this._grid = null;       // 当前贴图对应的栅格；改网格精度时据此重算段数
    this._colorTex = null;
    this._heightTex = null;
    this._lastStarsCount = config.stars.count;
    // 自转时相机转了多少，星场也转多少；重建星场后要沿用这个累积量，否则星空会跳一下
    this._starsSpin = new THREE.Quaternion();

    this._buildBody();
    this._buildMask();
    if (this.shape.hasAtmosphere) this._buildAtmosphere();
    this._buildLights();
    this._buildStars();
    this.setConfig(config);
  }

  /**
   * 主体：材质由本类持有（贴图生命周期与形状无关），形状往里注入位移 shader。
   */
  _buildBody() {
    this.bodyMat = new THREE.MeshPhongMaterial({
      map: this._blankTex,
      shininess: 6,
      specular: new THREE.Color(0x111111),
      // alphaTest 常开：透明边界掩膜写在颜色画布的 alpha 里（0/255 二值），
      // 无掩膜时 alpha 恒 255、一片都不会被裁。常开的意义在「换地图永不重编译」——
      // 若按有/无掩膜切换 alphaTest，每条 define 分支变化都是一次 100ms+ 的程序重链接
      alphaTest: 0.5,
    });
    this.shape.patchBodyMaterial(this.bodyMat, {
      uniforms: {
        uHeightTex: this._uHeightTex,
        uExaggeration: this._uExaggeration,
        uHeightTexel: this._uHeightTexel,
      },
    });
    this.body = new THREE.Mesh(this._makeGeometry(256), this.bodyMat);
    this.body.name = 'world-body';
    this.group.add(this.body);
    this._buildStatic();
  }

  /** 形状的静态附属网格（若有）；形状在 patchBodyMaterial 里自定双面渲染等材质语义 */
  _buildStatic() {
    this._staticMeshes = this.shape.buildStaticMeshes?.(this.config) ?? [];
    for (const m of this._staticMeshes) this.group.add(m);
  }

  _disposeStatic() {
    for (const m of this._staticMeshes ?? []) {
      m.traverse((o) => {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const mat of mats) mat.dispose();
      });
      this.group.remove(m);
    }
    this._staticMeshes = [];
  }

  /**
   * 设置里选的网格精度是宽度段数上限；再按地图宽度截一次：
   * 2048 宽的地图配 2048 段时，一个顶点对应一个高度纹素；地图更窄时没必要造更密的网格。
   */
  _meshCap() {
    const value = this.config?.terrain?.meshSegments;
    return TERRAIN_MESH_SEGMENTS.includes(value)
      ? value
      : DEFAULT_CONFIG.terrain.meshSegments;
  }

  _makeGeometry(segW) {
    segW = Math.min(this._meshCap(), Math.max(192, segW));
    this._segments = segW;
    return this.shape.buildBodyGeometry(segW);
  }

  /** 按当前地图与设置重建主体网格；段数没变就什么都不做 */
  _applyMesh(gridW) {
    const segW = Math.min(this._meshCap(), Math.max(192, gridW));
    if (this._segments === segW) return;
    this.body.geometry.dispose();
    this.body.geometry = this._makeGeometry(segW);
  }

  _buildMask() {
    this.overlayMask = this.shape.buildMaskMesh();
    this.group.add(this.overlayMask);
  }

  /**
   * 换世界形状（球 ↔ 平板）：几何、掩膜、大气随形状重建，材质与贴图复用。
   * 着色器分支变了（径向位移 ↔ 法向位移），必须置 needsUpdate 让程序重编译——
   * 这与「换地图不重编译」不矛盾：换地图只换 uniform 的 value，分支从没变过；
   * 换形状换的是 onBeforeCompile 本身，一次性的重编译落在切换那一刻，是应得的。
   * 调用方随后要重新贴一次 raster（applyStage 本来就会做）。
   * @returns {boolean} 形状是否真的变了（调用方据此重摆相机）
   */
  setShape(shape) {
    if (shape.id === this.shape.id) return false; // 同形状幂等：换地图时几何与 shader 一概不动
    this.shape.disposeAtmosphere?.(this.group);
    this.overlayMask.geometry.dispose();
    this.overlayMask.material.dispose();
    this.group.remove(this.overlayMask);
    this._disposeStatic();
    this.shape = shape;
    this.body.geometry.dispose();
    this.body.geometry = this._makeGeometry(256);
    this.shape.patchBodyMaterial(this.bodyMat, {
      uniforms: {
        uHeightTex: this._uHeightTex,
        uExaggeration: this._uExaggeration,
        uHeightTexel: this._uHeightTexel,
      },
    });
    this.bodyMat.needsUpdate = true;
    this._buildMask();
    this._buildStatic();
    if (this.shape.hasAtmosphere) this._buildAtmosphere();
    this.setConfig(this.config);
    return true;
  }

  /**
   * 换地图时刻意不碰 bodyMat.needsUpdate。
   * three 里 needsUpdate 会让材质 version++，下一帧整个地形着色器要重新编译并链接——
   * 实测一次 100ms 以上，正好落在换地图那一帧上，就是「换一次地图卡一下」的来源。
   * 这里换的只是 map 与几个 uniform，着色器分支（有没有贴图）从构造起就没变过，
   * 根本不需要重编译；真要改分支（换形状），改的是 onBeforeCompile 本身，那时才该 needsUpdate。
   */

  /** 没有地图：深色空体，高度回到海平面 */
  setBlank() {
    this._grid = null;
    this._disposeRasterTextures();
    this.bodyMat.map = this._blankTex;
    this._uHeightTex.value = this._flatHeightTex;
    // 颜色贴图退回空体：旧颜色纹理刚被 dispose，不能留在槽位上被再次上传
    this._uSurfaceColorTex.value = this._blankTex;
  }

  /**
   * 有地图：颜色画布 + 高度画布同时上体。
   * 工坊绘制过程中反复调用 updateRasterTextures() 即可实时看到山体变形。
   */
  setRaster(grid) {
    this._grid = grid;
    this._applyMesh(grid.w);
    this._disposeRasterTextures();
    // 颜色纹理不走 canvas：canvas 是预乘存储，掩膜挖洞后洞格 alpha=0，
    // RGB 会被清零，切割线上保留的片元混进一半黑色，看起来发暗发淡
    // （raster.js 头注释记录的同一个预乘坑）。改用 renderColor 维护的
    // ImageData 直通 alpha 上传：洞格 RGB 原样保留，只作双线性过滤的边缘色——
    // 切割线颜色全强度，观感与四缘断面（满 alpha 格夹边采样）一致
    this._colorTex = new THREE.DataTexture(grid._image.data, grid.w, grid.h);
    this._colorTex.colorSpace = THREE.SRGBColorSpace;
    this._colorTex.magFilter = THREE.LinearFilter;
    this._colorTex.minFilter = THREE.LinearFilter;
    this._colorTex.generateMipmaps = false;
    // canvas 的 y 向下、纹理 v 向上，与原 CanvasTexture 的 flipY 对齐
    this._colorTex.flipY = true;
    this._colorTex.anisotropy = this.maxAnisotropy;
    this._colorTex.needsUpdate = true;
    // 高度纹理画布：R+G=16 位高度，alpha 恒为 255。
    // 颜色低位不能塞进 alpha：canvas 会预乘 alpha，连 R/G 的高度一起压坏。
    this._heightTex = new THREE.CanvasTexture(grid.packedCanvas);
    // 高度纹理用线性色空间 + 双线性采样（理由见文件头）
    this._heightTex.colorSpace = THREE.LinearSRGBColorSpace;
    this._heightTex.magFilter = THREE.LinearFilter;
    this._heightTex.minFilter = THREE.LinearFilter;
    // 环绕语义随形状走：球体横向 Repeat（首尾经线是同一条），平板 Clamp（边缘即断面）。
    // 不生成 mipmap，缩小过滤就只能配 Linear：给了带 mipmap 的过滤器又不生成，
    // WebGL 采到的是一张不完整的贴图，整颗球会变成黑的
    this._heightTex.generateMipmaps = false;
    this.shape.applyTextureWrapping(this._colorTex, this._heightTex);
    this._uHeightTex.value = this._heightTex;
    this._uHeightTexel.value.set(1 / grid.w, 1 / grid.h);
    this.bodyMat.map = this._colorTex;
    // 薄雾的掩膜判据吃同一张颜色贴图（换地图换纹理对象，槽位在这里换绑）
    if (this._uAtmoColorTex) this._uAtmoColorTex.value = this._colorTex;
    // 附属网格随形状走（当前两形状均无静态附属）
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
    // 薄雾要随地形起伏位移并按掩膜开洞：把共享高度/夸张 uniform（Globe 持有，
    // 换地图调 value 即全员生效）与颜色贴图槽位一起交给形状
    this._uAtmoColorTex = { value: this._colorTex ?? this._blankTex };
    this.shape.buildAtmosphere(this.group, this.config, {
      uHeightTex: this._uHeightTex,
      uExaggeration: this._uExaggeration,
      uColorTex: this._uAtmoColorTex,
    });
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
    this.shape.applyAtmosphereConfig?.(config);
    this.stars.visible = config.stars.enabled;
    if (config.stars.count !== this._lastStarsCount) {
      this._lastStarsCount = config.stars.count;
      this._buildStars();
      this.stars.visible = config.stars.enabled;
    }
    // 精度档位变了就按当前地图重建；段数没变时这里只是一次比较
    if (this._grid) this._applyMesh(this._grid.w);
  }

  update(dt, camera) {
    if (!camera) return;
    // 掩膜的摆法是形状的遮挡语义：球体正对相机，平板锁死水平面
    this.shape.updateMask?.(this.overlayMask, camera);
  }
}

/** 1x1 无位移高度纹理：R+G 解包后 ≈ 0（海平面），空体与无地图时使用 */
function makeBlackTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([127, 255, 0, 255]), 1, 1);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** 1x1 深色空体贴图：没有地图时主体仍然有 map，着色器分支不变 */
function makeBlankTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([12, 20, 34, 255]), 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
