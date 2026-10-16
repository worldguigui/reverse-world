import * as THREE from 'three';
import { latLngToVec3 } from '../utils.js';
import { LAYER_CONTENT } from './render-layers.js';

/** 光点浮在球面之上的半径：贴着地表，又要离开深度掩膜球一点，否则会与它打架 */
const SURFACE_R = 1.003;

/**
 * 事件光点层：整层只有一个点，跟着当前选中的那条事件走，没选中就不存在。
 *
 * 球上不给事件铺满点：铺满时它们互相压住，也让人以为「点上去能选中」——
 * 而事件的入口本来就只有时间轴刻度与编年史长卷两处。球上只负责把选中那条的位置点亮。
 * 光点用 Sprite：贴地的点在球缘会侧成一条线，而「此刻在这里」的提示任何时候都该看得见。
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
    if (!at) { this.sprite.visible = false; return; }
    const lift = this.terrainRadius?.(at.lat, at.lng) ?? 0;
    this.sprite.position.copy(latLngToVec3(at.lat, at.lng, SURFACE_R + lift));
    this.sprite.visible = true;
  }

  /** 事件不在球上拾取：光点是「选中」的结果，不是选中的入口 */
  pick() { return null; }

  /** 光点按屏幕像素保持固定大小，拉远拉近一样醒目 */
  update(camera) {
    if (!this.sprite.visible) return;
    const pxPerWorld = this.viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const d = camera.position.distanceTo(this.sprite.position);
    const s = (this.getConfig().markers.dotPx / pxPerWorld) * d;
    this.sprite.scale.set(s, s, 1);
  }
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
