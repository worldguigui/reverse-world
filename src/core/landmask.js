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
   * 从蒙版图构建。图会先缩放到 w×h（用画布的高质量缩放，等同于盒式滤波）。
   * @param {string} dataUrl
   * @param {object} [opts]
   * @param {number} [opts.w] 目标宽（格），默认用图自身的宽
   * @param {number} [opts.h] 目标高（格），默认用图自身的高
   * @param {number} [opts.threshold=0.5] 亮度阈值
   * @param {'auto'|'white'|'black'} [opts.polarity='auto'] 哪一侧是陆地。
   *   auto = 取少数派为陆地（地球陆地约占 29%，海洋占多数）。
   *
   * 掩膜自己保有自己的分辨率（默认就是图的分辨率），采样到栅格分辨率的事交给
   * isLand()——它是「多数表决」而不是「最近邻」，栅格比掩膜粗时小岛才不会被丢。
   */
  static async fromImage(dataUrl, { w, h, threshold = 0.5, polarity = 'auto' } = {}) {
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

    return new LandMask(w, h, land);
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
