import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * 把一个 React 面板挂到静态容器上。每个面板一个 root：Zustand 不需要 Provider，
 * 多个 root 共享同一个 store，CSS 与 E2E 选择器也零改动。
 * 面板自己订阅 store，挂载之后不必再手动重绘。
 */
export function mountPanel(container, Component, props) {
  const root = createRoot(container);
  root.render(createElement(Component, props));
  return {
    root,
    unmount() { root.unmount(); },
  };
}
