/**
 * 栅格地形引擎：高度 + 水的双通道网格，加上画笔、色带渲染、采样与 PNG 编解码。
 * 两个通道互相独立，谁也不再由谁推导：
 *   height  多高（归一化单位，设计范围 [-4, 4]）——只决定球面几何
 *   water   水有多满（0..255）——只决定颜色
 * 高度 0.8 + 水 255 就是一座蓝色的高山；高度 -0.2 + 水 0 就是一个绿色盆地。
 * 水用连续值而不是开关：海洋是 255，河流的软边可以是 80、40，线才不会锯成台阶。
 *
 * 画笔支持「软笔（高斯衰减） / 硬笔（方波硬边，不扩散到邻居，可画垂直悬崖）」两种模式。
 * PNG 编码：R+G 打包 16-bit 高度，B=水，alpha 留空。编码与解码是同一套通道约定。
 * 纯数据 + canvas，不依赖 three。
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
    this.water = new Uint8Array(w * h); // 0 = 陆地，255 = 满水
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
   * 在格点 (cx, cy) 应用画笔。每支笔只碰自己的通道：
   *   raise / lower / smooth → height
   *   water / dry            → water
   * @param {'raise'|'lower'|'smooth'|'water'|'dry'} kind
   * @param {number} radius 半径（格）。1 = 只落当前这一格（最小笔刷）
   * @param {number} strength 强度（厚度）：高度笔是归一化高度增量，水笔是水的增量
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
        } else if (kind === 'water' || kind === 'dry') {
          // 水笔只写水通道，不动高度：想画平的海就再拿压低笔，两件事各管各的
          const delta = Math.round(255 * Math.min(1, strength * 10) * fall);
          const v = this.water[i] + (kind === 'water' ? delta : -delta);
          this.water[i] = v < 0 ? 0 : v > 255 ? 255 : v;
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

  /** 整张网格填成同一个高度与同一个水量。重置为海洋 = fill(-0.45, 255) */
  fill(value, waterValue = 0) {
    this.height.fill(value);
    this.water.fill(waterValue);
    this.renderColor();
  }

  // ---------------------------------------------------------------- 渲染（色带 + hillshade + 水色）

  /** 重绘颜色画布；传 rect=[x,y,w,h] 只重绘脏区 */
  renderColor(rect) {
    const { w, h, height, water } = this;
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

        // 陆地色与水的颜色各算一份，再按水的浓度混合。
        // 水越低于海平面越深；高于海平面的水保持最浅的一档，靠光影表现形状。
        const [lr, lg, lb] = landColor(hh);
        const t = Math.min(1, Math.max(0, -hh / 0.55));
        const wr = lerp(46, 8, t);
        const wg = lerp(122, 26, t);
        const wb = lerp(160, 66, t);
        const wet = water[i] / 255;
        const r = lerp(lr, wr, wet);
        const g = lerp(lg, wg, wet);
        const b = lerp(lb, wb, wet);
        // 海平面以下的水是平的海面，不打光；高于海平面的水和陆地一样吃光
        const light = lerp(shade, 1, hh <= 0 ? wet : 0);

        const o = i * 4;
        data[o] = r * light;
        data[o + 1] = g * light;
        data[o + 2] = b * light;
        data[o + 3] = 255;
        // 写入高度纹理：R+G 打包 16-bit，clamp 到编码可逆范围仅在这一步
        const tEnc = clampN((hh - H_MIN) / H_SPAN, 0, 1);
        const u16 = Math.round(tEnc * 65535);
        hData[o] = (u16 >>> 8) & 0xff;
        hData[o + 1] = u16 & 0xff;
        hData[o + 2] = water[i];
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
        next.water[y * newW + x] = bilinearArray(this.water, this.w, this.h, gx, gy);
      }
    }
    next.renderColor();
    return next;
  }

  clone() {
    const g = new TerrainGrid(this.w, this.h);
    g.height.set(this.height);
    g.water.set(this.water);
    g.renderColor();
    return g;
  }

  /** 把另一张栅格的内容拷进来（尺寸不同时先重采样对齐），用于「重置/真实地球」就地替换 */
  copyFrom(other) {
    const src = (other.w !== this.w || other.h !== this.h) ? other.resample(this.w, this.h) : other;
    this.height.set(src.height);
    this.water.set(src.water);
    this.renderColor();
  }

  /** 水的占比（诊断用） */
  oceanRatio() {
    let n = 0;
    for (let i = 0; i < this.water.length; i++) if (this.water[i] > 127) n++;
    return n / this.water.length;
  }

  /** 编码为 PNG dataURL：R+G=16-bit 高度（[-4,4]），B=水 */
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
      img.data[o + 2] = this.water[i];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }

  /** 从 PNG dataURL 解码：R+G=16bit 高度，B=水 */
  static async fromPNG(dataUrl) {
    const img = await loadImage(dataUrl);
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const grid = new TerrainGrid(img.width, img.height);
    for (let i = 0; i < grid.height.length; i++) {
      const o = i * 4;
      const u16 = (data[o] << 8) | data[o + 1];
      grid.height[i] = (u16 / 65535) * H_SPAN + H_MIN;
      grid.water[i] = data[o + 2];
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
