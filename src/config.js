/**
 * 画面设置（区别于「世界观数据」——那些存在项目文件里）。
 * 这里只管渲染观感：视角、光照、大气、星空、球面标记的尺寸。
 * localStorage 持久化，所有 GUI/API 修改的都是同一个 config 对象。
 */

/** 星星数量的取值范围：设置面板滑块与存档载入共用，改这里一处即可 */
export const STARS_COUNT_MIN = 0;
export const STARS_COUNT_MAX = 1999;

/**
 * 球面网格精度的四档（宽度段数）。
 * 256 给低端设备兜底；512 是默认；2048 才能与 2048×1024 的高度图一一对应。
 * 实际段数还会受地图宽度限制，见 view/globe.js。
 */
export const TERRAIN_MESH_SEGMENTS = [256, 512, 1024, 2048];

/**
 * 配图上传：长边压到这么多像素；源文件超过这个体积时直接拒收，不读入内存。
 * 输出 WebP：照片类体积接近 JPEG，又能保留透明通道，无背景的图标不会被迫铺底。
 */
export const IMAGE_UPLOAD = {
  maxSide: 128,
  maxBytes: 100 * 1024 * 1024,
  format: 'image/webp',
  quality: 0.82,
};

export const DEFAULT_CONFIG = {
  camera: {
    // 出厂镜头的视场角。设置面板不再改它：现在滑块和滚轮共用「档位」，
    // 档位 1 就落在这个视场角上，往后再由推近相机与收窄镜头接着放大。
    fov: 45,
    lon: 105,          // 初始视角经度
    lat: 30,
    distance: 3.0,     // 相机到球心距离（球半径 = 1）
    // 最近档：再近地形就开始糊。屏幕上一个地形格约占 3.33 / (距离 - 1) 像素，
    // 1.25 时约 13 像素，山形仍分得清；高度纹理是 2048 宽、赤道约 20km 一格
    minDistance: 1.25,
    maxDistance: 8,
    // 点开一条事件时镜头落在哪一档（档位 = 画面相对出厂视角的放大倍数）。
    // 8 就是相机推到最近档、视场角还是出厂那个，赤道上每度约 76 像素、一个地形纹素约 13 像素
    // ——正好是那张 2048 高度图还清楚的最大一屏。调大画面更近，代价是地形开始糊，上限 64。
    eventLevel: 8,
  },
  rotation: {
    enabled: true,
    speed: 0.5,        // 相机环绕速度 °/s
  },
  light: {
    key: 1.4,          // 主光（固定方向，给球体一点立体感）
    ambient: 0.8,      // 环境光，保证整张地图可读
  },
  terrain: {
    exaggeration: 0.06, // 地形夸张系数：真实山峰/半径太小，视觉上必须放大
    // 球面网格宽度段数上限：256 极低 / 512 流畅 / 1024 标准 / 2048 精细
    meshSegments: 512,
  },
  atmosphere: {
    enabled: true,
    color: '#5d8bff',  // 异世界可以换成绿/紫
    strength: 1.1,
  },
  stars: { enabled: true, count: STARS_COUNT_MAX },
  markers: {
    dotPx: 18,         // 选中事件那个光点的直径（像素）
    routeWidth: 3,     // 路线像素宽度
    fillOpacity: 0.14, // 区域填充不透明度：只给地形蒙一层很淡的灰金
  },
};

const STORAGE_KEY = 'worldbuilding:view-config';

/**
 * 这几项由代码决定，设置面板改不了，因此也不进存档。
 * 若存下来再合并，改了代码却不生效，看起来像没改。
 */
const CODE_OWNED_CAMERA = ['fov', 'minDistance', 'maxDistance'];

export function loadViewConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) mergeInto(config, JSON.parse(saved));
  } catch { /* 忽略坏数据 */ }
  // 镜头这几项永远以代码为准，与存档里有没有它们无关
  for (const key of CODE_OWNED_CAMERA) config.camera[key] = DEFAULT_CONFIG.camera[key];
  // 存档里的数量夹回当前允许的范围
  config.stars.count = Math.min(
    STARS_COUNT_MAX,
    Math.max(STARS_COUNT_MIN, Math.round(config.stars.count)),
  );
  // 网格精度只认预设档位，存档里被改坏就回到默认
  if (!TERRAIN_MESH_SEGMENTS.includes(config.terrain.meshSegments)) {
    config.terrain.meshSegments = DEFAULT_CONFIG.terrain.meshSegments;
  }
  return config;
}

export function saveViewConfig(config) {
  try {
    const saved = structuredClone(config);
    for (const key of CODE_OWNED_CAMERA) delete saved.camera[key];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch { /* 存不下就算了 */ }
}

/** 深合并：把 patch 合入 target（只合并普通对象，其余直接覆盖），返回 target 本身 */
export function mergeInto(target, patch) {
  for (const key of Object.keys(patch)) {
    const p = patch[key];
    if (p && typeof p === 'object' && !Array.isArray(p) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeInto(target[key], p);
    } else {
      target[key] = p;
    }
  }
  return target;
}
