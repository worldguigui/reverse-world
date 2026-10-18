import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { latLngToVec3, slerpLatLng } from '../utils.js';
import { OVERLAY_ACTIVE, OVERLAY_BASE } from './overlay-palette.js';
import { LAYER_CONTENT } from './render-layers.js';
import { createMaterialBin } from './material-bin.js';

const ROUTE_R = 1.008;
// 普通路线压低存在感，选中时靠铜橙、加粗与满透明度拉开层级
const NORMAL_OPACITY = 0.78;
const SELECTED_EXTRA_WIDTH = 1;

/**
 * 路线层：相邻经纬点之间走大圆弧（slerp 细分），用 Line2 渲染保证像素宽度。
 * LineMaterial 的宽度按屏幕像素计算，依赖 resolution，需要在 resize 时同步。
 */
export class RouteLayer {
  /**
   * @param {THREE.Object3D} parent
   * @param {() => object} getConfig 返回画面设置（config.markers.routeWidth）
   */
  constructor(parent, getConfig) {
    this.parent = parent;
    this.getConfig = getConfig;
    this.group = new THREE.Group();
    this.group.name = 'routes';
    parent.add(this.group);
    /** @type {Map<string, { line: Line2, mat: LineMaterial }>} */
    this.byId = new Map();
    this.selectedId = null;
    this._resolution = new THREE.Vector2(1, 1);
    this._preview = null;
    /** 可选：(lat, lng) => 半径抬升量（贴地形） */
    this.terrainRadius = null;
    // 材质在整层重建之间复用，颜色/线宽每次重设——理由见 material-bin.js
    this._bin = createMaterialBin(32, () => new LineMaterial({ transparent: true }));
  }

  /** 渲染器尺寸变化时同步所有 LineMaterial */
  setSize(w, h) {
    this._resolution.set(w, h);
    for (const { mat } of this.byId.values()) mat.resolution.set(w, h);
  }

  /**
   * 重建全部路线。只有内容真的变了才调——每条都要重新 slerp 细分出一整串弧线顶点。
   * 收全部路线而不是当前游标下在场的那批，此后游标怎么走都只翻可见性。
   */
  build(routes) {
    for (const { line, mat } of this.byId.values()) {
      line.geometry.dispose();
      this._bin.put(mat); // 几何可以丢，材质留着——见 material-bin.js
      this.group.remove(line);
    }
    this.byId.clear();
    for (const route of routes) {
      const mat = this._bin.take();
      mat.resolution = this._resolution;
      const line = new Line2(new LineGeometry(), mat);
      line.userData.itemId = route.id;
      this.byId.set(route.id, { line, mat, points: route.points });
      this._add(line);
    }
    this._applyStyles();
    this.relayout();
  }

  /** 颜色、线宽与透明度都由「是否选中」决定，路线自己的 color 不再参与渲染 */
  _applyStyles() {
    const width = this.getConfig().markers.routeWidth;
    for (const [id, { mat }] of this.byId) {
      const selected = id === this.selectedId;
      mat.color.set(selected ? OVERLAY_ACTIVE : OVERLAY_BASE);
      mat.linewidth = selected ? width + SELECTED_EXTRA_WIDTH : width;
      mat.opacity = selected ? 1 : NORMAL_OPACITY;
    }
  }

  /**
   * 只有地形变了：按存下的途经点重算弧线顶点。
   * 顶点数不变时原地改写那份 buffer（setPositions 每次都新分配一个，
   * 画笔拖动时一秒几十次会不停丢掉旧的 GPU buffer）。虚线距离不重算——
   * 路线不开虚线，着色器根本不会去读它。
   */
  relayout() {
    const radiusFn = (lat, lng) => ROUTE_R + (this.terrainRadius?.(lat, lng) ?? 0);
    for (const { line, points } of this.byId.values()) {
      const pts = arcPositions(points, radiusFn);
      if (pts.length < 6) continue;
      const attr = line.geometry.attributes.instanceStart;
      if (!attr || attr.data.array.length !== pts.length) {
        line.geometry.setPositions(pts); // 顶点数变了（理论上不会），走重建
        continue;
      }
      attr.data.array.set(pts);
      attr.data.needsUpdate = true;
      line.geometry.computeBoundingSphere(); // 拾取要按新顶点算
    }
  }

  /** 只改「谁在场」；游标每走一步都会调，所以只翻 visible，弧线顶点一概不动 */
  setActive(ids) {
    for (const [id, { line }] of this.byId) line.visible = ids.has(id);
  }

  _add(line) {
    line.layers.set(LAYER_CONTENT); // 单独一趟渲染，见 render-layers.js
    this.group.add(line);
  }

  setSelected(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this._applyStyles();
  }

  /** 射线拾取（Line2 的拾取按屏幕像素宽度计算） */
  pick(raycaster) {
    // 不在场的路线只是 visible=false，射线不看这个标志，得自己筛掉
    const lines = [...this.byId.values()].map((v) => v.line).filter((l) => l.visible);
    const hits = raycaster.intersectObjects(lines, false);
    return hits.length ? hits[0].object.userData.itemId : null;
  }

  /** 绘制中路线的预览（未提交） */
  showPreview(points) {
    this.hidePreview();
    if (!points.length) return;
    const verts = points.map((p) => latLngToVec3(p.lat, p.lng, ROUTE_R));
    this._preview = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(verts),
      new THREE.LineBasicMaterial({ color: OVERLAY_ACTIVE, transparent: true, opacity: 0.85 }),
    );
    this._add(this._preview);
  }

  hidePreview() {
    if (this._preview) {
      this._preview.geometry.dispose();
      this._preview.material.dispose();
      this.group.remove(this._preview);
      this._preview = null;
    }
  }
}

/** 相邻点大圆弧插值后的世界坐标序列（扁平数组，给 LineGeometry.setPositions）；radiusFn(lat,lng) 决定每点半径 */
function arcPositions(points, radiusFn) {
  const out = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      latLngToVec3(points[0].lat, points[0].lng, radiusFn(points[0].lat, points[0].lng), v);
      out.push(v.x, v.y, v.z);
      continue;
    }
    const a = points[i - 1];
    const b = points[i];
    const angle = latLngToVec3(a.lat, a.lng, 1).angleTo(latLngToVec3(b.lat, b.lng, 1));
    const steps = Math.max(1, Math.ceil(THREE.MathUtils.radToDeg(angle) / 2)); // 细分到 ≤2°，防止弦陷
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      // 半径在两端间过渡（中段细化由地形采样在渲染时体现，这里做线性混合够用）
      const rA = radiusFn(a.lat, a.lng);
      const rB = radiusFn(b.lat, b.lng);
      slerpLatLng(a.lat, a.lng, b.lat, b.lng, t, rA + (rB - rA) * t, v);
      out.push(v.x, v.y, v.z);
    }
  }
  return out;
}
