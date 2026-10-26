import * as THREE from 'three';
import { latLngToVec3 } from '../utils.js';
import { LAYER_CONTENT } from './render-layers.js';

/** 光点在无地形时浮于球面之上的半径：基数 1 再抬起一点，落在球面外侧 */
const SURFACE_R = 1.003;

/** 射线在屏幕上的宽与高，都以光点直径为基准。拉远拉近保持同样醒目 */
const RAY_WIDTH_RATIO = 0.65;
const RAY_HEIGHT_RATIO = 3.2;

/**
 * 事件光点层：整层只有一个点，跟着当前选中的那条事件走，没选中就不存在。
 *
 * 球上不给事件铺满点：铺满时它们互相压住，也让人以为「点上去能选中」——
 * 而事件的入口本来就只有时间轴刻度与编年史长卷两处。球上只负责把选中那条的位置点亮。
 * 光点用 Sprite：贴地的点在球缘会侧成一条线，而「此刻在这里」的提示任何时候都该看得见。
 *
 * 光点上方再拖一条竖直射线。射线也做成 Sprite，并且把锚点放在底边：
 * 这样它永远在屏幕里向上延伸——跳到一条事件时镜头会正对着它，
 * 沿球面法线竖起来的真实射线在正视角下会缩成一个点，反而看不见。
 */
export class EventDotLayer {
  /**
   * @param {THREE.Object3D} parent
   * @param {() => object} getConfig 返回画面设置（config.markers.dotPx）
   */
  constructor(parent, getConfig, maxAnisotropy = 1) {
    this.parent = parent;
    this.getConfig = getConfig;
    this.group = new THREE.Group();
    this.group.name = 'event-dot';
    parent.add(this.group);
    this.viewportH = 1;
    this.terrainRadius = null;
    /** 有地点的事件 → { lat, lng }。没有坐标的事件不上球，查不到就不显示 */
    this._at = new Map();
    this._id = null;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeDotTexture(maxAnisotropy),
      transparent: true, depthTest: true, depthWrite: false, toneMapped: false,
    }));
    this.sprite.visible = false;
    this.sprite.layers.set(LAYER_CONTENT);
    this.group.add(this.sprite);
    this.ray = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeRayTexture(maxAnisotropy),
      transparent: true, depthTest: true, depthWrite: false,
      toneMapped: false, blending: THREE.AdditiveBlending,
    }));
    this.ray.center.set(0.5, 0); // 底边对齐光点，整条射线向屏幕上方长
    this.ray.visible = false;
    this.ray.layers.set(LAYER_CONTENT);
    this.ray.frustumCulled = false;
    this.group.add(this.ray);
  }

  /** 收下全部有坐标的事件；位置记下来，之后靠 setSelected 决定露不露脸 */
  build(events) {
    this._at.clear();
    for (const ev of events) this._at.set(ev.id, { lat: ev.lat, lng: ev.lng });
    this._place();
  }

  setViewport(w, h) { this.viewportH = h; }

  /** 地形变了：重新贴回地表 */
  relayout() { this._place(); }

  /**
   * 在场与否由游标说了算，但光点跟的是选中，不是游标——
   * 从长卷里点开一条事件时，光点就该在那里亮着。
   */
  setActive() {}

  /** 选中哪条就把它点亮；选中的不是事件、或那条事件没有地点，点就消失 */
  setSelected(id) {
    this._id = id;
    this._place();
  }

  _place() {
    const at = this._id != null ? this._at.get(this._id) : null;
    if (!at) {
      this.sprite.visible = false;
      this.ray.visible = false;
      return;
    }
    const lift = this.terrainRadius?.(at.lat, at.lng) ?? 0;
    const p = latLngToVec3(at.lat, at.lng, SURFACE_R + lift);
    this.sprite.position.copy(p);
    this.ray.position.copy(p);
    this.sprite.visible = true;
    this.ray.visible = true;
  }

  /** 事件不在球上拾取：光点是「选中」的结果，不是选中的入口 */
  pick() { return null; }

  /** 光点与射线按屏幕像素保持固定大小，拉远拉近一样醒目 */
  update(camera) {
    if (!this.sprite.visible) return;
    const pxPerWorld = this.viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const d = camera.position.distanceTo(this.sprite.position);
    const s = (this.getConfig().markers.dotPx / pxPerWorld) * d;
    this.sprite.scale.set(s, s, 1);
    this.ray.scale.set(s * RAY_WIDTH_RATIO, s * RAY_HEIGHT_RATIO, 1);
    // 缓慢呼吸，但幅度很小：醒目，又不至于一直在抢注意力
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 2.2);
    this.ray.material.opacity = 0.68 + pulse * 0.18;
  }
}

/** 射线贴图：底端最亮，向上渐隐；左右也渐隐，免得露出一条硬邦邦的矩形边 */
function makeRayTexture(maxAnisotropy) {
  const W = 64;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 画布 y 向下，渐变从底（H）热到顶（0）透明
  const fade = ctx.createLinearGradient(0, H, 0, 0);
  fade.addColorStop(0, 'rgba(255, 240, 190, 0.95)');
  fade.addColorStop(0.2, 'rgba(255, 214, 132, 0.72)');
  fade.addColorStop(0.62, 'rgba(226, 160, 72, 0.28)');
  fade.addColorStop(1, 'rgba(190, 120, 40, 0)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, W, H);

  // 中央一根更亮的核心，让射线在远处也有一条清楚的线
  const core = ctx.createLinearGradient(0, H, 0, 0);
  core.addColorStop(0, 'rgba(255, 250, 228, 0.95)');
  core.addColorStop(0.72, 'rgba(255, 236, 184, 0.3)');
  core.addColorStop(1, 'rgba(255, 230, 170, 0)');
  ctx.fillStyle = core;
  ctx.fillRect(W / 2 - 2, 0, 4, H);

  // 横向渐隐：中间实、两侧透明
  ctx.globalCompositeOperation = 'destination-in';
  const side = ctx.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, 'rgba(0, 0, 0, 0)');
  side.addColorStop(0.5, 'rgba(0, 0, 0, 1)');
  side.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/** 光点贴图：中间一小粒暖白，外面一圈旧铜色晕开，不用纯白描边——那太像界面控件了 */
function makeDotTexture(maxAnisotropy) {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  glow.addColorStop(0, 'rgba(255, 243, 214, 1)');
  glow.addColorStop(0.16, 'rgba(255, 226, 168, 0.92)');
  glow.addColorStop(0.42, 'rgba(217, 162, 74, 0.34)');
  glow.addColorStop(1, 'rgba(160, 110, 40, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}
