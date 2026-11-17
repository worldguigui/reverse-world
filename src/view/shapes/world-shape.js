import * as THREE from 'three';

/**
 * 世界形状：lat/lng 数据域 → 三维世界坐标 的投影方式。
 *
 * 本项目的数据域只有一套：等距圆柱地图（lat/lng + 归一化高度 [-4,4] + 水浓度），
 * 事件、路线、区域、工坊画笔全都活在 lat/lng 里。形状只回答一件事——
 * 「这套数据展开成三维时长什么样」。球体是一张卷在球面上的地图，
 * 平板是一块铺在桌面上的地图；数据一条不动，换形状等于换投影。
 *
 * 实现这个接口时要守住的不变量：
 *  1. **地形永远不遮挡内容**。内容（光点/路线/区域）浮在名义表面之上，
 *     即使地形被画笔压到海平面以下也不能把它裁掉。第二趟渲染前的
 *     clearDepth() 把真实地形深度整帧清掉，显隐由两件事分担：
 *     掩膜（buildMaskMesh，只承担「地形不挡内容」）与内容层显隐
 *     （contentVisible，承担「世界背面不露内容」）。
 *  2. **相机公式只用 referenceScale**。推近/放大/拖拽手感全部由
 *     「距原点距离 - referenceScale」推导，形状必须把自己的尺度归一化到
 *     这个字段上，相机代码才能保持形状无关。
 *  3. **高度位移只用 heightScale**。地形 [-4,4] × exaggeration × heightScale
 *     是世界坐标里的位移量；内容浮空常数（0.003 之类）不参与这个缩放，
 *     两种尺度不能混用一个系数。
 *  4. **lat/lng 是唯一数据域**。形状不得要求数据侧为它改语义——跨 ±180°
 *     的路线在球上是短弧、在平板上拆成两段，差别由形状的 projectPath /
 *     topology 表达，事件表单里的经纬度永远照写不误。
 */
export class WorldShape {
  /** 形状标识，与 project.shape.type 对应 */
  id = 'abstract';

  /**
   * 相机参考尺度：**离表面的净距 = 相机到 controls.target 的距离 − referenceScale**。
   * 档位、拖拽速度、滚轮梯子都由它推导。球体的 target 恒为原点、表面是半径 1 的球，
   * 净距 = 原点距离 − 1；平板的 target 就在板面上，净距 = 距 target 距离 − 0。
   * 档位 1 = 出厂净距（config.distance − referenceScale）。
   */
  referenceScale = 1;

  /** 地形高度的形状专属比例：高度 [-4,4] × exaggeration × heightScale = 世界位移 */
  heightScale = 1;

  /**
   * 空间拓扑：经度/纬度是否首尾相连。
   *  - 球体：经度环绕（±180° 是同一条经线），纬度不环绕（极点汇聚成点）；
   *  - 平板：两者都不环绕，地图四缘即世界边缘。
   * 贴图 wrap、路径拆分、区域裁剪据此分派，不许把球面的环绕假设偷偷带进平板。
   */
  topology = Object.freeze({ longitudeWrap: false, latitudeWrap: false });

  /** 区域三角形是否需要防弦陷的递归细分（曲面要，平面直线投影不需要） */
  subdivides = true;

  /** 是否有氛围效果（球=外圈辉光+薄雾，平板=板底边缘光晕）；设置面板据适配控件文案 */
  hasAtmosphere = false;

  /**
   * 氛围色在 config.atmosphere 里的键名：两种形状各存一份默认色，互不覆盖——
   * 球体蓝（外圈辉光的经典配色）、平板暗金（项目色板的旧金边界色）。
   * 面板改的是当前形状的那一份。
   */
  atmosphereColorKey = 'colorSphere';

  /**
   * 平面相机模式：true = 锁死视角、左键拖动平移地图、无翻转/自转/弧线飞行，
   * 飞行是 target 在平面上的滑动（平板地图的样子）；false = 自由翻滚轨道相机（球体）。
   */
  planarCamera = false;

  /**
   * 平面相机的「相机 − target」基准偏移向量，长度 = 到 target 的距离。
   * 基类给正上方；平板向南倾一个固定角，让地形坡面朝向镜头、有侧影。
   * 这只是「基准方向」——水平方位角（绕竖直轴的旋转）由 rig 统一施加，
   * 形状不感知当前朝向。
   */
  // eslint-disable-next-line no-unused-vars
  planarCameraOffset(distance, target = new THREE.Vector3()) {
    return new THREE.Vector3(0, distance, 0);
  }

  /**
   * 平面相机拖动平移时，把视点中心夹回有效范围（不许滑出世界之外）。
   * 球体不需要，基类空实现。
   */
  // eslint-disable-next-line no-unused-vars
  clampCameraTarget(target) {}

  // ---------------------------------------------------------- 坐标映射

