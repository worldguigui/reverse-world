import * as THREE from 'three';
import { latLngToVec3 } from '../utils.js';
import { LAYER_CONTENT } from './render-layers.js';
import { createMaterialBin } from './material-bin.js';

/** 地名与光点浮在球面之上的半径：贴着地表，又要离开深度掩膜球一点，否则会与它打架 */
const SURFACE_R = 1.003;
/** 世界坐标系的「正北」：算地名朝向时的参照轴 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** 画布上的字号。只管清晰度，跟屏幕上显示多大无关 */
const CANVAS_FONT_PX = 44;
/** 画布上下留的空白：深色描边会溢出字形，不留边会被切掉 */
const CANVAS_PAD = 10;
/** 一块地名的画布最宽到这里；再长就把字号压小，免得贴图大到没必要 */
const CANVAS_MAX_W = 1024;
/** 选中 / 悬停时地名放大的倍数。字不像圆点，放太多会像换了字号 */
const SELECTED_K = 1.3;
const HOVER_K = 1.15;
/** 视角淡出的起止：法线与视线夹角越小越清楚，低于这个余弦就整个隐掉 */
const FADE_FROM = 0.18;
const FADE_TO = 0.45;

// 每帧都要算的东西，复用这几个，免得一分钟堆出几千个临时向量
const _camDir = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _ndc = new THREE.Vector3();

/**
 * 地名层：每条地点一块贴合球面的四边形，名字直接画在它上面。
 *
 * 与早先那套 Sprite 的差别在朝向。Sprite 永远正对相机，看上去浮在球前面；
 * 这里的四边形按地点处的法线定向、字头朝北，随地球一起转，转到背面被球挡住，
 * 也就是「印在世界地图上」的样子。代价是侧视时字被压扁，所以按下倾角给不透明度：
 * 越斜越淡，太斜就整个隐掉，不留一条糊掉的横线。
 *
 * 大小按屏幕像素算，不随远近缩放——与真实地图一样，拉远拉近字体都一样大，
 * 变的只是有多少地名挤得下。挤不下的靠每帧一次贪心碰撞剔除让位，
 * 越正对镜头的越优先留下（那是你正在看的地方）。
 */
export class LabelLayer {
  /**
   * @param {THREE.Object3D} parent
   * @param {() => object} getConfig 返回画面设置（config.markers.labelPx）
   * @param {number} maxAnisotropy 渲染器支持的各向异性上限，斜着看时字更清楚
   */
  constructor(parent, getConfig, maxAnisotropy = 1) {
    this.parent = parent;
    this.getConfig = getConfig;
    this.maxAnisotropy = maxAnisotropy;
    this.group = new THREE.Group();
    this.group.name = 'labels';
    parent.add(this.group);
    /** @type {Map<string, THREE.Mesh>} */
    this.byId = new Map();
    this.hoverId = null;
    this.selectedId = null;
    this.viewportW = 1;
    this.viewportH = 1;
    /** 上一帧真的画出来的地名，供拾取用。碰撞剔除掉的不算 */
    this._placed = [];
    /** 每帧按正对程度排序用的临时数组，复用免得每帧新建 */
    this._order = [];
    /** 可选：(lat, lng) => 半径抬升量，让地名站在山上 */
    this.terrainRadius = null;
    // 材质在整层重建之间复用，贴图每次都换——理由见 material-bin.js
    this._bin = createMaterialBin(64, () => new THREE.MeshBasicMaterial({
      transparent: true, depthTest: true, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }));
  }

