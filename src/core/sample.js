import { normalizeProject, addRasterMap } from './project.js';
import { buildRealEarthGrid } from './realearth.js';

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

export async function buildSampleProject() {
  const res = await fetch(SAMPLE_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`示例数据读取失败（HTTP ${res.status}）`);
  const p = normalizeProject(await res.json());

  // 尺寸不在这里定，取网格自己报上来的：分辨率只有一个出处，见 EARTH_RES
  const grid = await buildRealEarthGrid();
  const rmap = addRasterMap(p, { name: '真实地球', w: grid.w, h: grid.h, dataUrl: grid.encodePNG() });
  p.baseRasterId = rmap.id;

  return p;
}
