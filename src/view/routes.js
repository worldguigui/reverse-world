import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { OVERLAY_ACTIVE, OVERLAY_BASE } from './overlay-palette.js';
import { LAYER_CONTENT } from './render-layers.js';
import { createMaterialBin } from './material-bin.js';
import { SPHERE_SHAPE } from './shapes/index.js';

/** 路线浮在名义表面之上的高度（沿表面法线；球=径向，平板=竖直） */
const ROUTE_LIFT = 0.008;
// 普通路线压低存在感，选中时靠铜橙、加粗与满透明度拉开层级
const NORMAL_OPACITY = 0.78;
const SELECTED_EXTRA_WIDTH = 1;

/**
 * 路线层：路径折线由形状的 projectPath 投影（球=一条大圆弧，平板=可拆段的折线），
 * Line2 渲染保证像素宽度。LineMaterial 的宽度按屏幕像素计算，依赖 resolution，
 * 需要在 resize 时同步。一条路线的多个段共享同一份材质与选中态。
 */
export class RouteLayer {
  /**
   * @param {THREE.Object3D} parent
   * @param {() => object} getConfig 返回画面设置（config.markers.routeWidth）
   * @param {() => import('./shapes/world-shape.js').WorldShape} [getShape] 当前世界形状
   */
  constructor(parent, getConfig, getShape = null) {
    this.parent = parent;
    this.getConfig = getConfig;
    this.getShape = getShape ?? (() => SPHERE_SHAPE);
    /** 有没有项目（bridge 管理）；每帧与 shape.contentVisible 相乘得 group.visible */
    this.hasContent = true;
    this.group = new THREE.Group();
    this.group.name = 'routes';
    parent.add(this.group);
    /** @type {Map<string, { lines: Line2[], mat: LineMaterial, color: string|null }>} */
    this.byId = new Map();
    this.selectedId = null;
    this._resolution = new THREE.Vector2(1, 1);
    this._preview = null;
    /** 可选：(lat, lng) => 浮空量（贴地形） */
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
   * 重建全部路线。只有内容真的变了才调——每条都要重新插值细分出一串顶点。
   * 收全部路线而不是当前游标下在场的那批，此后游标怎么走都只翻可见性。
   * 线条在 relayout 里按 projectPath 的段数创建。
   */
  build(routes) {
    for (const entry of this.byId.values()) this._disposeEntry(entry);
    this.byId.clear();
    for (const route of routes) {
      const mat = this._bin.take();
      mat.resolution = this._resolution;
      this.byId.set(route.id, { lines: [], mat, points: route.points, color: route.color ?? null });
    }
    this._applyStyles();
    this.relayout();
  }

  /** 路线自己的颜色是常态色；选中时统一换成铜橙，作为「正在编辑这条」的反馈 */
  _applyStyles() {
    const width = this.getConfig().markers.routeWidth;
    for (const [id, { mat, color }] of this.byId) {
      const selected = id === this.selectedId;
      mat.color.set(selected ? OVERLAY_ACTIVE : (color ?? OVERLAY_BASE));
      mat.linewidth = selected ? width + SELECTED_EXTRA_WIDTH : width;
      mat.opacity = selected ? 1 : NORMAL_OPACITY;
    }
  }

  /**
   * 按存下的途经点重算折线顶点。
   * 拆段数不变、且每段顶点数不变时原地改写 buffer（setPositions 每次都新分配一个，
   * 画笔拖动时一秒几十次会不停丢掉旧的 GPU buffer）；段数变了（跨边缘的路线
   * 因编辑而增减拆段）才整组重建线条。虚线距离不重算——路线不开虚线，
   * 着色器根本不会去读它。
   */
  relayout() {
    const shape = this.getShape();
    const liftFn = (lat, lng) => ROUTE_LIFT + (this.terrainRadius?.(lat, lng) ?? 0);
    for (const [id, entry] of this.byId) {
      const segments = shape.projectPath(entry.points, liftFn);
      if (entry.lines.length !== segments.length) {
        // 拆段结构变了：整组线条重建（几何释放、材质复用）
        this._disposeEntry(entry, { keepMat: true });
        entry.lines = segments
          .filter((pts) => pts.length >= 6)
          .map((pts) => {
            const line = new Line2(new LineGeometry(), entry.mat);
            line.userData.itemId = id;
            line.geometry.setPositions(pts);
            this._add(line);
            return line;
          });
        continue;
      }
      for (const [i, pts] of segments.entries()) this._updateLine(entry.lines[i], pts);
    }
  }

  /**
   * 单段原地改写：顶点数不变时复用那份交错 buffer。
   * LineGeometry.setPositions 把 N 个点展开成 N-1 段、每段 6 个 float 的交错缓冲，
   * 长度是 6N-6；pts 是 3N。拿 3N 去比永远对不上，会每次都走重建。
   */
  _updateLine(line, pts) {
    const geom = line.geometry;
    const attr = geom.attributes.instanceStart;
    const buf = attr?.data;
    const need = pts.length * 2 - 6;
    if (!buf || buf.array.length !== need) {
      // 顶点数真的变了：setPositions 会新建 InstancedInterleavedBuffer，
      // 旧的 GPU buffer 只有 dispose 几何时才释放，否则每次重排都漏一份
      geom.dispose();
      geom.setPositions(pts);
      return;
    }
    const arr = buf.array;
    // 原地按线段对写入：第 i 段 arr[6i..6i+5] = pts[3i..3i+5]
    for (let d = 0, s = 0; d < need; d += 6, s += 3) {
      arr[d] = pts[s];
      arr[d + 1] = pts[s + 1];
      arr[d + 2] = pts[s + 2];
      arr[d + 3] = pts[s + 3];
      arr[d + 4] = pts[s + 4];
      arr[d + 5] = pts[s + 5];
    }
    buf.needsUpdate = true;
    geom.computeBoundingSphere(); // 拾取要按新顶点算
  }

  /** 只改「谁在场」；游标每走一步都会调，所以只翻 visible，折线顶点一概不动 */
  setActive(ids) {
    for (const [id, { lines }] of this.byId) {
      const visible = ids.has(id); // 同一条路线的所有段同进退
      for (const line of lines) line.visible = visible;
    }
  }

  _add(line) {
    line.layers.set(LAYER_CONTENT); // 单独一趟渲染，见 render-layers.js
    this.group.add(line);
  }

  _disposeEntry(entry, { keepMat = false } = {}) {
    for (const line of entry.lines) {
      line.geometry.dispose();
      this.group.remove(line);
    }
    entry.lines = [];
    if (!keepMat) this._bin.put(entry.mat); // 几何可以丢，材质留着——见 material-bin.js
  }

  setSelected(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this._applyStyles();
  }

  /**
   * 射线拾取（Line2 的拾取按屏幕像素宽度计算）。
   * 世界背面的路线投影到屏幕上仍会被射线命中，所以按命中点与相机位置的夹角筛掉：
   * 可见半球/顶面上的点与相机方向同侧，背面的点方向相反。
   * @param {THREE.Raycaster} raycaster
   * @param {THREE.Vector3} [cameraPosition] 相机世界坐标；不传则不筛背面
   */
  pick(raycaster, cameraPosition) {
    // 不在场的路线只是 visible=false，射线不看这个标志，得自己筛掉
    const lines = [...this.byId.values()].flatMap((v) => v.lines).filter((l) => l.visible);
    const hits = raycaster.intersectObjects(lines, false);
    const hit = hits.find((h) => !cameraPosition || h.point.dot(cameraPosition) > 0);
    return hit ? hit.object.userData.itemId : null;
  }

  /** 绘制中路线的预览（未提交）：每段一根线，顶点点集合全段 */
  showPreview(points) {
    this.hidePreview();
    if (!points.length) return;
    const segments = this.getShape().projectPath(points, () => ROUTE_LIFT);
    const mat = new THREE.LineBasicMaterial({ color: OVERLAY_ACTIVE, transparent: true, opacity: 0.85 });
    const verts = [];
    this._preview = { mat, lines: [] };
    for (const flat of segments) {
      const segVerts = [];
      for (let i = 0; i < flat.length; i += 3) {
        const v = new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]);
        segVerts.push(v);
        verts.push(v);
      }
      if (segVerts.length < 2) continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(segVerts), mat);
      this._add(line);
      this._preview.lines.push(line);
    }
    if (!verts.length) { this.hidePreview(); return; }
    this._preview.dots = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(verts),
      new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false }),
    );
    this._add(this._preview.dots);
  }

  hidePreview() {
    const p = this._preview;
    if (!p) return;
    for (const line of p.lines) {
      line.geometry.dispose();
      this.group.remove(line);
    }
    if (p.dots) {
      p.dots.geometry.dispose();
      p.dots.material.dispose();
      this.group.remove(p.dots);
    }
    p.mat.dispose();
    this._preview = null;
  }
}
