/**
 * 栅格地形引擎：高度网格 + 河流通路 + 画笔 + 色带渲染 + 采样 + PNG 编解码。
 * 高度用「归一化单位」：0 = 海平面，负 = 海洋深度，正 = 陆地海拔，设计范围 [-4, 4]
 * （clamp 仅在写入 PNG/heightCanvas 时保证编码可逆，画笔运算是无 clamp 纯累加）。
 * 画笔支持「软笔（高斯衰减） / 硬笔（方波硬边，不扩散到邻居，可画垂直悬崖）」两种模式。
 * 高度纹理/PNG 编码：R+G 打包 16-bit（[-4,4]），B=河流；
 *   兼容旧 8-bit 格式（R=高度8bit [-1,1], G=河流, B=0）——通过"所有像素 B=0"检测。
 * 纯数据 + canvas，不依赖 three。
 *
 * 只负责「多高」。「是陆是海」是另一份可选数据，见 core/landmask.js——
 * 两者互不认识，真实地球预设也只是把它们拼在一起用。
 */
import { loadImage } from '../utils/files.js';

export const H_MIN = -4;
export const H_MAX = 4;
export const H_SPAN = H_MAX - H_MIN; // 8
export const H_RANGE = 2; // 归一化满量程（-1..1）——仅色带参考范围，不参与 clamp

