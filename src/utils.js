import * as THREE from 'three';

/**
 * 经纬度 → 球面三维坐标。
 * 该公式与 three.js SphereGeometry 的 UV 展开方式一致，
 * 保证等距圆柱投影地图贴上球后经纬度能对准。
 * @param {number} lat 纬度 [-90, 90]
 * @param {number} lng 经度 [-180, 180]
 * @param {number} r  半径
 */
export function latLngToVec3(lat, lng, r = 1, target = new THREE.Vector3()) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lng + 180) * Math.PI) / 180;
  return target.set(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

/** 球面三维坐标 → 经纬度（latLngToVec3 的逆运算） */
export function vec3ToLatLng(v) {
  const r = v.length();
  const lat = 90 - (Math.acos(THREE.MathUtils.clamp(v.y / r, -1, 1)) * 180) / Math.PI;
  let lng = (Math.atan2(v.z, -v.x) * 180) / Math.PI - 180;
  if (lng <= -180) lng += 360;
  if (lng > 180) lng -= 360;
  return { lat, lng };
}

/**
 * 大圆弧插值：两个球面单位方向之间按球面距离取中间点。
 * 用于路线绘制——相邻经纬点之间走「大圆」而不是直线。
 */
export function slerpLatLng(lat1, lng1, lat2, lng2, t, r = 1, target = new THREE.Vector3()) {
  const a = latLngToVec3(lat1, lng1, 1).normalize();
  const b = latLngToVec3(lat2, lng2, 1).normalize();
  const angle = a.angleTo(b);
  if (angle < 1e-6) return latLngToVec3(lat2, lng2, r, target);
  const sa = Math.sin((1 - t) * angle) / Math.sin(angle);
  const sb = Math.sin(t * angle) / Math.sin(angle);
  return target.set(
    sa * a.x + sb * b.x,
    sa * a.y + sb * b.y,
    sa * a.z + sb * b.z,
  ).normalize().multiplyScalar(r);
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * 极简补间动画管理器：flyTo 等动画都挂在这里，
 * 同一 tag 的新动画会顶掉旧动画；用户一上手就取消。
 *
 * 回调里可以再开动画（回放推游标，游标一走就飞向刚登场的事件）。因此 update() 不能
 * 就地过滤自己的数组：那样算完一圈会把回调期间新加的动画一起写掉，新加的这次飞行
 * 就凭空消失了。这里改成先把待办挪出来、算完再收回，并用 dead 标记流传中的取消。
 */
export class TweenManager {
  #tweens = [];

  add({ tag = null, duration = 1000, ease = easeInOutCubic, onUpdate, onComplete }) {
    if (tag) this.cancel(tag);
    this.#tweens.push({ tag, duration, ease, onUpdate, onComplete, start: performance.now(), dead: false });
  }

  /** 指定 tag 是否还有动画在跑（飞行期间据此暂停自动旋转） */
  has(tag) {
    return this.#tweens.some((t) => t.tag === tag && !t.dead);
  }

  cancel(tag) {
    // 打标记而不是只删数组里的：此刻可能有一批动画正被 update() 拿在手上，
    // 不标记的话它们会在这一圈结束时被放回去，取消就白取消了
    for (const t of this.#tweens) if (t.tag === tag) t.dead = true;
    this.#tweens = this.#tweens.filter((t) => !t.dead);
  }

  update(now = performance.now()) {
    const pending = this.#tweens;
    this.#tweens = [];
    for (const t of pending) {
      if (t.dead) continue;
      const k = Math.min(1, (now - t.start) / t.duration);
      t.onUpdate(t.ease(k), k);
      if (t.dead) continue; // 回调里把自己取消了
      if (k < 1) this.#tweens.push(t);
      else t.onComplete?.();
    }
  }
}
