/**
 * 画面设置分片：视角、光照、大气、星空、地形网格与夸张、标注大小。
 * 这些只影响渲染观感，不属于世界项目数据（不写进项目文件），
 * 额外单独持久化到 localStorage。
 */
import { loadViewConfig, mergeInto, saveViewConfig } from '../config.js';
import { session } from '../session.js';

export const createViewSlice = (set, get) => ({
  viewConfig: loadViewConfig(),

  /**
   * 深合并一组设置并立即生效。
   * 合并结果放进**新对象**：面板靠订阅 viewConfig 重画，就地改的话引用不变，
   * 滑块拖了也不会跟手。
   */
  setViewConfig(patch) {
    set({ viewConfig: mergeInto(structuredClone(get().viewConfig), patch) });
    get().applyView();
  },

  /** 把当前设置推给相机与球体，重建图层（尺寸类设置影响几何），并落盘 */
  applyView() {
    const config = get().viewConfig;
    session.rig?.setConfig({ ...config.camera, ...config.rotation });
    session.globe?.setConfig(config);
    saveViewConfig(config);
    get().touchLayers();
  },
});
