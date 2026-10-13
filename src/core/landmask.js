/**
 * 海陆掩膜：一张可选的二值图，只回答「这一格是陆地还是海洋」。
 *
 * 为什么与高程分开：两者来源、精度、有无都不一样。真实地球预设同时拿得到
 * ETOPO 高程图和海陆蒙版；用户手画的世界只有高程（画到哪算哪），没有蒙版。
 * 所以掩膜不塞进 TerrainGrid，而是独立成一层——用不用它由调用方决定，
 * 没有它的世界一切照旧（TerrainGrid 不知道掩膜的存在）。
 *
 * 图像约定：白 = 陆地，黑 = 海洋。不依赖 three，也不知道自己会被拿去干嘛。
 */
import { loadImage } from '../utils/files.js';

/** 从一张蒙版图构建掩膜 */
export class LandMask {
  /**
   * @param {number} w 宽（格），对应经度 360°
   * @param {number} h 高，对应纬度 180°
   * @param {Uint8Array} [land] 长度 w*h，1=陆地 0=海洋
   */
  constructor(w, h, land) {
    this.w = w;
    this.h = h;
    this.land = land ?? new Uint8Array(w * h);
  }

  /** 越界按边缘取值 */
  get(x, y) {
    const cx = x < 0 ? 0 : x >= this.w ? this.w - 1 : x;
    const cy = y < 0 ? 0 : y >= this.h ? this.h - 1 : y;
    return this.land[cy * this.w + cx];
  }

  /**
   * 双线性采样后按半数表决。降采样到栅格分辨率时用「多数」而不是「最近邻」，
   * 小岛与窄海峡不会被随手丢或随手堵。
   */
  isLand(lat, lng) {
    const gx = ((lng + 180) / 360) * this.w - 0.5;
    const gy = ((90 - lat) / 180) * this.h - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const v = lerp(
      lerp(this.get(x0, y0), this.get(x0 + 1, y0), fx),
      lerp(this.get(x0, y0 + 1), this.get(x0 + 1, y0 + 1), fx),
      fy,
    );
    return v >= 0.5;
  }

  landRatio() {
    let n = 0;
    for (let i = 0; i < this.land.length; i++) n += this.land[i];
    return n / this.land.length;
  }

  /**
   * 每格到最近陆地的距离（单位：格），陆地本身为 0。
   * 倒角距离变换两趟扫描近似欧氏距离：真实地球预设拿它给海洋分大陆架深浅——
   * 高程图在海上没有信息（纯黑），离岸多远是唯一可用的深度线索。
   * @returns {Float32Array}
   */
  distanceToLand() {
    const { w, h, land } = this;
    const d = new Float32Array(w * h);
    const INF = 1e9;
    for (let i = 0; i < d.length; i++) d[i] = land[i] ? 0 : INF;
    const D1 = 1, D2 = Math.SQRT2;
    // 正向：左上 → 右下
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + D1);
        if (y > 0) v = Math.min(v, d[i - w] + D1);
        if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + D2);
        if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + D2);
        d[i] = v;
      }
    }
    // 反向：右下 → 左上
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x < w - 1) v = Math.min(v, d[i + 1] + D1);
        if (y < h - 1) v = Math.min(v, d[i + w] + D1);
        if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + D2);
        if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + D2);
        d[i] = v;
      }
    }
    return d;
  }

  /**
   * 从蒙版图构建。图会先缩放到 w×h（用画布的高质量缩放，等同于盒式滤波）。
   * @param {string} dataUrl
   * @param {object} [opts]
   * @param {number} [opts.w] 目标宽（格），默认用图自身的宽
   * @param {number} [opts.h] 目标高（格），默认用图自身的高
   * @param {number} [opts.threshold=0.5] 亮度阈值
   * @param {'auto'|'white'|'black'} [opts.polarity='auto'] 哪一侧是陆地。
   *   auto = 取少数派为陆地（地球陆地约占 29%，海洋占多数）。
   * @param {number} [opts.grow=0] 陆地向外扩的格数
   *
   * 掩膜自己保有自己的分辨率（默认就是图的分辨率），采样到栅格分辨率的事交给
   * isLand()——它是「多数表决」而不是「最近邻」，栅格比掩膜粗时小岛才不会被丢。
   */
  static async fromImage(dataUrl, { w, h, threshold = 0.5, polarity = 'auto', grow = 0 } = {}) {
    const img = await loadImage(dataUrl);
    w = Math.max(2, Math.round(w ?? img.width));
    h = Math.max(2, Math.round(h ?? img.height));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const n = w * h;
    const lum = new Float32Array(n);
    let bright = 0;
    for (let i = 0; i < n; i++) {
      const v = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
      lum[i] = v;
      if (v >= threshold) bright++;
    }
    const whiteIsLand = polarity === 'auto' ? bright / n < 0.5 : polarity === 'white';

    const land = new Uint8Array(n);
    for (let i = 0; i < n; i++) land[i] = (lum[i] >= threshold) === whiteIsLand ? 1 : 0;

    const mask = new LandMask(w, h, land);
    for (let i = 0; i < grow; i++) mask._grow();
    return mask;
  }

  /**
   * 陆地外扩一格（3×3 八邻域取最大）。用途有两个：
   * 一是抹掉原图在陆地上画的细河线（降采样后它们会变成一串「内陆海」）；
   * 二是让紧贴海岸的城市（上海、伦敦、纽约）落在陆地上而不是水面上——
   * 1024 宽时一格才 0.35°，外扩一格在球面上看不出来。
   */
  _grow() {
    const { w, h, land } = this;
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const above = Math.max(0, y - 1) * w;
        const here = y * w;
        const below = Math.min(h - 1, y + 1) * w;
        const left = Math.max(0, x - 1);
        const right = Math.min(w - 1, x + 1);
        next[here + x] = (
          land[above + left] || land[above + x] || land[above + right] ||
          land[here + left] || land[here + x] || land[here + right] ||
          land[below + left] || land[below + x] || land[below + right]
        ) ? 1 : 0;
      }
    }
    this.land = next;
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
