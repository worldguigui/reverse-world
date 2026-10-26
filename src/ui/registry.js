/**
 * 面板装配：把每个 React 面板挂到 index.html 里对应的静态容器上。
 * 容器 id/class 由 E2E 脚本与样式共同依赖，所以面板换了实现、容器保持不变。
 */
import { mountPanel } from './react/mount.js';
import { Timeline } from './react/Timeline.jsx';
import { Toolbar } from './react/Toolbar.jsx';
import { Inspector } from './react/Inspector.jsx';
import { SettingsPanel } from './react/SettingsPanel.jsx';
import { Workshop } from './react/Workshop.jsx';
import { LoadingScreen } from './react/LoadingScreen.jsx';

/**
 * 组装全部面板。
 * @param {{topbar, timeline, inspector, settings, workshop, loading, workshopPreview}} containers
 *   静态容器；workshopPreview 是 main.js 注入的预览挂载/摘除函数
 * @returns {{toolbar, timeline, inspector, settings, workshop, loading}} 各面板句柄
 */
export function createPanels(containers) {
  return {
    toolbar: mountPanel(containers.topbar, Toolbar),
    timeline: mountPanel(containers.timeline, Timeline),
    inspector: mountPanel(containers.inspector, Inspector),
    settings: mountPanel(containers.settings, SettingsPanel),
    loading: mountPanel(containers.loading, LoadingScreen),

    // 工坊要拿到容器本身：关掉时只给 #workshop 加 .hidden，不卸载；
    // 预览函数交给它，才能在 React 渲染出预览框之后把主画布搬进去
    workshop: mountPanel(containers.workshop, Workshop, {
      container: containers.workshop,
      preview: containers.workshopPreview,
    }),
  };
}
