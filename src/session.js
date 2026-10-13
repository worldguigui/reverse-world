/**
 * 三维侧会话态：只放不可序列化的东西 —— three 句柄、栅格解码缓存，
 * 以及随会话生灭的大对象（TerrainGrid 内含 Float32Array 与 canvas）。
 * 世界数据与 UI 状态放 store；这里的东西不进 store，避免被深拷贝或序列化。
 * 句柄由 main.js 在组装期注入，之后 bridge 与各动作都从这里取。
 */
export const session = {
  // —— three 侧句柄（main.js 组装期注入）——
  renderer: null,
  scene: null,
  camera: null,
  globe: null,
  markers: null,
  routes: null,
  regions: null,
  rig: null,
  tweens: null,

  autosaver: null,     // 防抖自动保存（core/storage.js#createAutoSaver）

  currentGrid: null,   // 当前切面的 TerrainGrid（贴地采样 / 画笔 / 工坊）
  gridCache: new Map(), // rmapId → TerrainGrid（工坊编辑后回填）
  eraToken: 0,          // 切面切换的序号：快速连切时用来丢弃过期的那次异步解码结果
  appliedEra: null,     // { project, key } 已经生效的切面目标，用来认掉重复的 applyEra
  applyingEra: null,    // { project, key } 正在解码中的切面目标，避免同一个目标解码两次
};
