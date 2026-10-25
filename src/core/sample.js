import { normalizeProject, addRasterMap } from './project.js';
import { buildRealEarthGrid, EARTH_RES } from './realearth.js';

/**
 * 示例世界：真实地球地形 + 第一次世界大战。
 *
 * 叙事数据（章节、人物、事件、路线、区域）全部放在 public/data/sample-world.json，
 * 与用户导出的 .world.json 同一套结构，走同一个 normalizeProject 检查；
 * 这里只负责两件事：取回那份文件，以及给它铺上真实地球这张舞台。
 *
 * 舞台不写进 JSON：它是由 public/textures/ 的高程与水数据现场生成的，
 * 存进文件只会让示例数据多出一份几百 KB 的 base64 副本。
 */
const SAMPLE_URL = 'data/sample-world.json';

/**
 * @param {(detail: string, progress: number) => Promise<void>|void} [onProgress]
 * @returns {Promise<{ project: object, grid: TerrainGrid }>}
 *   网格一并交回：调用方可以放进解码缓存，省掉「编码成 PNG 再解码回来」那一趟。
 */
export async function buildSampleProject(onProgress) {
  await onProgress?.('读取示例世界数据…', 0.03);
  const res = await fetch(SAMPLE_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`示例数据读取失败（HTTP ${res.status}）`);
  const p = normalizeProject(await res.json());

  // 示例 JSON 里可能残留一张打包好的舞台图，但舞台一律由下面的栅格现场生成。
  // 不先清掉的话，导出时会把这份旧图和生成的新图各存一遍（各约 5MB）。
  p.rasterMaps = [];
  p.baseRasterId = null;

  // 尺寸不在这里定，取网格自己报上来的：分辨率只有一个出处，见 EARTH_RES
  const grid = await buildRealEarthGrid(EARTH_RES, async (detail, progress) => {
    await onProgress?.(detail, 0.08 + progress * 0.8);
  });
  await onProgress?.('打包地图…', 0.9);
  const rmap = addRasterMap(p, {
    name: '真实地球', w: grid.w, h: grid.h, dataUrl: grid.encodePNG(),
  });
  p.baseRasterId = rmap.id;

  return { project: p, grid };
}
