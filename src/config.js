/**
 * 画面设置（区别于「世界观数据」——那些存在项目文件里）。
 * 这里只管渲染观感：视角、光照、大气、星空、地名与光点的尺寸。
 * localStorage 持久化，所有 GUI/API 修改的都是同一个 config 对象。
 */

export const DEFAULT_CONFIG = {
  camera: {
    fov: 45,
    lon: 105,          // 初始视角经度
    lat: 30,
    distance: 3.0,     // 相机到球心距离（球半径 = 1）
    minDistance: 1.35,
    maxDistance: 8,
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
    labelPx: 15,       // 地名在屏幕上的高度（像素）：跟真实地图一样不随远近缩放
    dotPx: 18,         // 选中事件那个光点的直径（像素）
    routeWidth: 3,     // 路线像素宽度
    fillOpacity: 0.32, // 区域填充不透明度
  },
};

const STORAGE_KEY = 'worldbuilding:view-config';

export function loadViewConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) mergeInto(config, JSON.parse(saved));
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
