import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OPTICAL_MAX, zoomLevelRange } from '../config.js';
import { SphereShape } from './shapes/sphere-shape.js';

/** 没人注入形状时的兜底：世界默认是球体 */
const FALLBACK_SHAPE = new SphereShape();

/** 世界坐标系的「正北」：自转轴，也是复位视角时掰回去的方向 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** 平面相机（平板）的「屏幕上方向」：正俯视时屏幕上边朝着世界北（−z） */
const PLANAR_UP = new THREE.Vector3(0, 0, -1);

/**
 * 滚轮一格要让画面「看起来」放大多少倍。1.10 = 每格大一成。
 *
 * 步长不按相机距离定：眼睛看到的地面大小是 1/(净距)，
 * 净距每乘一次固定倍率，越贴近表面分母掉得越狠，同一格放大得越多。
 * 按看得见的大小等比例推进，全程才匀速。
 */
const ZOOM_STEP = 1.10;

/** 档位变化小于这个量就不往外报，避免飞行/阻尼时每帧都写一遍外部状态 */
const LEVEL_EPS = 1e-4;

// 拖拽/自转每帧都会跑到，这几个量复用，免得一分钟里堆出几千个临时对象
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _qSpin = new THREE.Quaternion();
const _qSide = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();

/**
 * 轨道相机封装：自由翻滚（四元数）+ 滚轮缩放（OrbitControls）+ flyTo 球面飞行。
 * 地球本身固定不动，「自转」通过相机自动环绕实现，
 * 这样区域拾取、双击定位、flyTo 的坐标永远是自洽的。
 *
 * 旋转为什么不用 OrbitControls 自带的：
 *   它把相机位置表示成「绕 target 的球坐标 (theta, phi)」，phi 被夹在 0~π——
 *   南北极各占一端，拖到极点就顶死了，只能往回拖，这就是「翻不到球的另一面」。
 *   球坐标本身表达不了「越过极点继续转」，换多少参数都救不回来。
 *   这里改成四元数直接转相机：横拖绕相机自己的 up 轴、纵拖绕 right 轴，
 *   位置与 camera.up 一起转，于是任何方向都能连续转下去，没有死角。
 *   代价是可以把地平线转歪（自由翻滚的本来面目），所以配了 resetView()。
 *
 * 缩放：OrbitControls 仍持有「相机到球心的距离」（与相机朝向无关，和上面的旋转互不干涉，
 * 双指捏合也照旧走它），但**滚轮由本类接管**——滚轮要的不只是推拉相机，
 * 推到最近档之后还得靠收窄视场角接着放大，光靠 dolly 做不到。见 _applyLevel。
 * 距离与视场角合成同一个「档位」，滚轮一律按档位走，于是带镜头的放大也是匀速的。
 */