export class TerrainGrid {
  /**
   * @param {number} w 宽（格子数），对应经度 360°
   * @param {number} h 高，对应纬度 180°
   */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.height = new Float32Array(w * h);
    this.river = new Uint8Array(w * h); // 0 无河，255 最粗
    this.colorCanvas = document.createElement('canvas');
    this.colorCanvas.width = w;
    this.colorCanvas.height = h;
    this.colorCtx = this.colorCanvas.getContext('2d');
    this._image = this.colorCtx.createImageData(w, h);
    this.heightCanvas = document.createElement('canvas');
    this.heightCanvas.width = w;
    this.heightCanvas.height = h;
    this.heightCtx = this.heightCanvas.getContext('2d');
    this._heightImage = this.heightCtx.createImageData(w, h);
    this.renderColor();
  }

  idx(x, y) { return y * this.w + x; }

  // ---------------------------------------------------------------- 画笔

  /**
   * 在格点 (cx, cy) 应用画笔。
   * @param {'raise'|'lower'|'smooth'|'river'} kind
   * @param {number} radius 半径（格）。1 = 只落当前这一格（最小笔刷）
   * @param {number} strength 强度（厚度），raise/lower 为归一化高度增量
   * @param {boolean} [hard=false]  true=硬笔（方波硬边，半径内全 strength，不做高斯扩散）
   * @returns {[x,y,w,h]|null 受影响矩形（渲染脏区）
   */
  applyBrush(kind, cx, cy, radius, strength, hard = false) {
    const x0 = Math.max(0, Math.floor(cx - radius) - 1);
    const y0 = Math.max(0, Math.floor(cy - radius) - 1);
    const x1 = Math.min(this.w - 1, Math.ceil(cx + radius) + 1);
    const y1 = Math.min(this.h - 1, Math.ceil(cy + radius) + 1);
    const r2 = radius * radius;

    // 半径 1 是「一格笔刷」：只落指针所在的那一格（格 (x,y) 覆盖 [x,x+1)，中心在 x+0.5）。
    // 不能走下面 d2 > r2 的判据——正交的四个邻居距离正好等于 1，会被一并圈进来，
    // 变成十字形的 5 格，那不是「1 像素」。
    const single = radius <= 1;
    const tx = Math.floor(cx);
    const ty = Math.floor(cy);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (single ? (x !== tx || y !== ty) : d2 > r2) continue;
        const i = this.idx(x, y);
        // fall 决定该格影响力度：硬笔=1（半径内全强度），软笔=高斯衰减边缘趋 0
        const fall = hard ? 1 : Math.exp((-4.5 * d2) / Math.max(1e-6, r2));
        if (kind === 'raise' || kind === 'lower') {
          // 画笔纯累加，不做任何高度 clamp——开发者绝对自由
          this.height[i] += (kind === 'raise' ? 1 : -1) * strength * fall;
        } else if (kind === 'smooth') {
          const avg = this._neighborAvg(x, y);
          this.height[i] += (avg - this.height[i]) * Math.min(1, strength * 6) * fall;
        } else if (kind === 'river') {
          const v = Math.min(255, this.river[i] + Math.round(255 * Math.min(1, strength * 10) * fall));
          this.river[i] = v;
          this.height[i] -= 0.008 * fall; // 轻微下切出河床
        }
      }
    }
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
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

  /** 全部填海 / 全部填地 */
  fill(value) {
    this.height.fill(value);
    this.river.fill(0);
    this.renderColor();
  }

  // ---------------------------------------------------------------- 渲染（色带 + hillshade + 河流）

  /** 重绘颜色画布；传 rect=[x,y,w,h] 只重绘脏区 */
  renderColor(rect) {
    const { w, h, height, river } = this;
    const img = this._image;
    const data = img.data;
    const hImg = this._heightImage;
    const hData = hImg.data;
    const x0 = rect ? Math.max(0, rect[0] - 1) : 0;
    const y0 = rect ? Math.max(0, rect[1] - 1) : 0;
    const x1 = rect ? Math.min(w - 1, rect[0] + rect[2] + 1) : w - 1;
    const y1 = rect ? Math.min(h - 1, rect[1] + rect[3] + 1) : h - 1;
    // 梯度→明暗的强度系数：格子越多梯度越小，按宽度归一，让不同分辨率观感一致
    const k = w * 0.5;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = this.idx(x, y);
        const hh = height[i];
        // 邻域高度（边界用自身），算梯度
        const hxL = height[this.idx(Math.max(0, x - 1), y)];
        const hxR = height[this.idx(Math.min(w - 1, x + 1), y)];
        const hyD = height[this.idx(x, Math.min(h - 1, y + 1))];
        const hyU = height[this.idx(x, Math.max(0, y - 1))];
        const gx = (hxR - hxL) * k;
        const gy = (hyD - hyU) * k;
        // 光从西北上方来：法线 (-gx, -gy, 1) 点乘光向（范围收敛，避免过暗）
        let shade = (0.45 - gx * 0.55 - gy * 0.55) / Math.sqrt(gx * gx + gy * gy + 1);
        shade = 0.76 + 0.34 * Math.max(-0.3, Math.min(1, shade));

        let r, g, b;
        if (hh <= 0) {
          // 海洋：浅→深
          const t = Math.min(1, -hh / 0.55);
          r = lerp(46, 8, t); g = lerp(122, 26, t); b = lerp(160, 66, t);
          shade = 1; // 海面不打光
        } else {
          // 陆地色带（超 1 的部分全按雪白峰顶算）
          [r, g, b] = landColor(hh);
        }
        const rv = river[i];
        if (rv > 0) {
          const a = Math.min(1, rv / 200);
          r = lerp(r, 52, a); g = lerp(g, 118, a); b = lerp(b, 216, a);
        }
        const o = i * 4;
        data[o] = r * shade;
        data[o + 1] = g * shade;
        data[o + 2] = b * shade;
        data[o + 3] = 255;
        // 写入高度纹理：R+G 打包 16-bit，clamp 到编码可逆范围仅在这一步
        const tEnc = clampN((hh - H_MIN) / H_SPAN, 0, 1);
        const u16 = Math.round(tEnc * 65535);
        hData[o] = (u16 >>> 8) & 0xff;
        hData[o + 1] = u16 & 0xff;
        hData[o + 2] = river[i];
        hData[o + 3] = 255;
      }
    }
    this.colorCtx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    this.heightCtx.putImageData(hImg, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
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

  /** 双线性重采样到新分辨率 */
  resample(newW, newH) {
    const next = new TerrainGrid(newW, newH);
    for (let y = 0; y < newH; y++) {
      const gy = ((y + 0.5) / newH) * this.h - 0.5;
      for (let x = 0; x < newW; x++) {
        const gx = ((x + 0.5) / newW) * this.w - 0.5;
        const v = bilinearArray(this.height, this.w, this.h, gx, gy);
        next.height[y * newW + x] = v;
        next.river[y * newW + x] = bilinearArray(this.river, this.w, this.h, gx, gy);
      }
    }
    next.renderColor();
    return next;
  }

  clone() {
    const g = new TerrainGrid(this.w, this.h);
    g.height.set(this.height);
    g.river.set(this.river);
    g.renderColor();
    return g;
  }

  /** 把另一张栅格的内容拷进来（尺寸不同时先重采样对齐），用于「重置/真实地球」就地替换 */
  copyFrom(other) {
    const src = (other.w !== this.w || other.h !== this.h) ? other.resample(this.w, this.h) : other;
    this.height.set(src.height);
    this.river.set(src.river);
    this.renderColor();
  }

  /** 海洋占比（诊断用） */
  oceanRatio() {
    let n = 0;
    for (let i = 0; i < this.height.length; i++) if (this.height[i] <= 0) n++;
    return n / this.height.length;
  }

  /** 编码为 PNG dataURL：R+G=16-bit 高度（[-4,4]），B=河流 */
  encodePNG() {
    const cv = document.createElement('canvas');
    cv.width = this.w; cv.height = this.h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(this.w, this.h);
    for (let i = 0; i < this.height.length; i++) {
      const tEnc = clampN((this.height[i] - H_MIN) / H_SPAN, 0, 1);
      const u16 = Math.round(tEnc * 65535);
      const o = i * 4;
      img.data[o] = (u16 >>> 8) & 0xff;
      img.data[o + 1] = u16 & 0xff;
      img.data[o + 2] = this.river[i];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }

  /** 从 PNG dataURL 解码（新格式 R+G=16bit 高度 B=河流；兼容旧格式 R=8bit 高度 G=河流 B=0） */
  static async fromPNG(dataUrl) {
    const img = await loadImage(dataUrl);
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const grid = new TerrainGrid(img.width, img.height);
    let legacyV0 = true;
    const n = grid.height.length;
    for (let i = 0; i < n; i++) {
      if (data[i * 4 + 2] !== 0) { legacyV0 = false; break; }
    }
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (legacyV0) {
        grid.height[i] = (data[o] / 255) * 2 - 1;
        grid.river[i] = data[o + 1];
      } else {
        const u16 = (data[o] << 8) | data[o + 1];
        grid.height[i] = (u16 / 65535) * H_SPAN + H_MIN;
        grid.river[i] = data[o + 2];
      }
    }
    grid.renderColor();
    return grid;
  }

}

// ---------------------------------------------------------------- 工具函数

const lerp = (a, b, t) => a + (b - a) * t;
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
const clampI = (v, a, b) => (v < a ? a : v > b ? b : v);

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
  if (h <= 0) return [124, 149, 88];
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