  /**
   * lat/lng + 浮空量 → 世界坐标。lift 是「沿表面法线抬离名义表面的高度」：
   * 球沿径向，平板沿 +Y。地形贴地用 terrainRadius 的返回值做 lift，
   * 内容层的浮空常数（0.003 等）直接加上去。
   * @returns {THREE.Vector3} target
   */
  // eslint-disable-next-line no-unused-vars
  surfacePoint(lat, lng, lift = 0, target = new THREE.Vector3()) {
    throw new Error('WorldShape.surfacePoint 未实现');
  }

  /** 世界坐标 → lat/lng（surfacePoint 的逆，用于拾取与相机位置回报） */
  // eslint-disable-next-line no-unused-vars
  pointToLatLng(v) {
    throw new Error('WorldShape.pointToLatLng 未实现');
  }

  /**
   * 单段插值原语：a→b 之间取 t 处的点（球=大圆短弧，平板=直线）。
   * 只被 projectPath 内部组合使用，消费者不直接调它——跨边缘的多段
   * 表达是 projectPath 的职责，单个插值函数表达不了拆段。
   * @param {{lat:number, lng:number}} a
   * @param {{lat:number, lng:number}} b
   * @param {number} t [0,1]
   * @param {number} lift 该点的浮空量
   * @returns {THREE.Vector3} target
   */
  // eslint-disable-next-line no-unused-vars
  interpolate(a, b, t, lift = 0, target = new THREE.Vector3()) {
    throw new Error('WorldShape.interpolate 未实现');
  }

  /**
   * 把 lat/lng 折线投影为若干条**独立**的三维折线（每条是扁平 [x,y,z,…] 数组）。
   * 跨边缘的路径在平板上拆成多条（出右缘截断、从左缘再入），球体恒返回一条
   * 大圆插值折线。liftFn(lat,lng) 提供每点的浮空量。路线层只消费结果，
   * 不感知「有没有发生拆分」。
   * @param {Array<{lat:number, lng:number}>} points
   * @param {(lat:number, lng:number) => number} liftFn
   * @returns {number[][]}
   */
  // eslint-disable-next-line no-unused-vars
  projectPath(points, liftFn) {
    throw new Error('WorldShape.projectPath 未实现');
  }

  /**
   * 把 lng-lat 多边形（外环 + 孔洞）裁剪到形状的有效域内，返回若干独立的多边形。
   * 球体恒等返回（经度环绕，无需裁剪）；平板对跨 ±180° 的环做多结果裁剪
   * （P3 起用 polygon-clipping / Martinez，凹多边形可产出多个连通块）。
   * 孔洞按「保证在内部的代表点」归属到包含它的外环块，不用质心——凹多边形的
   * 质心可能落在形外。业务入口当前恒传 holes = []（数据模型暂无孔洞）。
   * @param {Array<[number, number]>} outer [lng, lat] 环
   * @param {Array<Array<[number, number]>>} holes
   * @returns {Array<{ outer: Array<[number, number]>, holes: Array<Array<[number, number]>> }>}
   */
  // eslint-disable-next-line no-unused-vars
  clipPolygon(outer, holes = []) {
    throw new Error('WorldShape.clipPolygon 未实现');
  }

  /** 两点之间的弧长（度），供路线细分定步长 */
  // eslint-disable-next-line no-unused-vars
  segmentAngleDeg(a, b) {
    throw new Error('WorldShape.segmentAngleDeg 未实现');
  }

  /**
   * lng-lat 平面上一条边的长度（度），供区域细分判断是否够小。
   * 球体实现要考虑纬度收缩（cos midLat），平板直接算平面距离。
   */
  // eslint-disable-next-line no-unused-vars
  edgeLengthDeg(lng1, lat1, lng2, lat2) {
    throw new Error('WorldShape.edgeLengthDeg 未实现');
  }

  // ---------------------------------------------------------- 表面标架与相机

  /**
   * 表面标架：某点的表面位置、法线与局部东西/北方向。
   * 未来贴地标签、平板俯视 target 都从它取；极点处 east 退化时实现要兜底方向。
   * @returns {{ position: THREE.Vector3, normal: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3 }}
   */
  // eslint-disable-next-line no-unused-vars
  getSurfaceFrame(lat, lng) {
    throw new Error('WorldShape.getSurfaceFrame 未实现');
  }

  /**
   * flyTo 的目标方向（单位向量）：相机悬在哪个方向上。
   * 球 = 该点的径向方向；平板 = 该点上方。P1–P3 飞行只吃这个方向；
   * P4 起改吃 getCameraPose 的完整位姿（含 target）。
   * @returns {THREE.Vector3} target
   */
  // eslint-disable-next-line no-unused-vars
  cameraDirection(lat, lng, target = new THREE.Vector3()) {
    throw new Error('WorldShape.cameraDirection 未实现');
  }

  /**
   * 相机位姿：飞到 (lat, lng) 上空的完整落点。
   * @param {{ distance?: number }} opts distance = **到 target 的距离**（统一的
   *   距离语义：球 = 原点距离，平板 = 离板面净高）。荒谬的小值由实现用各自的
   *   最低余量兜底（球靠 minDistance，平板用 cMin 夹底）。
   * @returns {{ position: THREE.Vector3, target: THREE.Vector3 }}
   *   球体 target 恒为原点（与现行 controls.target 一致）；平板返回目标点本身，
   *   相机真正朝向它。飞行途中 rig 对 target 做插值，落定后把它交给 controls.target。
   */
  // eslint-disable-next-line no-unused-vars
  getCameraPose(lat, lng, { distance = 3 } = {}) {
    throw new Error('WorldShape.getCameraPose 未实现');
  }

