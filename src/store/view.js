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

  /**
   * 把底部留白写进 CSS 变量。时间轴、编年史、提示条都读 --bottom-inset，
   * 壁纸环境里靠它整体避开系统任务栏。不传就用当前设置里的值。
   */
  applyBottomInset(px = get().viewConfig.layout.bottomInset) {
    document.documentElement.style.setProperty('--bottom-inset', `${px}px`);
  },

  /** 编年史长卷的整体不透明度，同走 CSS 变量（.chronicle 读 --chronicle-alpha） */
  applyChronicleAlpha(alpha = get().viewConfig.layout.chronicleAlpha) {
    document.documentElement.style.setProperty('--chronicle-alpha', String(alpha));
  },

  /** 把当前设置推给相机与球体，重建图层（尺寸类设置影响几何），并落盘 */
  applyView() {
    const config = get().viewConfig;
    session.rig?.setConfig({ ...config.camera, ...config.rotation });
    session.globe?.setConfig(config);
    get().applyBottomInset(config.layout.bottomInset);
    get().applyChronicleAlpha(config.layout.chronicleAlpha);
    saveViewConfig(config);
    get().touchLayers();
  },
});
