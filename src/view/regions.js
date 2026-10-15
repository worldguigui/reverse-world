import * as THREE from 'three';
import { latLngToVec3 } from '../utils.js';
import { LAYER_CONTENT } from './render-layers.js';
import { createMaterialBin } from './material-bin.js';

const FILL_R = 1.0025; // 填充面略高于地表，避免 z-fighting
const LINE_R = 1.005;  // 边界线更高一点，盖在填充面上
const MAX_TRI_DEG = 2; // 三角形最大边长（度），对应弦陷 0.00015，远小于层高
const MAX_DEPTH = 6;   // 四分割深度上限，防止退化环死循环

/**
 * 势力区域层：用户在球面上逐点勾画的多边形。
 * 环在「经度-纬度平面」做 earcut 三角剖分，再递归细分后投影到球面
 * （大三角形直接投影会以弦的形式沉到球面以下，表现为填充空洞）。
 */
export class RegionLayer {
  constructor(parent, getConfig) {
    this.getConfig = getConfig;
    this.group = new THREE.Group();
    this.group.name = 'regions';
    parent.add(this.group);
    /** @type {Map<string, { fill: THREE.Mesh|null, line: THREE.LineSegments, mat: THREE.MeshBasicMaterial, lineMat: THREE.LineBasicMaterial }>} */
    this.byId = new Map();
    this.hoverId = null;
    this.selectedId = null;
    this._preview = null; // 绘制中的轮廓线
    this._previewDots = null;
    /** 可选：(lat, lng) => 半径抬升量（贴地形） */
    this.terrainRadius = null;
    // 填充面与边界线各一个桶，材质在整层重建之间复用——理由见 material-bin.js
    this._fillBin = createMaterialBin(32, () => new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this._lineBin = createMaterialBin(32, () => new THREE.LineBasicMaterial({ transparent: true }));
  }

  /**
   * 重建全部区域。只有内容真的变了才调——每个区域都要重新三角剖分、递归细分、再投到球面。
   * 收全部区域而不是当前游标下在场的那批，此后游标怎么走都只翻可见性。
   */
  build(regions) {
    this._clearBuilt();
    const fillOpacity = this.getConfig().markers.fillOpacity;
    for (const region of regions) {
      const polygons = region.ring?.length >= 3 ? [region.ring] : [];
      const entry = { fill: null, line: null, polygons };
      const color = region.color || '#ffb545';

      if (polygons.length) {
        const mat = this._fillBin.take();
        mat.color.set(color);
        mat.opacity = fillOpacity;
        entry.mat = mat;
        entry.fill = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        entry.fill.userData.itemId = region.id;
        this._add(entry.fill);
      }

      const lineMat = this._lineBin.take();
      lineMat.color.set(color);
      lineMat.opacity = 0.9;
      entry.lineMat = lineMat;
      entry.line = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
      entry.line.userData.itemId = region.id;
      this._add(entry.line);

      this.byId.set(region.id, entry);
    }
    this.relayout();
    this._applyStyles();
  }

  /** 只有地形变了：按存下的环重算贴地顶点（材质与颜色都不动） */
  relayout() {
    const radiusFn = (lat, lng) => (this.terrainRadius?.(lat, lng) ?? 0);
    for (const entry of this.byId.values()) {
      const { polygons } = entry;
      if (entry.fill) {
        entry.fill.geometry.dispose();
        entry.fill.geometry = buildFillGeometry(polygons, radiusFn);
      }
      entry.line.geometry.dispose();
      entry.line.geometry = buildBorderGeometry(polygons, radiusFn);
    }
  }

  /** 只改「谁在场」；游标每走一步都会调，所以只翻 visible，几何一概不重算 */
  setActive(ids) {
    for (const [id, e] of this.byId) {
      if (e.fill) e.fill.visible = ids.has(id);
      e.line.visible = ids.has(id);
    }
  }

  _add(obj) {
    obj.layers.set(LAYER_CONTENT); // 单独一趟渲染，见 render-layers.js
    this.group.add(obj);
  }

  _clearBuilt() {
    for (const { fill, line, mat, lineMat } of this.byId.values()) {
      if (fill) { fill.geometry.dispose(); }
      line.geometry.dispose();
      // 几何可以丢，材质进桶留着——见 material-bin.js
      if (mat) this._fillBin.put(mat);
      this._lineBin.put(lineMat);
      this.group.remove(fill);
      this.group.remove(line);
    }
    this.byId.clear();
  }

  _applyStyles() {
    const base = this.getConfig().markers.fillOpacity;
    for (const [id, e] of this.byId) {
      const boost = id === this.selectedId ? 0.45 : id === this.hoverId ? 0.18 : 0;
      if (e.mat) e.mat.opacity = Math.min(0.85, base + boost);
      e.lineMat.opacity = id === this.selectedId ? 1 : 0.9;
    }
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this._applyStyles();
  }

  setSelected(id) {
    this.selectedId = id;
    this._applyStyles();
  }

  /** 射线拾取填充面，返回区域 id 或 null */
  pick(raycaster) {
    // 不在场的区域只是 visible=false，射线不看这个标志，得自己筛掉
    const meshes = [...this.byId.values()].map((e) => e.fill).filter((f) => f && f.visible);
    const hits = raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object.userData.itemId : null;
  }

  // ------------------------------------------------ 绘制预览

  /** 显示正在勾画的多边形轮廓（lngLatArray: [[lng,lat]...]） */
  showPreview(ring) {
    this.hidePreview();
    if (!ring.length) return;
    const verts = ring.map(([lng, lat]) => latLngToVec3(lat, lng, LINE_R + 0.002));
    if (verts.length === 1) {
      this._previewDots = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints(verts),
        new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false }),
      );
      this._add(this._previewDots);
      return;
    }
    this._preview = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(verts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    this._previewDots = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(verts),
      new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false }),
    );
    this._add(this._preview);
    this._add(this._previewDots);
  }

  hidePreview() {
    for (const obj of [this._preview, this._previewDots]) {
      if (obj) {
        obj.geometry.dispose();
        obj.material.dispose();
        this.group.remove(obj);
      }
    }
    this._preview = this._previewDots = null;
  }
}