  /**
   * 重建全部地名。只有内容真的变了才调——一张贴图建一次要几毫秒。
   * 收的是全部地点而不是当前游标下在场的那批：带存续区间的地点也一并建出来，
   * 此后游标怎么走都只翻可见性，不再碰贴图。
   */
  build(entries) {
    for (const mesh of this.byId.values()) {
      const mat = mesh.material;
      mat.map?.dispose(); // 地名贴图每条一份，旧的那张随手丢掉
      mat.map = null;
      this._bin.put(mat); // 几何与贴图都可以丢，材质留着——见 material-bin.js
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.byId.clear();
    for (const entry of entries) {
      const { texture, aspect } = makeLabelTexture(entry.title ?? entry.name ?? '', this.maxAnisotropy);
      const mat = this._bin.take();
      mat.map = texture;
      mat.opacity = 1;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.userData = {
        itemId: entry.id,
        lat: entry.lat,
        lng: entry.lng,
        aspect,                                  // 宽 / 高，缩放时保持字不被拉变
        normal: latLngToVec3(entry.lat, entry.lng, 1).normalize(), // 地表法线，算朝向与视角淡出都用它
        active: true,                            // 游标此刻有没有把它算作在场
        dot: 1,
        sx: 0, sy: 0, hw: 0, hh: 0,              // 上一帧的屏幕位置与半宽半高，供碰撞剔除与拾取用
      };
      mesh.quaternion.copy(surfaceQuaternion(mesh.userData.normal));
      this._add(mesh);
      this.byId.set(entry.id, mesh);
    }
    this.relayout();
  }

  /** 屏幕尺寸：像素 → 世界单位要知道视口高度与视场角 */
  setViewport(w, h) { this.viewportW = w; this.viewportH = h; }

  /**
   * 只有地形变了（换底图、画笔涂抹）：把已有地名重新贴回地表。
   * 建一张贴图要几毫秒，50 个地点就是几十毫秒——画笔每移动一下都重建一遍是之前卡顿的主因，
   * 重定位则只是几十次向量乘法。
   */
  relayout() {
    for (const mesh of this.byId.values()) {
      const { lat, lng } = mesh.userData;
      const lift = this.terrainRadius?.(lat, lng) ?? 0;
      mesh.position.copy(latLngToVec3(lat, lng, SURFACE_R + lift));
    }
  }

  /**
   * 只改「谁在场」。游标每走一步都会调到这里，所以必须便宜——
   * 贴图、几何、材质一律不动，成本就是 N 次布尔赋值。
   *
   * 这里只记在 userData 上，不直接写 visible：眼下这一点露不露脸还要过一道碰撞剔除，
   * 两边都写一个字段的话，被剔掉的地名会因为 visible 已经是 false 而再也没人把它打开。
   */
  setActive(ids) {
    for (const [id, mesh] of this.byId) mesh.userData.active = ids.has(id);
  }

  _add(mesh) {
    mesh.layers.set(LAYER_CONTENT); // 单独一趟渲染，见 render-layers.js
    this.group.add(mesh);
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
  }

  setSelected(id) {
    this.selectedId = id;
  }

  /**
   * 每帧一趟：定大小、定浓淡、剔除挤在一起的地名。
   * 这几件事都只跟相机有关，跟内容无关——所以放这里而不是放进 bridge 的某个信号。
   */
  update(camera) {
    if (!this.byId.size) return;
    const cfg = this.getConfig();
    const labelPx = cfg.markers.labelPx;
    const camPos = camera.position;
    // 距离 1 处一个世界单位占几个像素；乘上相机距离就是该处每世界单位的像素数
    const pxPerWorld = this.viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    _camDir.copy(camPos).normalize();

    // 先把够格出场的地名算一遍朝向、浓淡与屏幕落点，再按正对程度从高到低做一次贪心剔除：
    // 正对镜头的优先留下，那多半是观众正在看的地方
    const order = this._order;
    order.length = 0;
    const camDist = camPos.length();
    for (const mesh of this.byId.values()) {
      const u = mesh.userData;
      if (!u.active) { mesh.visible = false; continue; }
      const { normal } = u;
      const dot = normal.dot(_camDir);
      // 地平线判据：相机距离 d 时，可见半球满足 dot(法线, 相机方向) > 1/d
      if (dot < 1 / camDist) { mesh.visible = false; continue; }

      _toCam.copy(camPos).sub(mesh.position);
      const dist = _toCam.length();
      const k = _toCam.divideScalar(dist).dot(normal); // 表面法线与视线方向的夹角余弦
      if (k <= FADE_FROM) { mesh.visible = false; continue; }
      mesh.material.opacity = Math.min(1, (k - FADE_FROM) / (FADE_TO - FADE_FROM));

      const emphasis = u.itemId === this.selectedId ? SELECTED_K
        : u.itemId === this.hoverId ? HOVER_K : 1;
      const h = (labelPx / pxPerWorld) * dist * emphasis;
      mesh.scale.set(h * u.aspect, h, 1);

      const ndc = _ndc.copy(mesh.position).project(camera);
      u.sx = ((ndc.x + 1) / 2) * this.viewportW;
      u.sy = ((1 - ndc.y) / 2) * this.viewportH;
      u.hw = (h * u.aspect * pxPerWorld) / (2 * dist);
      u.hh = (h * pxPerWorld) / (2 * dist);
      u.dot = dot;
      order.push(mesh);
    }

    order.sort((a, b) => b.userData.dot - a.userData.dot);
    const placed = this._placed;
    placed.length = 0;
    for (const mesh of order) {
      const u = mesh.userData;
      const hit = placed.some((o) => Math.abs(o.sx - u.sx) < o.hw + u.hw && Math.abs(o.sy - u.sy) < o.hh + u.hh);
      mesh.visible = !hit;
      if (!hit) placed.push(u);
    }
  }

  /**
   * 屏幕空间拾取，返回命中的地点 id 或 null。
   *
   * 不用射线打那些四边形：它们贴着地表，斜着看时几乎侧对镜头，射线很难打中，
   * 于是「正对着的地名点得中、边上的点不中」——真实地图也走屏幕空间那一套
   * （按要素几何的投影查点），不靠字形本身。
   * 落点同时压住两块时取更靠近的那块。
   */
  pick(ndc) {
    const x = (ndc.x + 1) / 2 * this.viewportW;
    const y = (1 - ndc.y) / 2 * this.viewportH;
    let best = null;
    let bestD = Infinity;
    for (const u of this._placed) {
      const dx = Math.abs(x - u.sx);
      const dy = Math.abs(y - u.sy);
      if (dx > u.hw || dy > u.hh) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = u.itemId; }
    }
    return best;
  }
}

