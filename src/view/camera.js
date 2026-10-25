import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { latLngToVec3, vec3ToLatLng } from '../utils.js';

/** 世界坐标系的「正北」：自转轴，也是复位视角时掰回去的方向 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * 滚轮一格要让画面「看起来」放大多少倍。1.10 = 每格大一成。
 *
 * 步长不按相机距离定：眼睛看到的地面大小是 1/(相机距离-1)，
 * 距离每乘一次固定倍率，越贴近球面分母掉得越狠，同一格放大得越多。
 * 按看得见的大小等比例推进，全程才匀速。
 */
const ZOOM_STEP = 1.10;

/**
 * 相机推到最近档之后，镜头还能再收窄多少倍视场角。8 = 再放大八倍（45° → 5.625°）。
 *
 * 相机只能推到一定高度——再近就要进到球里了。但「推镜头」和「放大」本来就是两件事：
 * 相机停住之后改收窄视场角，画面照样继续放大，直到这个上限。
 * 再往上画面就是纯放大像素了，这个数只是给个够用的范围，改大改小都行。
 */
const OPTICAL_MAX = 8;

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
   * @param {import('./utils.js').TweenManager} tweens
   */
  constructor(camera, domElement, config, tweens) {
    this.camera = camera;
    this.config = config;
    this.tweens = tweens;
    this.domElement = domElement;
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
    this.controls.minDistance = config.minDistance;
    this.controls.maxDistance = config.maxDistance;
    // 自转不交给 OrbitControls 的 autoRotate：它绕的是相机自己的 up 轴，
    // 而我们允许把相机翻到任意朝向，那样「自转」会变成绕屏幕竖线打转。见 update()。
  }

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
    if (dx || dy) this.orbit(dx, dy);
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
   * 拖拽速度的缩放系数：画面里能装下多少地表，就乘多少。
   *
   * 一屏装下的地表正比于 (相机距离 - 1) × tan(视场角 / 2)——前者是镜头离地表多远，
   * 后者是画面的张角。放大之后这个乘积变小，同样转那么多角度，地表在屏幕上就得多走几像素；
   * 乘上它正好抵消，于是每拖一像素地表都走同样远的路，拉到最近和最远手感一致。
   * 出厂视角下这个系数是 1，手感和不加它时一模一样。
   */
  _dragScale() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const tanHalf = (fov) => Math.tan((fov * Math.PI) / 360);
    const ref = (this.config.distance - 1) * tanHalf(this.config.fov);
    return (Math.max(0, d - 1) * tanHalf(this.camera.fov)) / ref;
  }

  /**
   * 复位视角：把「上」掰回正北，再飞回设置里的初始经纬度。
   * 自由翻滚能把地平线转歪，这是唯一的回家路径。
   */
  resetView() {
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.controls.target);
    this._setOptical(1); // 复位就是把镜头也拧回出厂视角，不能留着上一段的放大倍率
    this.flyToLatLng(this.config.lat, this.config.lon, { distance: this.config.distance });
  }

  // ---------------------------------------------------------------- 缩放档位

  /**
   * 当前档位：相对出厂视角（相机距离 config.distance、视场角 config.fov）在屏幕上看到的大小。
   * 推近相机与收窄视场角都会放大画面，两者合成这一个数，滚轮只跟它打交道。
   */
  _level() {
    const d = this.camera.position.distanceTo(this.controls.target);
    if (!(d > 1)) return 1; // 相机不该进到球面以内；真发生了也别算出负档位
    return ((this.config.distance - 1) / (d - 1)) * this._optical;
  }

  /**
   * 档位落成相机的实际状态，分两段：
   *  - 推到底之前：只动相机，视场角保持出厂值；
   *  - 推到底之后：相机停住，剩下的倍数全交给视场角——「视角降到一定高度就只放大」。
   * 分界由 config.minDistance 定，dollyMax 就是相机推到底能到几倍。
   */
  _levelToState(level) {
    const refD = this.config.distance;
    const dollyMin = (refD - 1) / (this.config.maxDistance - 1); // 拉到最远档
    const dollyMax = (refD - 1) / (this.config.minDistance - 1); // 推到最近档
    const L = THREE.MathUtils.clamp(level, dollyMin, dollyMax * OPTICAL_MAX);
    if (L <= dollyMax) return { level: L, distance: 1 + (refD - 1) / L, optical: 1 };
    return { level: L, distance: this.config.minDistance, optical: L / dollyMax };
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

  /** 沿当前视线把相机摆到离球心 d 处：只改远近，朝向与「上」都不动 */
  _setDistance(d) {
    const v = this.camera.position;
    const len = v.length();
    if (len > 1e-6) v.multiplyScalar(d / len);
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
    // 飞行期间先让位：两个动画同时改位置会互相抵消；飞完自动恢复，用户的自转开关不动。
    if (this.config.enabled && dt > 0 && !this.tweens.has('camera')) {
      _qSpin.setFromAxisAngle(WORLD_UP, this.config.speed * (Math.PI / 180) * dt);
      this.camera.position.applyQuaternion(_qSpin);
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
    const { lat, lng } = vec3ToLatLng(this.camera.position);
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
    const fromDir = c.position.clone().normalize();
    const fromDist = c.position.length();
    const fromLevel = this._level();
    const toDir = latLngToVec3(lat, lng, 1).normalize();
    const toState = level != null ? this._levelToState(level) : null;
    const toDist = toState
      ? toState.distance
      : THREE.MathUtils.clamp(distance ?? fromDist, this.controls.minDistance, this.controls.maxDistance);
    // 档位不同的两处，距离可能一样（都在最近档上），所以要连档位一起比
    const settled = fromDir.distanceTo(toDir) < 1e-6
      && Math.abs(fromDist - toDist) < 1e-6
      && (!toState || Math.abs(fromLevel - toState.level) < 1e-6);
    if (settled) return;

    const qIdentity = new THREE.Quaternion();
    const qTarget = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
    const qK = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    this.tweens.add({
      tag: 'camera',
      duration,
      onUpdate: (k) => {
        qK.slerpQuaternions(qIdentity, qTarget, k);
        pos.copy(fromDir).applyQuaternion(qK).multiplyScalar(THREE.MathUtils.lerp(fromDist, toDist, k));
        c.position.copy(pos);
        // 摆好位置后再按当前档位落定距离与视场角（上面那个距离的插值会被它盖掉）。
        // 档位是乘法量：一路等比插过去，从哪一档起飞都是同样的收拢速度
        if (toState) this._applyLevel(fromLevel * Math.pow(toState.level / fromLevel, k));
      },
    });
  }
}
