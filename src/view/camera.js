import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { latLngToVec3, vec3ToLatLng } from '../utils.js';

/**
 * 轨道相机封装：拖拽/滚轮交互（OrbitControls）+ flyTo 球面飞行。
 * 地球本身固定不动，「自转」通过相机自动环绕实现，
 * 这样区域拾取、双击定位、flyTo 的坐标永远是自洽的。
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

    const controls = new OrbitControls(camera, domElement);
    this.controls = controls;
    controls.enableDamping = true; // 惯性阻尼，拖拽手感更顺
    controls.dampingFactor = 0.08;
    controls.enablePan = false;    // 平移会让地球偏离视野中心，禁用
    controls.minDistance = config.minDistance;
    controls.maxDistance = config.maxDistance;

    // 用户一上手（拖拽/滚轮），立刻打断进行中的 flyTo 动画
    domElement.addEventListener('pointerdown', () => tweens.cancel('camera'));
    domElement.addEventListener('wheel', () => tweens.cancel('camera'), { passive: true });

    this.setConfig(config);
  }

  setConfig(config = this.config) {
    this.config = config;
    this.camera.fov = config.fov;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = config.minDistance;
    this.controls.maxDistance = config.maxDistance;
    this.controls.autoRotate = config.enabled;
    this.controls.autoRotateSpeed = config.speed / 6; // three 约定：2.0 = 30 秒转一圈 = 12°/s
  }

  update() {
    this.controls.update();
  }

  /** 当前视角对应的经纬度和距离 */
  getLatLngZoom() {
    const { lat, lng } = vec3ToLatLng(this.camera.position);
    return { lat, lng, distance: this.camera.position.length() };
  }

  /**
   * 飞到指定经纬度：相机方向沿球面大圆插值，距离同时渐变。
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
