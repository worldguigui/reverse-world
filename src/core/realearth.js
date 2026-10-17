import { TerrainGrid } from './raster.js';
import { LandMask } from './landmask.js';
import { loadImage } from '../utils/files.js';

/**
 * 真实地球数据管线：三份原料各自成层，谁也不认识谁。
 *   高程图  → TerrainGrid.height（多高）
 *   海陆掩膜 → 合成时写进 water（哪里有水）
 *   河网     → 也写进 water（河流就是一条窄水）
 * 「高度取海拔、水取掩膜」在这里合成；河流随后盖上去。landmask 只认二值海陆，
 * 换掉任意一份都不牵动另一份，也不牵动渲染。
 * 数据文件在 public/data/、public/textures/（Natural Earth / three-globe，公共领域）。
 */

const TOPO_URL = 'textures/earth-topology.png';
const WATER_URL = 'textures/earth-water.png';
const RIVERS_URL = 'data/ne_50m_rivers.geojson';

/**
 * 真实地球预设的地形成色参数。只属于这一份预设——用户手画的世界不走这里，
 * 渲染管线（夸张系数、色带、顶点位移）也一概不读它。
 */
const PRESET = {
  elevFull: 255,     // 高程图满量程灰度（0 = 海平面，255 ≈ 最高峰）
  landBias: 0.04,    // 高程色带里当作「海平面」的灰度，低于它的一律抹平
  landFloor: 0.05,   // 陆地最低高度：源图里海拔低于约 35m 的地方是纯黑像素，
                     //   不给下限的话上海、开罗、伦敦会跟着一起沉进海里
  shoreDepth: 0.08,  // 紧岸浅水
  oceanDepth: 0.45,  // 深海
  shelfDiv: 64,      // 大陆架宽度 ≈ 栅格宽 / 这个数（分辨率无关）
  growCells: 1,      // 海陆掩膜外扩格数（抹掉图上的细河线 + 保住沿海城市）
};

/**
 * 全局地形的栅格宽度（格）；高度取它的一半，经纬 360° 对 180°。
 *
 * 取的就是源图自己的尺寸：public/textures/earth-topology.png 是 2048×1024，
 * 按这个数建栅格是 1:1 读图，不多占也不浪费，赤道上约 20km 一格。
 * 再往上没有意义——源图里没有更多信息，放大只会让 PNG 与导出的 .world.json 一起发胖。
 *
 * 全项目只认这一个数：示例世界、菜单里的「生成真实地球」、工坊里的「真实地球」
 * 都从这里取，免得三处各写一个数、改一处漏两处。
 */
export const EARTH_RES = 2048;

/** 河流宽度的基准栅格宽度：下面的基础宽度是在这个宽度上调出来的，别处按比例缩放 */
const RIVER_REF_W = 512;

/**
 * 真实地球栅格：高程图与海陆掩膜各自解码 → 合成高度 → 河流栅格化。
 * 合成直接在目标分辨率上做，不再「先按原图建好再重采样」——
 * 重采样会把陆地最低高度和旁边海水的深度掺在一起，沿海又变回水下。
 */
export async function buildRealEarthGrid(resolution = EARTH_RES) {
  const w = resolution;
  const h = Math.round(resolution / 2);
  const [elev, mask] = await Promise.all([
    loadElevation(TOPO_URL, w, h),
    LandMask.fromImage(WATER_URL, { grow: PRESET.growCells }),
  ]);
  const grid = composeTerrain(elev, mask, w, h);
  await rasterizeRivers(grid);
  grid.renderColor();
  return grid;
}

/** 高程图 → 每格亮度 [0,1]（按目标分辨率做盒式降采样，正好落在格心上） */
async function loadElevation(url, w, h) {
  const img = await loadImage(await fetchAsDataUrl(url));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / PRESET.elevFull;
  }
  return out;
}

/** 高程 + 海陆 → TerrainGrid：陆地取海拔（带下限），海洋按离岸距离分深浅 */
function composeTerrain(elev, mask, w, h) {
  const grid = new TerrainGrid(w, h);
  const land = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    for (let x = 0; x < w; x++) {
      land[y * w + x] = mask.isLand(lat, ((x + 0.5) / w) * 360 - 180) ? 1 : 0;
    }
  }
  // 高程图在海上没有信息（纯黑），离岸多远是唯一可用的深度线索
  const dist = new LandMask(w, h, land).distanceToLand();
  const shelf = Math.max(4, Math.round(w / PRESET.shelfDiv));
  for (let i = 0; i < grid.height.length; i++) {
    grid.height[i] = land[i]
      ? landHeight(elev[i])
      : -lerp(PRESET.shoreDepth, PRESET.oceanDepth, smoothstep(Math.min(1, dist[i] / shelf)));
    // 水陆是独立的另一张表：这里只按掩膜写满水，不回头从高度符号推导
    grid.water[i] = land[i] ? 0 : 255;
  }
  grid.renderColor();
  return grid;
}

/** 陆地高度：沿用原有色带标定（灰度 0.04 起算、1.0 封顶），只多一个下限 */
function landHeight(elev) {
  const t = (elev - PRESET.landBias) / (1 - PRESET.landBias);
  return t < PRESET.landFloor ? PRESET.landFloor : t > 1 ? 1 : t;
}

/** Natural Earth 河流 → 河流通路（只留干流，跳过湖中线；细活留给用户的画笔） */
export async function rasterizeRivers(grid) {
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
      stampPolyline(grid, line, width);
    }
  }
}

/** 折线刷进水通道：相邻经纬点之间插值步进，逐点盖圆章。河流只是窄一点的海洋 */
function stampPolyline(grid, coords, radius) {
  const toCell = ([lng, lat]) => [
    ((lng + 180) / 360) * grid.w,
    ((90 - lat) / 180) * grid.h,
  ];
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = toCell(coords[i - 1]);
    const [x1, y1] = toCell(coords[i]);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (radius * 0.6)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stampCircle(grid.water, grid.w, grid.h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius);
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

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

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
