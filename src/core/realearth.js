import { TerrainGrid } from './raster.js';
import { LandMask } from './landmask.js';
import { loadImage } from '../utils/files.js';
import { addItem } from './project.js';

/**
 * 真实地球数据管线：三份数据各自成层，谁也不认识谁。
 *   高程图  → TerrainGrid.height（多高）
 *   海陆掩膜 → 哪一格是陆地、离岸多远（是陆是海）
 *   河网 / 城市 → 河流通道与地点标注
 * 「高程 + 海陆」在这里合成，但两边都不需要知道对方：raster 只认高度数值，
 * landmask 只认二值海陆，换掉任意一份都不牵动另一份，也不牵动渲染。
 * 数据文件在 public/data/、public/textures/（Natural Earth / three-globe，公共领域）。
 */

const TOPO_URL = 'textures/earth-topology.png';
const WATER_URL = 'textures/earth-water.png';
const RIVERS_URL = 'data/ne_50m_rivers.geojson';
const CITIES_URL = 'data/ne_110m_populated_places.geojson';

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
 * 真实地球栅格：高程图与海陆掩膜各自解码 → 合成高度 → 河流栅格化。
 * 合成直接在目标分辨率上做，不再「先按原图建好再重采样」——
 * 重采样会把陆地最低高度和旁边海水的深度掺在一起，沿海又变回水下。
 */
export async function buildRealEarthGrid(resolution = 512) {
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
  const k = grid.w / 512; // 宽度随分辨率缩放
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

/** 折线刷进 river 通道：相邻经纬点之间插值步进，逐点盖圆章 */
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
      stampCircle(grid.river, grid.w, grid.h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius);
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

/**
 * Natural Earth 城市点 → 普通地点标注（复用标注/检查器全套能力）。
 * 一座城市几千年都在那儿，所以不带时间——它们是常驻地点，与游标无关。
 */
export async function importCitiesAsEntries(project, { minPop = 0 } = {}) {
  const geo = await fetch(CITIES_URL).then((r) => r.json());
  let n = 0;
  for (const feature of geo.features) {
    const p = feature.properties ?? {};
    const pop = p.pop_max ?? 0;
    if (pop < minPop) continue;
    const [lng, lat] = feature.geometry?.coordinates ?? [];
    if (lat == null) continue;
    addItem(project, 'entry', {
      title: p.name ?? '无名城',
      description: `${p.featurecla ?? ''}${pop ? ` · 人口约 ${fmtPop(pop)}` : ''}`,
      lat, lng,
    });
    n++;
  }
  return n;
}

function fmtPop(pop) {
  return pop >= 1e6 ? `${(pop / 1e6).toFixed(1)}百万` : `${Math.round(pop / 1e4)}万`;
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
