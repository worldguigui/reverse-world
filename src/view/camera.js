import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { latLngToVec3, vec3ToLatLng } from '../utils.js';

/** 世界坐标系的「正北」：自转轴，也是复位视角时掰回去的方向 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
 * 缩放仍归 OrbitControls：它算的是「相机到球心的距离」，与相机朝向无关，
 * 与上面的旋转互不干涉；它的钳制、滚轮与双指手势也就照旧可用。
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

    const controls = new OrbitControls(camera, domElement);
    this.controls = controls;
    controls.enableDamping = true; // 惯性阻尼，缩放手感更顺
    controls.dampingFactor = 0.08;
    controls.enablePan = false;    // 平移会让地球偏离视野中心，禁用
    controls.enableRotate = false; // 旋转交给下面的 orbit()
    controls.autoRotate = false;   // 自转同理，见 update()
    controls.minDistance = config.minDistance;
    controls.maxDistance = config.maxDistance;

    // 用户一上手（拖拽/滚轮），立刻打断进行中的 flyTo 动画
    domElement.addEventListener('pointerdown', () => tweens.cancel('camera'));
    domElement.addEventListener('wheel', () => tweens.cancel('camera'), { passive: true });

    domElement.addEventListener('pointerdown', this._onDown);
    domElement.addEventListener('pointermove', this._onMove);
    domElement.addEventListener('pointerup', this._onUp);
    domElement.addEventListener('pointercancel', this._onUp);

    this.setConfig(config);
  }

  setConfig(config = this.config) {
    this.config = config;
    this.camera.fov = config.fov;
    this.camera.updateProjectionMatrix();
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
   * 速度沿用 OrbitControls 的约定：拖过一个视口高度 = 转一整圈。
   */
  orbit(dx, dy) {
    const k = (2 * Math.PI) / Math.max(1, this.domElement.clientHeight);
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
   * 复位视角：把「上」掰回正北，再飞回设置里的初始经纬度。
   * 自由翻滚能把地平线转歪，这是唯一的回家路径。
   */
  resetView() {
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.controls.target);
    this.flyToLatLng(this.config.lat, this.config.lon, { distance: this.config.distance });
  }

  /**
   * @param {number} [dt] 距上一帧的秒数，用于自转
   */
  update(dt = 0) {
    // 自转绕世界 Y 轴（南北极），不是相机自己的上方向——
    // 翻过球之后两者会不一致，用相机 up 当轴会变成绕屏幕竖线打转
    if (this.config.enabled && dt > 0) {
      _qSpin.setFromAxisAngle(WORLD_UP, this.config.speed * (Math.PI / 180) * dt);
      this.camera.position.applyQuaternion(_qSpin);
      this.camera.up.applyQuaternion(_qSpin);
    }
    this.controls.update();
  }

  /** 当前视角对应的经纬度和距离 */
  getLatLngZoom() {
    const { lat, lng } = vec3ToLatLng(this.camera.position);
    return { lat, lng, distance: this.camera.position.length() };
  }

  /**
   * 飞到指定经纬度：相机方向沿球面大圆插值，距离同时渐变。
   * 只动位置、不动 camera.up——用户自己转出来的朝向由他自己复位。
   * @param {number} lat
   * @param {number} lng
   * @param {{ distance?: number, duration?: number }} opts
   */
  flyToLatLng(lat, lng, { distance = null, duration = 1400 } = {}) {
    this.onFlyStart?.(); // 飞行前通知外部（默认用来暂停自动旋转，否则飞到了又转走）
    const c = this.camera;
    const fromDir = c.position.clone().normalize();
    const fromDist = c.position.length();
    const toDir = latLngToVec3(lat, lng, 1).normalize();
    const toDist = THREE.MathUtils.clamp(distance ?? fromDist, this.controls.minDistance, this.controls.maxDistance);
    if (fromDir.distanceTo(toDir) < 1e-6 && Math.abs(fromDist - toDist) < 1e-6) return;

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
      },
    });
  }
}
