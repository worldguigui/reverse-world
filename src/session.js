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
  labels: null,         // 地名层：每条地点一块贴地的四边形，字画在上面
  eventDot: null,       // 事件光点层：整层只有一个点，跟着当前选中的事件走
  routes: null,
  regions: null,
  rig: null,
  tweens: null,

  autosaver: null,     // 防抖自动保存（core/storage.js#createAutoSaver）

  currentGrid: null,    // 舞台的 TerrainGrid（贴地采样 / 画笔 / 工坊）；没有地形时为 null
  gridCache: new Map(), // rmapId → TerrainGrid（工坊编辑后回填）
  stageToken: 0,        // 换脸的序号：连换两张底图时用来丢弃过期的那次异步解码结果
  applyingStage: false, // 正在解码贴图中，供「要不要等它」判断
};
