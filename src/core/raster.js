/**
 * 栅格地形引擎：16 位高度 + RGB565 颜色的双通道网格，加上画笔、采样与 PNG 编解码。
 * 两个通道分开存储：
 *   height  多高（归一化单位，设计范围 [-4, 4]）——决定球面几何
 *   color   RGB565 地表颜色——渲染时按存储值一比一使用
 * 颜色笔只写颜色。形态笔改完高度后，会用「高度基色」按新高度与坡度
 * 重算被涂格的颜色，让顶视图里也看得出起伏与沟壑；手动涂色会一直保留，
 * 直到下一次形态笔经过该格。
 *
 * 画笔支持「软笔（高斯衰减）/ 硬笔（方波硬边）」与圆形 / 方形两种笔形。
 * PNG 编码：R+G 打包 16-bit 高度，B+A 打包 RGB565 颜色。
 * 颜色在 alpha 通道里，而 canvas 会预乘 alpha、破坏低位数据，所以 PNG 编解码
 * 都直接走字节，不经过 canvas（见 core/png.js）；球面高度纹理画布也让 alpha
 * 固定为 255，避免颜色低位把 R/G 高度一起乘坏。
 * 纯数据 + canvas（只用于显示），不依赖 three。
 */
import { decodePngRgba, encodePngRgba } from './png.js';

export const H_MIN = -4;
export const H_MAX = 4;
export const H_SPAN = H_MAX - H_MIN; // 8
export const H_RANGE = 2; // 归一化满量程（-1..1）——仅色带参考范围，不参与 clamp

const lerp = (a, b, t) => a + (b - a) * t;
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
const clampI = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 浅海色，也是「重置为海洋」时用的底色 */
export const OCEAN_COLOR = pack565(46, 122, 160);

/** 坡度明暗在完全平坦处的取值；高度着色以它为「不变色」的基准 */
export const FLAT_SHADE = 0.76 + 0.34 * 0.45;

