import * as THREE from 'three';
import { OVERLAY_ACTIVE, OVERLAY_BASE, OVERLAY_BORDER } from './overlay-palette.js';
import { LAYER_CONTENT } from './render-layers.js';
import { createMaterialBin } from './material-bin.js';
import { SphereShape } from './shapes/sphere-shape.js';

const FILL_LIFT = 0.0025; // 填充面略高于地表，避免 z-fighting
const LINE_LIFT = 0.005;  // 边界线更高一点，盖在填充面上
const MAX_TRI_DEG = 2; // 三角形最大边长（度），对应弦陷 0.00015，远小于层高
const MAX_DEPTH = 6;   // 四分割深度上限，防止退化环死循环
// 悬停只轻抬一层，选中只换边界色：整块区域变橙会压过地形
const HOVER_FILL_BOOST = 0.04;
const SELECTED_FILL_BOOST = 0.03;
const NORMAL_LINE_OPACITY = 0.8;
const HOVER_LINE_OPACITY = 0.95;

/**
 * 势力区域层：用户在球面上逐点勾画的多边形。
 * 环在「经度-纬度平面」做 earcut 三角剖分，再递归细分后投影到球面
 * （大三角形直接投影会以弦的形式沉到球面以下，表现为填充空洞）。
 */
export class RegionLayer {
  /**
   * @param {THREE.Object3D} parent
   * @param {() => object} getConfig 返回画面设置（config.markers.fillOpacity）
   * @param {() => import('./shapes/world-shape.js').WorldShape} [getShape] 当前世界形状
   */
  constructor(parent, getConfig, getShape = null) {
    this.getConfig = getConfig;
    this.getShape = getShape ?? (() => new SphereShape());
    /** 有没有项目（bridge 管理）；每帧与 shape.contentVisible 相乘得 group.visible */
    this.hasContent = true;
    this.group = new THREE.Group();
    this.group.name = 'regions';
    parent.add(this.group);
    /** @type {Map<string, { fill: THREE.Mesh|null, line: THREE.LineSegments, mat: THREE.MeshBasicMaterial, lineMat: THREE.LineBasicMaterial, color: string|null }>} */
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
    for (const region of regions) {
      const polygons = region.ring?.length >= 3 ? [region.ring] : [];
      const color = region.color ?? null;
      const entry = { fill: null, line: null, polygons, color };

      if (polygons.length) {
        const mat = this._fillBin.take();
        mat.color.set(color ?? OVERLAY_BASE);
        entry.mat = mat;
        entry.fill = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        entry.fill.userData.itemId = region.id;
        this._add(entry.fill);
      }

      const lineMat = this._lineBin.take();
      lineMat.color.set(color ?? OVERLAY_BORDER);
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
    const shape = this.getShape();
    const radiusFn = (lat, lng) => (this.terrainRadius?.(lat, lng) ?? 0);
    for (const entry of this.byId.values()) {
      const { polygons } = entry;
      if (entry.fill) {
        entry.fill.geometry.dispose();
        entry.fill.geometry = buildFillGeometry(polygons, radiusFn, shape);
      }
      entry.line.geometry.dispose();
      entry.line.geometry = buildBorderGeometry(polygons, radiusFn, shape);
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

  /**
   * 区域自己的颜色同时用在填充与边界上；没设颜色时分别退回默认填充色与默认边界色。
   * 选中时边界统一换成铜橙，悬停时边界提亮——这两种反馈优先于区域自己的颜色。
   */
  _applyStyles() {
    const base = this.getConfig().markers.fillOpacity;
    for (const [id, e] of this.byId) {
      const selected = id === this.selectedId;
      const hover = id === this.hoverId;
      const boost = selected ? SELECTED_FILL_BOOST : hover ? HOVER_FILL_BOOST : 0;
      const fillColor = e.color ?? OVERLAY_BASE;
      const borderColor = e.color ?? OVERLAY_BORDER;
      if (e.mat) {
        e.mat.color.set(fillColor);
        e.mat.opacity = Math.min(0.85, base + boost);
      }
      e.lineMat.color.set(selected ? OVERLAY_ACTIVE : hover ? fillColor : borderColor);
      e.lineMat.opacity = selected ? 1 : hover ? HOVER_LINE_OPACITY : NORMAL_LINE_OPACITY;
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

  /** 射线拾取填充面，返回区域 id 或 null。cameraPosition 用来排除地球背面的命中 */
  pick(raycaster, cameraPosition) {
    // 不在场的区域只是 visible=false，射线不看这个标志，得自己筛掉
    const meshes = [...this.byId.values()].map((e) => e.fill).filter((f) => f && f.visible);
    const hits = raycaster.intersectObjects(meshes, false);
    // 填充面是双面材质，射线会命中地球背面；只接受与相机同侧（点积为正）的命中
    const hit = hits.find((h) => !cameraPosition || h.point.dot(cameraPosition) > 0);
    return hit ? hit.object.userData.itemId : null;
  }

  // ------------------------------------------------ 绘制预览

  /** 显示正在勾画的多边形轮廓（lngLatArray: [[lng,lat]...]） */
  showPreview(ring) {
    this.hidePreview();
    if (!ring.length) return;
    const shape = this.getShape();
    const verts = ring.map(([lng, lat]) => shape.surfacePoint(lat, lng, LINE_LIFT + 0.002));
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
      new THREE.LineBasicMaterial({ color: OVERLAY_ACTIVE, transparent: true, opacity: 0.85 }),
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
 * 环三角剖分后递归细分，投影到世界形状表面，返回非索引 BufferGeometry。
 * radiusFn(lat, lng) 提供每个投影点的地形抬升；环先过形状的裁剪
 * （球体恒等返回，平板把跨边缘的环拆成多块），再逐块剖分。
 */
function buildFillGeometry(polygons, radiusFn, shape) {
  const positions = [];
  for (const ring of polygons) {
    for (const piece of shape.clipPolygon(ring)) {
      const contour = toVec2s(piece.outer);
      if (contour.length < 3) continue;
      let faces;
      try {
        // 孔洞入口已经留好（piece.holes），数据模型暂无孔洞，恒为空
        faces = THREE.ShapeUtils.triangulateShape(contour, piece.holes.map(toVec2s));
      } catch { continue; }
      for (const face of faces) {
        pushSubdivided(contour[face[0]], contour[face[1]], contour[face[2]], radiusFn, positions, 0, shape);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

/** 环上相邻点两两连线（LineSegments），细分防弦陷 */
function buildBorderGeometry(polygons, radiusFn, shape) {
  const positions = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const ring of polygons) {
    for (const piece of shape.clipPolygon(ring)) {
      const ringPts = piece.outer;
      for (let i = 0; i < ringPts.length; i++) {
        const [lng1, lat1] = ringPts[i];
        const [lng2, lat2] = ringPts[(i + 1) % ringPts.length]; // 闭合
        let l2 = lng2;
        if (l2 - lng1 > 180) l2 -= 360; // 跨 ±180° 按短弧插值
        if (lng1 - l2 > 180) l2 += 360;
        shape.surfacePoint(lat1, lng1, LINE_LIFT + radiusFn(lat1, lng1), a);
        positions.push(a.x, a.y, a.z);
        const steps = Math.max(1, Math.ceil(shape.edgeLengthDeg(lng1, lat1, l2, lat2) / MAX_TRI_DEG));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const latT = lat1 + (lat2 - lat1) * t;
          const lngT = lng1 + (l2 - lng1) * t;
          shape.surfacePoint(latT, lngT, LINE_LIFT + radiusFn(latT, lngT), b);
          positions.push(b.x, b.y, b.z);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

function toVec2s(ring) {
  return ring.map(([lng, lat]) => new THREE.Vector2(lng, lat));
}

const _v3 = new THREE.Vector3();

/** 三角形递归四分割后投影到形状表面（非索引顶点）；radiusFn(lat, lng) 决定每个顶点的浮空量 */
function pushSubdivided(a, b, c, radiusFn, out, depth, shape) {
  if (depth >= MAX_DEPTH ||
      (shape.edgeLengthDeg(a.x, a.y, b.x, b.y) <= MAX_TRI_DEG &&
       shape.edgeLengthDeg(b.x, b.y, c.x, c.y) <= MAX_TRI_DEG &&
       shape.edgeLengthDeg(c.x, c.y, a.x, a.y) <= MAX_TRI_DEG)) {
    for (const p of [a, b, c]) {
      shape.surfacePoint(p.y, p.x, FILL_LIFT + radiusFn(p.y, p.x), _v3);
      out.push(_v3.x, _v3.y, _v3.z);
    }
    return;
  }
  const ab = new THREE.Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
  const bc = new THREE.Vector2((b.x + c.x) / 2, (b.y + c.y) / 2);
  const ca = new THREE.Vector2((c.x + a.x) / 2, (c.y + a.y) / 2);
  pushSubdivided(a, ab, ca, radiusFn, out, depth + 1, shape);
  pushSubdivided(ab, b, bc, radiusFn, out, depth + 1, shape);
  pushSubdivided(ca, bc, c, radiusFn, out, depth + 1, shape);
  pushSubdivided(ab, bc, ca, radiusFn, out, depth + 1, shape);
}
