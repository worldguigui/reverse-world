import { TerrainGrid, H_MIN, H_SPAN } from './raster.js';
import { LandMask } from './landmask.js';
import { loadImage } from '../utils/files.js';

/**
 * 真实地球数据管线：两张原料图合成初稿。
 *   高程图  → TerrainGrid.height（海陆同一个数，含海底）
 *   海陆掩膜 → 临时的 water 掩膜，只用来决定初稿哪里是水色
 * 河网随后也只往这张临时掩膜上盖窄条，不碰高度。
 * 最后把高度、水陆与坡度烘焙成 RGB565 颜色存进栅格；之后颜色就是普通数据。
 * 数据文件在 public/textures/、public/data/（Terrarium / Natural Earth，公共领域）。
 */

const RELIEF_URL = 'textures/earth-relief.png';
const WATER_URL = 'textures/earth-water.png';
const RIVERS_URL = 'data/ne_50m_rivers.geojson';

/**
 * 全局地形的栅格宽度（格）；高度取它的一半，经纬 360° 对 180°。
 *
 * 取的就是高程源图自己的尺寸：public/textures/earth-relief.png 是 2048×1024，
 * 按这个数建栅格是 1:1 读图，赤道上约 20km 一格。
 * 全项目只认这一个数：示例世界、菜单里的「生成真实地球」、工坊里的「真实地球」
 * 都从这里取，免得三处各写一个数、改一处漏两处。
 */
export const EARTH_RES = 2048;

/** 河流宽度的基准栅格宽度：下面的基础宽度是在这个宽度上调出来的，别处按比例缩放 */
const RIVER_REF_W = 512;

/**
 * 真实地球栅格：高程图直接当高度，海陆掩膜只决定初稿的水色，河流盖进同一张临时掩膜。
 *
 * @param {number} resolution 栅格宽度
 * @param {(detail: string, progress: number) => Promise<void>|void} [onProgress]
 *   每进入一个阶段回报一次。回调是 await 的：加载页要在两阶段之间取得一帧，
 *   否则主线程一路跑到底，进度条只会从 0 直接跳到 100。
 */
export async function buildRealEarthGrid(resolution = EARTH_RES, onProgress) {
  const w = resolution;
  const h = Math.round(resolution / 2);
  await onProgress?.('读取高程与水陆数据…', 0.05);
  const [relief, mask] = await Promise.all([
    loadRelief(RELIEF_URL, w, h),
    LandMask.fromImage(WATER_URL),
  ]);
  await onProgress?.('计算海陆边界…', 0.38);
  const grid = new TerrainGrid(w, h);
  grid.height.set(relief); // 海陆同一个数：海底就是负高度，不再另算
  // 水陆只是生成初稿时的输入；栅格本身只存高度与最终颜色
  const water = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    for (let x = 0; x < w; x++) {
      water[y * w + x] = mask.isLand(lat, ((x + 0.5) / w) * 360 - 180) ? 0 : 255;
    }
  }
  await onProgress?.('绘制河流…', 0.7);
  await rasterizeRivers(grid, water);
  await onProgress?.('生成地形颜色…', 0.86);
  grid.bakeHeightColors(water);
  await onProgress?.('地图数据准备完成', 1);
  return grid;
}

/**
 * 高程图 → 每格归一化高度。R+G 是 16-bit 无符号，按与着色器相同的 [-4,4] 解码。
 * 需要缩小时先在原图上解出浮点高度再盒式平均；直接让画布缩放 R/G 两个字节，
 * 会在进位处把 16 位数混错（0x00FF 与 0x0100 平均不出 0x00FF）。
 */
async function loadRelief(url, w, h) {
  const img = await loadImage(await fetchAsDataUrl(url));
  const nw = img.width;
  const nh = img.height;
  const cv = document.createElement('canvas');
  cv.width = nw; cv.height = nh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, nw, nh).data;
  const native = new Float32Array(nw * nh);
  for (let i = 0; i < native.length; i++) {
    const o = i * 4;
    const u16 = (data[o] << 8) | data[o + 1];
    native[i] = (u16 / 65535) * H_SPAN + H_MIN;
  }
  if (nw === w && nh === h) return native;
  return resampleBox(native, nw, nh, w, h);
}

/** 盒式重采样（主要给缩小用；放大时退化成最近邻） */
function resampleBox(src, sw, sh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y / h) * sh);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil(((y + 1) / h) * sh)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x / w) * sw);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil(((x + 1) / w) * sw)));
      let sum = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += src[sy * sw + sx];
          n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/** Natural Earth 河流 → 河流通路（只留干流，跳过湖中线；细活留给用户的画笔） */
export async function rasterizeRivers(grid, water) {
  const geo = await fetch(RIVERS_URL).then((r) => r.json());
  const k = grid.w / RIVER_REF_W; // 宽度随分辨率缩放
  for (const feature of geo.features) {
    if (feature.properties?.featurecla === 'Lake Centerline') continue;
    const rank = feature.properties?.scalerank ?? 9;
    if (rank > 4) continue; // 只留干流：NE 50m 的支流在低分辨率下会糊成一片
    const width = Math.max(0.55, (rank <= 2 ? 0.9 : 0.65) * k);
    const lines = feature.geometry?.type === 'LineString'
      ? [feature.geometry.coordinates]
      : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
    for (const line of lines) {
      stampPolyline(water, grid.w, grid.h, line, width);
    }
  }
}

/** 折线刷进临时水掩膜：相邻经纬点之间插值步进，逐点盖圆章。河流只是窄一点的海洋 */
function stampPolyline(water, w, h, coords, radius) {
  const toCell = ([lng, lat]) => [
    ((lng + 180) / 360) * w,
    ((90 - lat) / 180) * h,
  ];
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = toCell(coords[i - 1]);
    const [x1, y1] = toCell(coords[i]);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (radius * 0.6)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stampCircle(water, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius);
    }
  }
}

function stampCircle(channel, w, h, cx, cy, radius) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) {
        channel[y * w + x] = 255;
      }
    }
  }
}

async function fetchAsDataUrl(url) {
  const blob = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
    return r.blob();
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('数据文件读取失败'));
    reader.readAsDataURL(blob);
  });
}
