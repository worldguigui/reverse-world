import * as THREE from 'three';
import { latLngToVec3 } from '../utils.js';
import { LAYER_CONTENT } from './render-layers.js';
import { createMaterialBin } from './material-bin.js';

const MARKER_R = 1.012; // 标注悬浮在球面之上

/**
 * 条目标注层：每个条目一个 Sprite。
 * 有图 = 圆形缩略图 + 色环；无图 = 发光色点。
 * Sprite 开 depthTest，但对着的是「不含地形起伏」的深度掩膜（见 render-layers.js）：
 * 山挡不住它，转到球背面还是会被挡住。
 */
export class MarkerLayer {
  /**
   * @param {THREE.Object3D} parent
   * @param {() => object} getConfig 返回画面设置（config.markers.size）
   */
  constructor(parent, getConfig) {
    this.parent = parent;
    this.getConfig = getConfig;
    this.group = new THREE.Group();
    this.group.name = 'markers';
    parent.add(this.group);
    /** @type {Map<string, THREE.Sprite>} */
    this.byId = new Map();
    this.hoverId = null;
    this.selectedId = null;
    /** 可选：(lat, lng) => 半径抬升量，让标注站在山上 */
    this.terrainRadius = null;
    // 材质在整层重建之间复用，贴图每次都换——理由见 material-bin.js
    this._bin = createMaterialBin(32, () => new THREE.SpriteMaterial({ transparent: true, depthTest: true }));
  }

  /** 重建全部标注（切面切换或数据变更后调用） */
  refresh(entries) {
    for (const sprite of this.byId.values()) {
      const mat = sprite.material;
      mat.map?.dispose(); // 标注贴图每条一份，旧的那张随手丢掉
      mat.map = null;
      this._bin.put(mat);
      this.group.remove(sprite);
    }
    this.byId.clear();
    for (const entry of entries) {
      const mat = this._bin.take();
      mat.map = makeMarkerTexture(entry);
      const sprite = new THREE.Sprite(mat);
      sprite.userData.itemId = entry.id;
      sprite.userData.lat = entry.lat;
      sprite.userData.lng = entry.lng;
      this.byId.set(entry.id, sprite);
      this._add(sprite);
    }
    this.relayout();
    this._applyScales();
  }

  /**
   * 只有地形变了（切面切换、画笔涂抹）：把已有标注重新贴回地表。
   * 一张 256×256 的贴图建一次要几毫秒，50 个条目就是几十毫秒——
   * 画笔每移动一下都重建一遍是之前卡顿的主因，重定位则只是几十次向量乘法。
   */
  relayout() {
    for (const sprite of this.byId.values()) {
      const { lat, lng } = sprite.userData;
      const lift = this.terrainRadius?.(lat, lng) ?? 0;
      sprite.position.copy(latLngToVec3(lat, lng, MARKER_R + lift));
    }
  }

  _add(sprite) {
    sprite.layers.set(LAYER_CONTENT); // 单独一趟渲染，见 render-layers.js
    this.group.add(sprite);
  }

  _applyScales() {
    const size = this.getConfig().markers.size;
    for (const [id, sprite] of this.byId) {
      const k = id === this.selectedId ? 1.5 : id === this.hoverId ? 1.28 : 1;
      sprite.scale.set(size * k, size * k, 1);
    }
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this._applyScales();
  }

  setSelected(id) {
    this.selectedId = id;
    this._applyScales();
  }

  /** 射线拾取，返回命中的条目 id 或 null。背面（被球体遮挡）的标注不参与 */
  pick(raycaster, camera) {
    const hits = raycaster.intersectObjects([...this.byId.values()], false);
    if (!hits.length) return null;
    // 地平线余弦：相机距离 d 时，可见半球上的标注满足 dot(标注方向, 相机方向) > 1/d
    const limit = 1 / camera.position.length() + 0.02;
    const camDir = camera.position.clone().normalize();
    for (const hit of hits) {
      if (hit.object.position.clone().normalize().dot(camDir) > limit) {
        return hit.object.userData.itemId;
      }
    }
    return null;
  }
}

/** canvas 画标注贴图：有图 = 圆形缩略图 + 色环；无图 = 发光点 */
function makeMarkerTexture(entry) {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const color = entry.color || '#ffb545';

  if (entry.image) {
    return textureFromImage(entry.image, (img) => {
      // 圆形裁剪的封面式缩略图
      ctx.save();
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S / 2 - 14, 0, Math.PI * 2);
      ctx.clip();
      const k = Math.max((S - 28) / img.width, (S - 28) / img.height);
      const dw = img.width * k, dh = img.height * k;
      ctx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
      ctx.restore();
      ctx.strokeStyle = color;
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  // 发光色点
  const glow = ctx.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, S / 2);
  glow.addColorStop(0, color);
  glow.addColorStop(0.35, color + '88');
  glow.addColorStop(1, color + '00');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, 46, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 先把 dataURL 图片 load 出来，画完回调后更新纹理 */
function textureFromImage(dataUrl, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const img = new Image();
  img.onload = () => {
    draw(img);
    tex.needsUpdate = true;
  };
  img.src = dataUrl;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