export class TerrainGrid {
  /**
   * @param {number} w 宽（格子数），对应经度 360°
   * @param {number} h 高，对应纬度 180°
   */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.height = new Float32Array(w * h);
    this.color = new Uint16Array(w * h); // RGB565
    this.colorCanvas = document.createElement('canvas');
    this.colorCanvas.width = w;
    this.colorCanvas.height = h;
    this.colorCtx = this.colorCanvas.getContext('2d');
    this._image = this.colorCtx.createImageData(w, h);
    // 高度纹理画布：R+G=16 位高度，alpha 固定 255（B 不用）。
    // 颜色不能放进这里：canvas 会预乘 alpha，颜色低位的 alpha 会把 R/G 压暗。
    this.packedCanvas = document.createElement('canvas');
    this.packedCanvas.width = w;
    this.packedCanvas.height = h;
    this.packedCtx = this.packedCanvas.getContext('2d');
    this._packedImage = this.packedCtx.createImageData(w, h);
    this.renderColor();
  }

  idx(x, y) { return y * this.w + x; }

  // ---------------------------------------------------------------- 画笔

  /**
   * 在格点 (cx, cy) 应用画笔：
   *   raise / lower / smooth → 改高度，再按最终高度与坡度重算颜色
   *   paint / clearColor     → 只改颜色，不动高度
   * @param {'raise'|'lower'|'smooth'|'paint'|'clearColor'} kind
   * @param {number} radius 半径（格）。1 = 只落当前这一格（最小笔刷）
   * @param {number} strength 强度：高度笔是归一化高度增量，颜色笔是颜料浓度
   * @param {boolean} [hard=false] true=硬笔（半径内全强度，不做衰减）
   * @param {'round'|'square'} [shape='round'] 圆形按欧氏距离，方形按最大轴向距离
   * @param {number} [color=0] paint 笔写入的 RGB565 颜色；高度笔用作高度基色
   * @returns {[x,y,w,h]|null} 受影响矩形（渲染脏区）
   */
  applyBrush(kind, cx, cy, radius, strength, hard = false, shape = 'round', color = 0) {
    const x0 = Math.max(0, Math.floor(cx - radius) - 1);
    const y0 = Math.max(0, Math.floor(cy - radius) - 1);
    const x1 = Math.min(this.w - 1, Math.ceil(cx + radius) + 1);
    const y1 = Math.min(this.h - 1, Math.ceil(cy + radius) + 1);
    // 笔完全落在画布外时没有脏区；负宽高不能交给 putImageData
    if (x0 > x1 || y0 > y1) return null;
    const r2 = radius * radius;
    const square = shape === 'square';

    // 半径 1 是「一格笔刷」：只落指针所在的那一格（格 (x,y) 覆盖 [x,x+1)，中心在 x+0.5）。
    // 不能走距离判据——正交的四个邻居距离正好等于 1，会被一并圈进来，
    // 变成十字形的 5 格，那不是「1 像素」。
    const single = radius <= 1;
    const tx = Math.floor(cx);
    const ty = Math.floor(cy);
    if (single && (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h)) return null;

    const heightKind = kind === 'raise' || kind === 'lower' || kind === 'smooth';
    // 高度笔下真正被改到的格子范围；颜色要等高度全部落定后再按这个范围重算
    let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        let d2;
        if (single) {
          if (x !== tx || y !== ty) continue;
          d2 = 0;
        } else if (square) {
          const ax = Math.abs(dx), ay = Math.abs(dy);
          // 方形笔的边界由切比雪夫距离决定；衰减仍用这个距离，
          // 这样软笔的方形四角会自然变淡，而不是一圈硬角。
          d2 = Math.max(ax * ax, ay * ay);
          if (d2 > r2) continue;
        } else {
          d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
        }
        const i = this.idx(x, y);
        // fall 决定该格影响力度：硬笔=1（半径内全强度），软笔=高斯衰减边缘趋 0
        const fall = hard ? 1 : Math.exp((-4.5 * d2) / Math.max(1e-6, r2));
        if (heightKind) {
          if (kind === 'smooth') {
            const avg = this._neighborAvg(x, y);
            this.height[i] += (avg - this.height[i]) * Math.min(1, strength * 6) * fall;
          } else {
            // 画笔纯累加，不做任何高度 clamp——开发者绝对自由
            this.height[i] += (kind === 'raise' ? 1 : -1) * strength * fall;
          }
          if (x < ax0) ax0 = x;
          if (y < ay0) ay0 = y;
          if (x > ax1) ax1 = x;
          if (y > ay1) ay1 = y;
          continue;
        }
        // 颜色笔按浓度混合到现有颜色里；去色则混合回按高度与坡度生成的地形色。
        // 颜色是独立通道，不动高度。
        const target = kind === 'paint' ? color : this._autoColor565(x, y);
        const alpha = Math.min(1, strength * 10) * fall;
        this.color[i] = blend565(this.color[i], target, alpha);
      }
    }

    // 高度先全部写完，再统一重着色：否则同一次落笔里，先算的格子会读到
    // 一半新、一半旧的邻居高度，坡面颜色随扫描方向偏。
    // 重着色会向外扩一格：边界格自己的高度没变，但邻居变了，坡度也变了。
    if (heightKind && ax0 <= ax1) this._recolorHeightArea(ax0, ay0, ax1, ay1, color);
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  }

  /**
   * 按当前高度重算一片格子的地表色，只写颜色、不碰高度。
   * @param {number} x0 受高度影响的格子范围（含端点）
   * @param {number} color 高度基色（RGB565）
   */
  _recolorHeightArea(x0, y0, x1, y1, color) {
    const rx0 = Math.max(0, x0 - 1);
    const ry0 = Math.max(0, y0 - 1);
    const rx1 = Math.min(this.w - 1, x1 + 1);
    const ry1 = Math.min(this.h - 1, y1 + 1);
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const i = this.idx(x, y);
        // 以平地为基准：平地不改变基色，坡面才在此之上加亮或压暗
        this.color[i] = heightTint565(color, this.height[i], this._shadeAt(x, y) / FLAT_SHADE);
      }
    }
  }

  _neighborAvg(x, y) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        sum += this.height[this.idx(nx, ny)];
        n++;
      }
    }
    return n ? sum / n : this.height[this.idx(x, y)];
  }

  /**
   * 整张网格填成同一个高度与同一种颜色。未指定颜色时按高度生成地形色。
   * 重置为海洋 = fill(-0.45, OCEAN_COLOR)
   */
  fill(value, color = null) {
    this.height.fill(value);
    if (color == null) {
      const c = this._autoColor565(0, 0, value <= 0 ? 1 : 0);
      this.color.fill(c);
    } else {
      this.color.fill(color);
    }
    this.renderColor();
  }

  /**
   * 按当前高度生成一遍地形颜色，用于真实地球这类「原料只有高度/海陆」的初稿。
   * 生成后颜色就是普通数据：之后只有形态笔经过的格子会按高度基色和坡度重算，
   * 颜色笔与 PNG 读取都不会自动改色。
   * @param {Uint8Array|null} [water] 每格 0..255 的水体浓度；省略时按高度正负判海陆
   */
  bakeHeightColors(water = null) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const wet = water ? water[i] / 255 : (this.height[i] <= 0 ? 1 : 0);
        this.color[i] = this._autoColor565(x, y, wet);
      }
    }
    this.renderColor();
  }

  // ---------------------------------------------------------------- 颜色生成

  /**
   * 西北光的坡度明暗：同一高度的山脊与沟槽靠这一项分开。
   * 平地约 0.913，向光的坡面更亮（最高约 1.1），背光的更暗（最低约 0.66）。
   * 梯度按地图宽度归一化，换一档分辨率，同一片地形的明暗看起来一致。
   */
  _shadeAt(x, y) {
    const { w, h, height } = this;
    const k = w * 0.5;
    const hxL = height[this.idx(Math.max(0, x - 1), y)];
    const hxR = height[this.idx(Math.min(w - 1, x + 1), y)];
    const hyD = height[this.idx(x, Math.min(h - 1, y + 1))];
    const hyU = height[this.idx(x, Math.max(0, y - 1))];
    const gx = (hxR - hxL) * k;
    const gy = (hyD - hyU) * k;
    // 光从西北上方来：法线 (-gx, -gy, 1) 点乘光向（范围收敛，避免过暗）
    const shade = (0.45 - gx * 0.55 - gy * 0.55) / Math.sqrt(gx * gx + gy * gy + 1);
    return 0.76 + 0.34 * Math.max(-0.3, Math.min(1, shade));
  }

  /**
   * 按高度、水陆浓度与邻域坡度生成一格地形色。
   * 只在生成初稿和「去色」时使用；平时渲染直接读存储的 color。
   * @param {number} [wet] 0..1；省略时按高度正负判
   */
  _autoColor565(x, y, wet = null) {
    const hh = this.height[this.idx(x, y)];
    const water = wet == null ? (hh <= 0 ? 1 : 0) : wet;
    const shade = this._shadeAt(x, y);

    const [lr, lg, lb] = landColor(hh);
    const t = Math.min(1, Math.max(0, -hh / 0.55));
    const wr = lerp(46, 8, t);
    const wg = lerp(122, 26, t);
    const wb = lerp(160, 66, t);
    const r = lerp(lr, wr, water);
    const g = lerp(lg, wg, water);
    const b = lerp(lb, wb, water);
    // 海平面以下的水是平的海面，不打光；高于海平面的水和陆地一样吃光
    const light = lerp(shade, 1, hh <= 0 ? water : 0);
    return pack565(r * light, g * light, b * light);
  }

  // ---------------------------------------------------------------- 渲染

  /** 重绘颜色画布与高度纹理画布；传 rect=[x,y,w,h] 只重绘脏区 */
  renderColor(rect) {
    const { w, h, height, color } = this;
    const img = this._image;
    const data = img.data;
    const pImg = this._packedImage;
    const pData = pImg.data;
    const x0 = rect ? Math.max(0, rect[0] - 1) : 0;
    const y0 = rect ? Math.max(0, rect[1] - 1) : 0;
    const x1 = rect ? Math.min(w - 1, rect[0] + rect[2] + 1) : w - 1;
    const y1 = rect ? Math.min(h - 1, rect[1] + rect[3] + 1) : h - 1;
    if (x0 > x1 || y0 > y1) return;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = this.idx(x, y);
        const c = color[i];
        const o = i * 4;
        // RGB565 → 8-bit 显示；位重复让 5/6 位满量程正好映射到 255
        const r5 = (c >>> 11) & 0x1f;
        const g6 = (c >>> 5) & 0x3f;
        const b5 = c & 0x1f;
        data[o] = (r5 << 3) | (r5 >>> 2);
        data[o + 1] = (g6 << 2) | (g6 >>> 4);
        data[o + 2] = (b5 << 3) | (b5 >>> 2);
        data[o + 3] = 255;

        // 高度纹理画布：R+G=16-bit 高度，clamp 到编码可逆范围仅在这一步。
        // alpha 固定 255，保证 canvas 的原样上传；颜色只写进 PNG 字节。
        const tEnc = clampN((height[i] - H_MIN) / H_SPAN, 0, 1);
        const u16 = Math.round(tEnc * 65535);
        pData[o] = (u16 >>> 8) & 0xff;
        pData[o + 1] = u16 & 0xff;
        pData[o + 2] = 0;
        pData[o + 3] = 255;
      }
    }
    this.colorCtx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    this.packedCtx.putImageData(pImg, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  // ---------------------------------------------------------------- 采样与编码

  /** 双线性采样高度（不 clamp，返回原始浮点） */
  sample(lat, lng) {
    const gx = ((lng + 180) / 360) * this.w - 0.5;
    const gy = ((90 - lat) / 180) * this.h - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const at = (x, y) => this.height[this.idx(clampI(x, 0, this.w - 1), clampI(y, 0, this.h - 1))];
    return lerp(
      lerp(at(x0, y0), at(x0 + 1, y0), fx),
      lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx),
      fy,
    );
  }

  /**
   * 双线性采样「球面实际渲染出来的高度」：先把四角夹到 PNG 可编码范围，再插值。
   * 渲染用的打包纹理就是逐格 clamp 后上传的，若先插值再夹，
   * 靠近上限的斜坡会采到比球面更高的值，贴地的路线/区域会浮起来。
   */
  sampleClamped(lat, lng) {
    const gx = ((lng + 180) / 360) * this.w - 0.5;
    const gy = ((90 - lat) / 180) * this.h - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const at = (x, y) => clampN(
      this.height[this.idx(clampI(x, 0, this.w - 1), clampI(y, 0, this.h - 1))],
      H_MIN, H_MAX,
    );
    return lerp(
      lerp(at(x0, y0), at(x0 + 1, y0), fx),
      lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx),
      fy,
    );
  }

  /** 双线性重采样到新分辨率；颜色在 RGB565 的各通道上插值 */
  resample(newW, newH) {
    const next = new TerrainGrid(newW, newH);
    for (let y = 0; y < newH; y++) {
      const gy = ((y + 0.5) / newH) * this.h - 0.5;
      for (let x = 0; x < newW; x++) {
        const gx = ((x + 0.5) / newW) * this.w - 0.5;
        const i = y * newW + x;
        next.height[i] = bilinearArray(this.height, this.w, this.h, gx, gy);
        next.color[i] = bilinearColor565(this.color, this.w, this.h, gx, gy);
      }
    }
    next.renderColor();
    return next;
  }

  clone() {
    const g = new TerrainGrid(this.w, this.h);
    g.height.set(this.height);
    g.color.set(this.color);
    g.renderColor();
    return g;
  }

  /** 把另一张栅格的内容拷进来（尺寸不同时先重采样对齐），用于「重置/真实地球」就地替换 */
  copyFrom(other) {
    const src = (other.w !== this.w || other.h !== this.h) ? other.resample(this.w, this.h) : other;
    this.height.set(src.height);
    this.color.set(src.color);
    this.renderColor();
  }

  /** 编码为 PNG dataURL：R+G=16-bit 高度，B+A=RGB565 颜色 */
  encodePNG() {
    const n = this.w * this.h;
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const tEnc = clampN((this.height[i] - H_MIN) / H_SPAN, 0, 1);
      const u16 = Math.round(tEnc * 65535);
      const c = this.color[i];
      const o = i * 4;
      rgba[o] = (u16 >>> 8) & 0xff;
      rgba[o + 1] = u16 & 0xff;
      rgba[o + 2] = (c >>> 8) & 0xff;
      rgba[o + 3] = c & 0xff;
    }
    return encodePngRgba(this.w, this.h, rgba);
  }

  /** 从 PNG dataURL 解码：R+G=16bit 高度，B+A=RGB565 颜色 */
  static async fromPNG(dataUrl) {
    const img = decodePngRgba(dataUrl);
    const grid = new TerrainGrid(img.width, img.height);
    const data = img.data;
    for (let i = 0; i < grid.height.length; i++) {
      const o = i * 4;
      const u16 = (data[o] << 8) | data[o + 1];
      grid.height[i] = (u16 / 65535) * H_SPAN + H_MIN;
      grid.color[i] = (data[o + 2] << 8) | data[o + 3];
    }
    grid.renderColor();
    return grid;
  }
}