  /**
   * 内容层显隐判据（双机制的一半）：相机在这个位置时，内容层该不该整体可见。
   * 球体恒可见（近/远半球的遮挡全部交给掩膜）；平板 = 相机高于名义顶面，
   * 潜入世界底面时内容整体隐藏——一张水平平面挡不住相机两侧的内容，
   * 这个规则必须由显隐开关直接保证，掩膜不背这个锅。
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  contentVisible(camera) {
    throw new Error('WorldShape.contentVisible 未实现');
  }

  /**
   * 形状自管的逻辑体拾取：射线打「没有地形位移的理想体」，返回落点经纬度。
   * 球打逻辑球，平板打理想顶面并检查落在板面范围内。main.js 不关心是哪种。
   * @returns {{ lat:number, lng:number, point: THREE.Vector3 }|null}
   */
  // eslint-disable-next-line no-unused-vars
  raycastSurface(raycaster, logicalMesh) {
    throw new Error('WorldShape.raycastSurface 未实现');
  }

  /**
   * 出厂位姿（初始载入 / 形状落位 / 视角复位的落点）。
   * 球体 = 设置里的经纬度；平板 = 板面中心——切换到平板时板心位于画面中心。
   * @param {{ lat:number, lon:number }} config config.camera（也容忍整个 viewConfig）
   * @returns {{ position: THREE.Vector3, target: THREE.Vector3 }}
   */
  getHomePose(config, distance) {
    const cam = config.camera ?? config;
    return this.getCameraPose(cam.lat, cam.lon, { distance });
  }

  // ---------------------------------------------------------- 渲染工厂

  /** 主体几何（宽度段数已按设置封顶）；位移 shader 由 patchBodyMaterial 配套 */
  // eslint-disable-next-line no-unused-vars
  buildBodyGeometry(segW) {
    throw new Error('WorldShape.buildBodyGeometry 未实现');
  }

  /**
   * 主体之外的静态附属网格（平板的侧壁/底面岩层），不参与位移。
   * 球体没有，基类默认返回空。Globe 负责把返回的网格加进 group，
   * 换形状时摘除并释放（几何与材质一起 dispose）。
   * @returns {THREE.Object3D[]}
   */
  buildStaticMeshes() {
    return [];
  }

  /**
   * 栅格变化后刷新形状的静态附属（平板：侧壁断面纹理重绑定）。
   * 在 Globe.setRaster 末尾调用；base 无操作。只换纹理内容，不重建几何。
   * @param {object} grid TerrainGrid
   * @param {THREE.Texture} map 顶面正在使用的颜色纹理（侧壁直接共享它，接缝由构造保证）
   */
  // eslint-disable-next-line no-unused-vars
  updateFrame(grid, map) {}

  /**
   * 给主体材质注入位移/法线 shader。uniforms 里的三个共享量由 Globe 持有
   * （换地图只换 value，不换引用），形状不得自建副本。
   * 换形状时材质会被复用并置 needsUpdate——着色器分支变了，重编译是应得的。
   */
  // eslint-disable-next-line no-unused-vars
  patchBodyMaterial(mat, { uniforms }) {
    throw new Error('WorldShape.patchBodyMaterial 未实现');
  }

  /** 贴图环绕设置：球横向 Repeat（首尾经线同一条），平板 Clamp（边缘即断面） */
  // eslint-disable-next-line no-unused-vars
  applyTextureWrapping(colorTex, heightTex) {
    throw new Error('WorldShape.applyTextureWrapping 未实现');
  }

  /**
   * 深度掩膜：只写深度的「理想体」，只承担一件事——地形不挡内容
   * （球：过球心平面；平板：压在最低内容之下的水平面）。「世界背面不露内容」
   * 由 contentVisible 负责，掩膜不负责挡相机两侧的内容。
   * @returns {THREE.Mesh} 已设好 LAYER_MASK 与 material
   */
  buildMaskMesh() {
    throw new Error('WorldShape.buildMaskMesh 未实现');
  }

  /** 每帧按相机重摆掩膜（球：正对相机 + 按距离放大；平板：锁死水平面） */
  // eslint-disable-next-line no-unused-vars
  updateMask(mask, camera) {}

  /** 形状专属的氛围效果（球=外圈辉光+薄雾，平板=板底边缘光晕）；hasAtmosphere=false 的形状不实现 */
  // eslint-disable-next-line no-unused-vars
  buildAtmosphere(group, config) {}

  /** 画面设置变化时刷新大气参数；无大气的形状空实现 */
  // eslint-disable-next-line no-unused-vars
  applyAtmosphereConfig(config) {}

  /** 换形状时退场大气（从 group 摘除并释放）；无大气的形状空实现 */
  // eslint-disable-next-line no-unused-vars
  disposeAtmosphere(group) {}
}
