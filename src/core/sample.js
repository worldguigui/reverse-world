import * as P from './project.js';
import { buildRealEarthGrid, importCitiesAsEntries } from './realearth.js';

/**
 * 示例世界：真实地球地形 + 程序化剧情——
 * 第一时代大西洋上耸立着「亚特兰蒂斯高地」，帝国纪元开始前沉入大海，
 * 顺带演示「每个时代有自己的地形快照」这一核心能力。
 */
export async function buildSampleProject() {
  const res = 512;
  const p = P.createProject({
    name: '示例世界 · 泰拉',
    description: '以真实地球地形为底：在大航海时代与帝国时代之间，看沧海桑田。',
  });

  // —— 时代一：真实地形 + 亚特兰蒂斯高地 ——
  const grid1 = await buildRealEarthGrid(res);
  // 纵向是纬度 180°，格数是横向的一半——用 res 会把纬度缩到两倍（亚特兰蒂斯会跑到南半球去）
  const atCell = (lat, lng) => [((lng + 180) / 360) * grid1.w, ((90 - lat) / 180) * grid1.h];
  const [ax, ay] = atCell(28, -32);
  for (let pass = 0; pass < 6; pass++) grid1.applyBrush('raise', ax, ay, 10, 0.09);
  grid1.renderColor();
  const rm1 = P.addRasterMap(p, { name: '泰拉地形 · 大航海时代', w: res, h: res / 2, dataUrl: grid1.encodePNG() });
  const tp1 = P.addTimePoint(p, { label: '大航海时代' });
  P.updateTimePoint(p, tp1.id, { rmapId: rm1.id });

  // —— 时代二：亚特兰蒂斯沉没 ——
  const grid2 = grid1.clone();
  for (let pass = 0; pass < 12; pass++) grid2.applyBrush('lower', ax, ay, 12, 0.1);
  grid2.renderColor();
  const rm2 = P.addRasterMap(p, { name: '泰拉地形 · 帝国时代', w: res, h: res / 2, dataUrl: grid2.encodePNG() });
  const tp2 = P.addTimePoint(p, { label: '帝国时代' });
  P.updateTimePoint(p, tp2.id, { rmapId: rm2.id });

  // —— 内容 ——
  P.addItem(p, 'entry', {
    title: '亚特兰蒂斯',
    description: '高原文明，帝国纪元开始前沉入大海——切换时代看它消失。',
    lat: 28, lng: -32, color: '#4dd0ff', from: tp1.id, to: tp1.id,
  });
  P.addItem(p, 'entry', {
    title: '长安西市',
    description: '丝绸之路的东方起点，胡商云集。',
    lat: 34.3, lng: 108.9, from: tp1.id,
  });
  P.addItem(p, 'route', {
    title: '丝绸之路',
    description: '连接东方与西方的商路。',
    color: '#ffb545', from: tp1.id,
    points: [
      { lat: 34.3, lng: 108.9 },
      { lat: 40.1, lng: 94.7 },
      { lat: 39.6, lng: 66.9 },
      { lat: 33.3, lng: 44.4 },
      { lat: 41.9, lng: 12.5 },
    ],
  });
  P.addItem(p, 'region', {
    name: '帝国疆域',
    description: '帝国时代才出现的庞大疆域。',
    color: '#ff6e6e', from: tp2.id,
    ring: [
      [-2, 36], [5, 38], [12, 45], [18, 42], [25, 38],
      [30, 33], [26, 31], [18, 33], [10, 36], [2, 37],
    ],
  });

  // —— 真实城市（人口 400 万以上的大城市）——
  try {
    await importCitiesAsEntries(p, tp1.id, { minPop: 4_000_000 });
  } catch (err) {
    console.warn('[sample] 城市数据导入失败（离线？）：', err);
  }

  return p;
}