/**
 * 标签所在处的球面姿态：局部 +Z 对齐地表法线（字面朝外），
 * 局部 +X 指向东、+Y 指向北（字横着读、字头朝北）。
 *
 * 直接让 +Z 对上法线是不够的——那样还差一个绕法线的自转，字会是歪的；
 * 必须把「东」和「北」也算出来，凑成一个完整的基。
 */
function surfaceQuaternion(normal) {
  const east = new THREE.Vector3().crossVectors(WORLD_UP, normal);
  // 到了极点，正北与法线重合，「东」塌成零向量。随便挑一个方向把基撑住，
  // 反正极点附近本来也没有地名，这里只是不让它算出 NaN
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const north = new THREE.Vector3().crossVectors(normal, east);
  const m = new THREE.Matrix4().makeBasis(east, north, normal);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/**
 * 事件光点层：整层只有一个点，跟着当前选中的那条事件走，没选中就不存在。
 *
 * 事件不再各自留一个标注。球上铺满点时，它们会与地名互相压住，也让人以为「点上去能选中」——
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

/**
 * 把地名画成一张贴图，连它该有的长宽比一起交回。
 * 字号固定，画布按量出来的字宽裁剪——贴图里不留多余的透明边，
 * 否则四边形比字大一圈，碰撞剔除会误伤旁边的地名。
 */
function makeLabelTexture(title, maxAnisotropy) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let fontPx = CANVAS_FONT_PX;
  const font = (px) => `${px}px Georgia, "Times New Roman", "Songti SC", "SimSun", serif`;
  ctx.font = font(fontPx);
  const width = ctx.measureText(title).width;
  // 名字特别长就压小字号，别让贴图宽到没边
  if (width + CANVAS_PAD * 2 > CANVAS_MAX_W) {
    fontPx = Math.max(10, Math.floor(fontPx * (CANVAS_MAX_W - CANVAS_PAD * 2) / width));
  }
  ctx.font = font(fontPx);
  const w = Math.ceil(ctx.measureText(title).width) + CANVAS_PAD * 2;
  const h = fontPx + CANVAS_PAD * 2;
  canvas.width = w; canvas.height = h;
  // 改画布尺寸会把上下文状态一并重置，字号与对齐方式得重设一遍
  ctx.font = font(fontPx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 深色描边当底衬：地表有山、有海、有沙漠，只有一圈深色才保证在任何底色上都读得清
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(26, 18, 10, 0.82)';
  ctx.strokeText(title, w / 2, h / 2);
  ctx.fillStyle = '#f4e7c8'; // 旧纸的暖白
  ctx.fillText(title, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return { texture: tex, aspect: w / h };
}
