/**
 * 画面设置（区别于「世界观数据」——那些存在项目文件里）。
 * 这里只管渲染观感：视角、光照、大气、星空、球面标记的尺寸。
 * localStorage 持久化，所有 GUI/API 修改的都是同一个 config 对象。
 */

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
  },
  atmosphere: {
    enabled: true,
    color: '#5d8bff',  // 异世界可以换成绿/紫
    strength: 1.1,
  },
  stars: { enabled: true, count: 4000 },
  markers: {
    dotPx: 18,         // 选中事件那个光点的直径（像素）
    routeWidth: 3,     // 路线像素宽度
    fillOpacity: 0.32, // 区域填充不透明度
  },
};

const STORAGE_KEY = 'worldbuilding:view-config';

/**
 * 存档里的缩放上下限与出厂视场角一律丢掉，以代码里的值为准。
 *
 * 这几项不是设置面板里能改的，只是借 config 放着方便取用；可它们照样会被存进
 * localStorage，而合并时存档盖默认值——于是改了代码却不生效，看着像没改。
 * 凡是「用户改不了、只吃代码」的项都照这个办法挡一道。
 */
function dropCodeOwnedKeys(saved) {
  if (saved && saved.camera) {
    delete saved.camera.minDistance;
    delete saved.camera.maxDistance;
    delete saved.camera.fov;
  }
  return saved;
}

export function loadViewConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) mergeInto(config, dropCodeOwnedKeys(JSON.parse(saved)));
  } catch { /* 忽略坏数据 */ }
  return config;
}

export function saveViewConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
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