export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement 事件挂载元素（renderer.domElement）
   * @param {object} config config.camera + config.rotation（保持引用）
   * @param {import('../utils.js').TweenManager} tweens
   * @param {() => import('./shapes/world-shape.js').WorldShape} [getShape] 当前世界形状；
   *   推近/放大/拖拽的「离表面多近」由 shape.referenceScale 推导，flyTo 的落点方向
   *   由 shape 提供——相机代码本身对球体还是平板一无所知
   */
  constructor(camera, domElement, config, tweens, getShape = null) {
    this.camera = camera;
    this.config = config;
    this.tweens = tweens;
    this.domElement = domElement;
    this.getShape = getShape ?? (() => FALLBACK_SHAPE);
    this._drag = null; // 正在拖拽时记 { x, y }：上一个指针位置
    this._optical = 1; // 镜头的额外倍率，1 = 出厂视角的视场角；相机推到底之后由它接着放大

    // 滚轮必须先于 OrbitControls 注册：两边都挂在同一个元素上、都在冒泡阶段，
    // 先注册的先跑，_onWheel 里才能用 stopImmediatePropagation 把它那个滚轮处理拦下来。
    // 不拦的话它会同时推拉相机，和这里的档位打架。
    domElement.addEventListener('wheel', this._onWheel, { passive: false });

    const controls = new OrbitControls(camera, domElement);
    this.controls = controls;
    controls.enableDamping = true; // 惯性阻尼，缩放手感更顺
    controls.dampingFactor = 0.08;
    controls.enablePan = false;    // 平移会让地球偏离视野中心，禁用
    controls.enableRotate = false; // 旋转交给下面的 orbit()
    controls.autoRotate = false;   // 自转同理，见 update()
    controls.minDistance = config.minDistance;
    controls.maxDistance = config.maxDistance;

    // 用户一上手（拖拽），立刻打断进行中的 flyTo 动画，并通知外部
    // （自动跟拍据此让位：镜头归用户）。滚轮那一路在 _onWheel 里自己打断，
    // 因为 _onWheel 会拦下同一元素上的后续监听，这里再挂一个也收不到。
    domElement.addEventListener('pointerdown', () => {
      tweens.cancel('camera');
      this.onUserInterrupt?.();
    });

    domElement.addEventListener('pointerdown', this._onDown);
    domElement.addEventListener('pointermove', this._onMove);
    domElement.addEventListener('pointerup', this._onUp);
    domElement.addEventListener('pointercancel', this._onUp);

    this.setConfig(config);
    // 外部（设置面板）用 onLevelChange 拿到当前档位；初始值在这里对齐，不触发回调
    this._lastLevel = this._level();
  }

  setConfig(config = this.config) {
    this.config = config;
    // 设置面板改的是基础视场角，当前档位下的镜头倍率要一起算进去，否则一改设置画面就跳
    this._setOptical(this._optical);
    // OrbitControls（双指捏合）的距离界限随形状换算：config 里的 1.25/8 是净距界限
    // （球面以上 0.25~7），球体加参考面 1，平板 target 就在表面、不用加
    this.controls.minDistance = this._boundMin();
    this.controls.maxDistance = this._boundMax();
    // 自转不交给 OrbitControls 的 autoRotate：它绕的是相机自己的 up 轴，
    // 而我们允许把相机翻到任意朝向，那样「自转」会变成绕屏幕竖线打转。见 update()。
  }

  // ------------------------------------------------- 距离换算（形状无关的梯子）

  /** 出厂净距：config.distance 的语义是「球体出厂时到球心的距离」，减去球半径即净距 2 */
  _factoryClearance() { return this.config.distance - 1; }

  /** 出厂时到 target 的距离 = 出厂净距 + 参考面（球 2+1=3，平板 2+0=2） */
  _factoryDistance() { return this._factoryClearance() + this.getShape().referenceScale; }

  /** 距离界限（到 target）：净距界限 [0.25, 7] + 参考面 */
  _boundMin() { return this.config.minDistance - 1 + this.getShape().referenceScale; }

  _boundMax() { return this.config.maxDistance - 1 + this.getShape().referenceScale; }

  // ---------------------------------------------------------------- 自由翻滚

  /** 左键（触摸也是 0 号）按下开始转；其余按键交给 OrbitControls */
  _onDown = (e) => {
    if (e.button !== 0) return;
    this._drag = { x: e.clientX, y: e.clientY };
  };

  _onMove = (e) => {
    const d = this._drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!dx && !dy) return;
    if (this.getShape().planarCamera) this.pan(dx, dy);
    else this.orbit(dx, dy);
  };

  _onUp = () => { this._drag = null; };

  /**
   * 屏幕像素增量 → 绕相机本地轴的旋转。
   * 横拖绕相机自己的 up 轴、纵拖绕 right 轴，合成为一个四元数；
   * 位置与 camera.up 一起转，「上」始终跟着画面走，不会出现万向节死锁。
   *
   * 速度按「地表在屏幕上走过的像素数」定，不按转过的角度定，见 _dragScale：
   * 拖一像素地表就走固定几像素，放大多少倍手感都一样。
   */
  orbit(dx, dy) {
    const k = (2 * Math.PI) / Math.max(1, this.domElement.clientHeight) * this._dragScale();
    const q = this.camera.quaternion;
    _right.set(1, 0, 0).applyQuaternion(q); // 相机本地 X 轴在世界里的方向
    _up.set(0, 1, 0).applyQuaternion(q);
    _qSide.setFromAxisAngle(_up, -dx * k);
    _qTilt.setFromAxisAngle(_right, -dy * k);
    _qSide.multiply(_qTilt);

    this.camera.position.applyQuaternion(_qSide);
    this.camera.up.applyQuaternion(_qSide).normalize();
    this.camera.lookAt(this.controls.target);
  }

  /**
   * 平面相机（平板）的拖动：不是旋转，是「抓着地图拖」——
   * 内容跟着手走，视点中心往反方向滑。速度按「这一屏装得下多少地面」定：
   * 一像素 = 净高 × tan(半FOV) × 2 / 视口高，缩放多少倍手感都一致。
   * 相机保持正俯视锁死，只在 target 上方跟着平移。
   */
  pan(dx, dy) {
    const t = this.controls.target;
    const c = this.camera;
    const h = c.position.distanceTo(t);
    const wpp = (2 * h * Math.tan((c.fov * Math.PI) / 360)) / this.domElement.clientHeight;
    t.x -= dx * wpp;
    t.z -= dy * wpp;
    this.getShape().clampCameraTarget(t);
    c.position.x = t.x;
    c.position.z = t.z;
  }

  /**
   * 拖拽速度的缩放系数：画面里能装下多少地表，就乘多少。
   *
   * 一屏装下的地表正比于 (相机距离 - 1) × tan(视场角 / 2)——前者是镜头离地表多远，
   * 后者是画面的张角。放大之后这个乘积变小，同样转那么多角度，地表在屏幕上就得多走几像素；
   * 乘上它正好抵消，于是每拖一像素地表都走同样远的路，拉到最近和最远手感一致。
   * 出厂视角下这个系数是 1，手感和不加它时一模一样。
   */
  _dragScale() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const refScale = this.getShape().referenceScale;
    const tanHalf = (fov) => Math.tan((fov * Math.PI) / 360);
    // 参考量与档位同源：出厂净距。放大多少倍，同样的拖动距离就走同样多的地面
    const ref = this._factoryClearance() * tanHalf(this.config.fov);
    return (Math.max(0, d - refScale) * tanHalf(this.camera.fov)) / ref;
  }

  /**
   * 复位视角：把「上」掰回正北，再飞回设置里的初始经纬度。
   * 自由翻滚能把地平线转歪，这是唯一的回家路径；平面相机本来就是锁死的，
   * 掰的是「屏幕上边朝北」这根方向。
   */
  resetView() {
    this.camera.up.copy(this.getShape().planarCamera ? PLANAR_UP : WORLD_UP);
    this.camera.lookAt(this.controls.target);
    this._setOptical(1); // 复位就是把镜头也拧回出厂视角，不能留着上一段的放大倍率
    this.flyToLatLng(this.config.lat, this.config.lon, { distance: this._factoryDistance() });
  }

  /**
   * 形状切换后的落位：硬切到新形状的出厂位姿（舞台切换的一部分，与换地图同性质）。
   * 不做动画——上一形状的相机语义（弧线/平移、朝向、target 位置）对新形状毫无意义，
   * 球→板的瞬间就该是「一睁眼已是正俯视」，拖着旧视角滑过去反而怪。
   * 启动恢复平板世界时也走这里：不落位的话相机会一直停在球体出厂位姿上，
   * 档位读数、滚轮、滑块全都在错误的基准上打转。
   */
  reseat(shape) {
    const pose = shape.getCameraPose(this.config.lat, this.config.lon, { distance: this._factoryDistance() });
    this.camera.up.copy(shape.planarCamera ? PLANAR_UP : WORLD_UP);
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.camera.lookAt(pose.target);
    this._setOptical(1); // 镜头倍率也回出厂，别把上一形状的放大倍率带过来
    // 距离界限必须随形状刷新：controls.update() 每帧把相机半径夹回 [min,max]，
    // 停在球体的 1.25 会把平板推近到 0.25 的位置顶回去——滚轮放不到底、
    // 滑块拖过去又被弹回，都是这一句没跑的后果
    this.setConfig(this.config);
    this._syncLevel();
  }

  // ---------------------------------------------------------------- 缩放档位

  /**
   * 当前档位：相对出厂视角（出厂净距、视场角 config.fov）在屏幕上看到的大小。
   * 净距 = 到 target 的距离 − referenceScale，两种形状共用同一根梯子。
   * 档位全域由 zoomLevelRange 从 config 派生（出厂净距 2 = 档位 1），
   * 注释里不写具体档位数，免得注释与代码漂移。
   */
  _level() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const clearance = d - this.getShape().referenceScale;
    if (!(clearance > 0)) return 1; // 相机不该进到表面以内；真发生了也别算出负档位
    return (this._factoryClearance() / clearance) * this._optical;
  }

  /**
   * 档位落成相机的实际状态，分两段：
   *  - 推到最近档（dollyMax）之前：只动相机，视场角保持出厂值；
   *  - 之后：相机停住（净距到底 = _boundMin），剩下的倍数全交给视场角。
   * 距离 = referenceScale + 出厂净距 / 档位——球体逐值等于旧公式，平板同一根梯子。
   * 档位全域（含拉远超出厂的 <1 段）来自 zoomLevelRange，与设置滑块共用；
   * 两段的分界是 dollyMax（推到最近档），不是全域上限——两者混淆会让
   * 光学段失效、相机被推进表面，再被 controls 界限弹回，滑块就卡在分界档上。
   */
  _levelToState(level) {
    const refScale = this.getShape().referenceScale;
    const refC = this._factoryClearance();
    const minD = this._boundMin();
    const dollyMax = refC / (minD - refScale); // 推到最近档 = 光学段的起点
    const { min: dollyMin, max: levelMax } = zoomLevelRange(this.config);
    const L = THREE.MathUtils.clamp(level, dollyMin, levelMax);
    if (L <= dollyMax) return { level: L, distance: refScale + refC / L, optical: 1 };
    return { level: L, distance: minD, optical: L / dollyMax };
  }

  /** 把档位落定：距离与视场角一起动，滚轮与按档位飞行都走这里 */
  _applyLevel(level) {
    const { distance, optical } = this._levelToState(level);
    this._setOptical(optical);
    this._setDistance(distance);
    this._syncLevel();
  }

  /**
   * 外部直接落到某一档（设置面板的滑块）。与滚轮共用 _applyLevel，
   * 所以「拖滑块」和「滚一格」改的是同一个量，不是另一套视角参数。
   */
  setLevel(level) {
    this.tweens.cancel('camera'); // 用户开始调视角，进行中的飞行让位
    this.onUserInterrupt?.();
    this._applyLevel(level);
    return this._level();
  }

  /**
   * 把当前档位报给外部。飞行、复位、阻尼都只改相机位置，不经过 _applyLevel，
   * 所以每帧在 update() 里也查一次；超过阈值才回调，避免空闲时刷状态。
   */
  _syncLevel() {
    const level = this._level();
    if (Math.abs(level - this._lastLevel) < LEVEL_EPS) return;
    this._lastLevel = level;
    this.onLevelChange?.(level);
  }

  /** 沿当前视线把相机摆到离 target d 处：只改远近，朝向与「上」都不动。
   * 球体 target 恒为原点（与旧实现逐值一致）；平板 target 在板面上，
   * 推近/拉远就变成真正的「贴向/离开那个点」 */
  _setDistance(d) {
    const t = this.controls.target;
    const v = this.camera.position.clone().sub(t);
    const len = v.length();
    if (len > 1e-6) this.camera.position.copy(t).addScaledVector(v, d / len);
  }

  /** 落定镜头倍率：收窄视场角放大画面，相机位置不动 */
  _setOptical(o) {
    this._optical = THREE.MathUtils.clamp(o, 1, OPTICAL_MAX);
    this.camera.fov = this.config.fov / this._optical;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 滚轮：一格缩放固定比例，推近相机与收窄视场角走的是同一个档位（见 _applyLevel）。
   * 必须拦住 OrbitControls 的滚轮处理，否则它会同时推拉相机，两边打架。
   * deltaMode 的换算与 OrbitControls 取同一套（行 ×16、页 ×100），
   * 触控板那种按行报的小步长才不会缩得慢吞吞。
   */
  _onWheel = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    this.tweens.cancel('camera'); // 用户一上手，进行中的 flyTo 就让位
    this.onUserInterrupt?.();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
    this._applyLevel(this._level() * Math.pow(ZOOM_STEP, -dy / 100));
  };

  /**
   * @param {number} [dt] 距上一帧的秒数，用于自转
   */
  update(dt = 0) {
    // 自转绕世界 Y 轴（南北极），不是相机自己的上方向——
    // 翻过球之后两者会不一致，用相机 up 当轴会变成绕屏幕竖线打转。
    // 平面相机（平板）没有自转：地图不该自己转，只有你拖动它才会动。
    // 飞行期间先让位：两个动画同时改位置会互相抵消；飞完自动恢复，用户的自转开关不动。
    if (this.config.enabled && dt > 0 && !this.getShape().planarCamera && !this.tweens.has('camera')) {
      _qSpin.setFromAxisAngle(WORLD_UP, this.config.speed * (Math.PI / 180) * dt);
      this.camera.position.applyQuaternion(_qSpin);
      // target 不在原点（平板已定位到某个点）时随相机一起转：
      // 绕着世界转圈，视线与世界的相对关系保持不变
      if (this.controls.target.lengthSq() > 1e-8) this.controls.target.applyQuaternion(_qSpin);
      this.camera.up.applyQuaternion(_qSpin);
      // 星场拿同一个旋转一起转：相机画面转了，星空在屏幕上仍原样停着。
      // 手动拖动镜头不走这里，星空照常跟着视角走。
      this.onAutoSpin?.(_qSpin);
    }
    this.controls.update();
    this._syncLevel(); // 位置被飞行/复位/惯性改动时，档位也跟着变
  }

  /** 当前视角对应的经纬度、距离与档位；档位是画面实际的放大倍数，滚轮与飞行都按它走 */
  getLatLngZoom() {
    const shape = this.getShape();
    const { lat, lng } = shape.pointToLatLng(this.camera.position);
    return { lat, lng, distance: this.camera.position.length(), level: this._level() };
  }

  /**
   * 飞到指定经纬度：相机方向沿球面大圆插值，距离同时渐变。
   * 只动位置、不动 camera.up——用户自己转出来的朝向由他自己复位。
   *
   * 给了 level 就按档位飞：距离与视场角都由档位推出来（见 _levelToState），
   * 于是「点开一条事件」不只是把球转过去，画面也一起落到那个事件的尺度上，
   * 不管点之前停在哪一档，落点都是同一个。两个都给时以 level 为准。
   *
   * @param {number} lat
   * @param {number} lng
   * @param {{ distance?: number, level?: number, duration?: number }} opts
   */
  flyToLatLng(lat, lng, { distance = null, level = null, duration = 1400 } = {}) {
    const c = this.camera;
    const shape = this.getShape();
    if (shape.planarCamera) return this._flyPlanar(lat, lng, { distance, level, duration });
    const fromPos = c.position.clone();
    const fromTarget = this.controls.target.clone();
    const fromDir = fromPos.clone().normalize(); // 弧线骨架：绕原点的方向
    const fromDist = fromPos.length();
    const fromLevel = this._level();
    const toState = level != null ? this._levelToState(level) : null;
    // 落点位姿由形状给全（位置 + 视线目标点）。distance 语义 = 到 target 的距离，
    // 只给 distance 时按视野上下限夹一次（与旧行为一致）
    const rawDist = THREE.MathUtils.clamp(
      distance ?? fromPos.distanceTo(fromTarget),
      this.controls.minDistance, this.controls.maxDistance,
    );
    const toPose = shape.getCameraPose(lat, lng, { distance: toState ? toState.distance : rawDist });
    const toPos = toPose.position;
    const toTarget = toPose.target;
    const toDist = toPos.length();
    // 档位不同的两处，距离可能一样（都在最近档上），所以要连档位与 target 一起比
    const settled = fromPos.distanceTo(toPos) < 1e-6
      && fromTarget.distanceTo(toTarget) < 1e-6
      && (!toState || Math.abs(fromLevel - toState.level) < 1e-6);
    if (settled) return;

    const qIdentity = new THREE.Quaternion();
    const qTarget = new THREE.Quaternion().setFromUnitVectors(fromDir, toPos.clone().normalize());
    const qK = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    this.tweens.add({
      tag: 'camera',
      duration,
      onUpdate: (k) => {
        qK.slerpQuaternions(qIdentity, qTarget, k);
        pos.copy(fromDir).applyQuaternion(qK).multiplyScalar(THREE.MathUtils.lerp(fromDist, toDist, k));
        c.position.copy(pos);
        // 视线目标点一起过渡：球体恒为原点（零位移，与旧行为逐值一致），
        // 平板从原点滑到目标点——落地时相机真正朝向那个位置
        this.controls.target.lerpVectors(fromTarget, toTarget, k);
        // 摆好位置后再按当前档位落定距离与视场角（上面那个距离的插值会被它盖掉）。
        // 档位是乘法量：一路等比插过去，从哪一档起飞都是同样的收拢速度
        if (toState) this._applyLevel(fromLevel * Math.pow(toState.level / fromLevel, k));
      },
    });
  }

  /**
   * 平面相机的飞行：不是弧线翻转，是平移——target 在板面上从原地滑到目的地，
   * 相机锁死在正上方、屏幕上边始终朝北，不转任何方向。高度（净距）与视场角
   * 按档位一起落定，语义与球体的「落到哪一档」完全一致。
   */
  _flyPlanar(lat, lng, { distance = null, level = null, duration = 1400 } = {}) {
    const c = this.camera;
    const shape = this.getShape();
    const from = this.controls.target.clone();
    const fromH = c.position.distanceTo(from);
    const fromLevel = this._level();
    const toState = level != null ? this._levelToState(level) : null;
    const rawDist = THREE.MathUtils.clamp(
      distance ?? fromH,
      this._boundMin(), this._boundMax(),
    );
    const toPose = shape.getCameraPose(lat, lng, { distance: toState ? toState.distance : rawDist });
    const to = toPose.target;
    const toH = toPose.position.y; // 正上方净高
    const settled = from.distanceTo(to) < 1e-6
      && Math.abs(fromH - toH) < 1e-6
      && (!toState || Math.abs(fromLevel - toState.level) < 1e-6);
    if (settled) return;

    c.up.copy(PLANAR_UP); // 兜住形状切换瞬间的任意朝向
    this.tweens.add({
      tag: 'camera',
      duration,
      onUpdate: (k) => {
        const t = this.controls.target;
        t.lerpVectors(from, to, k);
        if (toState) {
          // 相机跟着 target 走（保持正上方），高度与视场角由档位落定
          c.position.x = t.x;
          c.position.z = t.z;
          this._applyLevel(fromLevel * Math.pow(toState.level / fromLevel, k));
        } else {
          const h = THREE.MathUtils.lerp(fromH, toH, k);
          c.position.set(t.x, t.y + h, t.z);
        }
      },
    });
  }
}