// ---------------------------------------------------------------- 剖分与细分

/**
 * 环三角剖分后递归细分，投影到球面，返回非索引 BufferGeometry。
 * radiusFn(lat, lng) 提供每个投影点的地形抬升。
 */
function buildFillGeometry(polygons, radiusFn) {
  const positions = [];
  for (const ring of polygons) {
    const contour = toVec2s(ring);
    if (contour.length < 3) continue;
    let faces;
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch { continue; }
    for (const face of faces) {
      pushSubdivided(contour[face[0]], contour[face[1]], contour[face[2]], radiusFn, positions, 0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

/** 环上相邻点两两连线（LineSegments），细分防弦陷 */
function buildBorderGeometry(polygons, radiusFn) {
  const positions = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const ring of polygons) {
    for (let i = 0; i < ring.length; i++) {
      const [lng1, lat1] = ring[i];
      const [lng2, lat2] = ring[(i + 1) % ring.length]; // 闭合
      let l2 = lng2;
      if (l2 - lng1 > 180) l2 -= 360; // 跨 ±180° 按短弧插值
      if (lng1 - l2 > 180) l2 += 360;
      latLngToVec3(lat1, lng1, LINE_R + radiusFn(lat1, lng1), a);
      positions.push(a.x, a.y, a.z);
      const steps = Math.max(1, Math.ceil(edgeDeg(lng1, lat1, l2, lat2) / MAX_TRI_DEG));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const latT = lat1 + (lat2 - lat1) * t;
        const lngT = lng1 + (l2 - lng1) * t;
        latLngToVec3(latT, lngT, LINE_R + radiusFn(latT, lngT), b);
        positions.push(b.x, b.y, b.z);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

/** 考虑纬度收缩的边长（度） */
function edgeDeg(lng1, lat1, lng2, lat2) {
  const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  return Math.hypot((lng2 - lng1) * Math.cos(midLat), lat2 - lat1);
}

function toVec2s(ring) {
  return ring.map(([lng, lat]) => new THREE.Vector2(lng, lat));
}

const _v3 = new THREE.Vector3();

/** 三角形递归四分割后投影到球面（非索引顶点）；radiusFn(lat, lng) 决定每个顶点半径 */
function pushSubdivided(a, b, c, radiusFn, out, depth) {
  if (depth >= MAX_DEPTH ||
      (edgeDeg(a.x, a.y, b.x, b.y) <= MAX_TRI_DEG &&
       edgeDeg(b.x, b.y, c.x, c.y) <= MAX_TRI_DEG &&
       edgeDeg(c.x, c.y, a.x, a.y) <= MAX_TRI_DEG)) {
    for (const p of [a, b, c]) {
      latLngToVec3(p.y, p.x, FILL_R + radiusFn(p.y, p.x), _v3);
      out.push(_v3.x, _v3.y, _v3.z);
    }
    return;
  }
  const ab = new THREE.Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
  const bc = new THREE.Vector2((b.x + c.x) / 2, (b.y + c.y) / 2);
  const ca = new THREE.Vector2((c.x + a.x) / 2, (c.y + a.y) / 2);
  pushSubdivided(a, ab, ca, radiusFn, out, depth + 1);
  pushSubdivided(ab, b, bc, radiusFn, out, depth + 1);
  pushSubdivided(ca, bc, c, radiusFn, out, depth + 1);
  pushSubdivided(ab, bc, ca, radiusFn, out, depth + 1);
}