// ---------------------------------------------------------------- 颜色工具

/** 8-bit RGB → RGB565，输入按 0..255 处理并按位截断 */
export function pack565(r, g, b) {
  const ri = clampI(Math.round(r), 0, 255) >>> 3;
  const gi = clampI(Math.round(g), 0, 255) >>> 2;
  const bi = clampI(Math.round(b), 0, 255) >>> 3;
  return (ri << 11) | (gi << 5) | bi;
}

/** RGB565 → 8-bit RGB（位重复展开） */
export function unpack565(c) {
  const r5 = (c >>> 11) & 0x1f;
  const g6 = (c >>> 5) & 0x3f;
  const b5 = c & 0x1f;
  return [(r5 << 3) | (r5 >>> 2), (g6 << 2) | (g6 >>> 4), (b5 << 3) | (b5 >>> 2)];
}

/**
 * 地形着色：基色先按高度调明暗，再乘坡度阴影。
 * 高度 0 且平地就是基色，越高越亮、越低越暗；|h|/(|h|+0.5) 软饱和，
 * -4..4 整个设计域都有响应，h=1 与 h=4 不会压成同一种颜色。
 * shade 约 0.72..1.2，1 = 平地、不改变颜色；同一高度、
 * 不同坡向因此会有明暗差别，山脊和沟壑才看得出来。
 *
 * 拆通道直接算，不调用 unpack565/pack565：软笔一次要算十几万格，
 * 每格多一个临时数组就是几十万次分配，拖动时会明显掉帧。
 */
export function heightTint565(base, h, shade = 1) {
  const ah = Math.abs(h);
  const t = Math.sqrt(ah / (ah + 0.5));
  const k = 0.6 * Math.sign(h) * t;
  // k > 0 向白色混，k < 0 向黑色混；strength 统一取绝对值
  const target = k >= 0 ? 255 : 0;
  const strength = Math.abs(k);
  const r5 = (base >>> 11) & 0x1f;
  const g6 = (base >>> 5) & 0x3f;
  const b5 = base & 0x1f;
  // 与 unpack565 相同的位重复展开
  const r8 = (r5 << 3) | (r5 >>> 2);
  const g8 = (g6 << 2) | (g6 >>> 4);
  const b8 = (b5 << 3) | (b5 >>> 2);
  const r = clampI(Math.round((r8 + (target - r8) * strength) * shade), 0, 255);
  const g = clampI(Math.round((g8 + (target - g8) * strength) * shade), 0, 255);
  const b = clampI(Math.round((b8 + (target - b8) * strength) * shade), 0, 255);
  return ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3);
}

/** '#rrggbb' → RGB565；输入不合法时回到海洋色 */
export function hexTo565(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return OCEAN_COLOR;
  const n = parseInt(m[1], 16);
  return pack565((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

/** 在两个 RGB565 颜色之间按 t 混合；直接在各通道上插值，避免反复量化 */
function blend565(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ar = (a >>> 11) & 0x1f, ag = (a >>> 5) & 0x3f, ab = a & 0x1f;
  const br = (b >>> 11) & 0x1f, bg = (b >>> 5) & 0x3f, bb = b & 0x1f;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 11) | (g << 5) | bl;
}

// ---------------------------------------------------------------- 工具函数

function bilinearArray(arr, w, h, gx, gy) {
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const at = (x, y) => arr[clampI(y, 0, h - 1) * w + clampI(x, 0, w - 1)];
  return lerp(
    lerp(at(x0, y0), at(x0 + 1, y0), fx),
    lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx),
    fy,
  );
}

/** RGB565 的双线性采样：先拆通道，再分别插值，最后重新打包 */
function bilinearColor565(arr, w, h, gx, gy) {
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const at = (x, y) => arr[clampI(y, 0, h - 1) * w + clampI(x, 0, w - 1)];
  const c00 = at(x0, y0), c10 = at(x0 + 1, y0);
  const c01 = at(x0, y0 + 1), c11 = at(x0 + 1, y0 + 1);
  const mix = (shift, mask) => Math.round(lerp(
    lerp((c00 >>> shift) & mask, (c10 >>> shift) & mask, fx),
    lerp((c01 >>> shift) & mask, (c11 >>> shift) & mask, fx),
    fy,
  ));
  return (mix(11, 0x1f) << 11) | (mix(5, 0x3f) << 5) | mix(0, 0x1f);
}

/** 陆地色带（hypsometric tint）：绿平原 → 棕山地 → 灰岩 → 雪白（超 1 都算封顶雪白） */
function landColor(h) {
  const stops = [
    [0.00, [124, 149, 88]],
    [0.06, [96, 133, 78]],
    [0.18, [138, 158, 92]],
    [0.32, [156, 148, 96]],
    [0.48, [146, 113, 76]],
    [0.62, [133, 106, 88]],
    [0.75, [150, 145, 140]],
    [0.85, [214, 216, 220]],
    [1.00, [246, 248, 252]],
  ];
  // 陆地可以低于海平面（绿色盆地），色带从最低一档起算，不按符号跳成海色
  if (h <= 0) return stops[0][1];
  if (h >= 1) return stops[stops.length - 1][1];
  for (let s = 0; s < stops.length - 1; s++) {
    if (h <= stops[s + 1][0]) {
      const t = (h - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
      const [r1, g1, b1] = stops[s][1];
      const [r2, g2, b2] = stops[s + 1][1];
      return [lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t)];
    }
  }
  return stops[stops.length - 1][1];
}
