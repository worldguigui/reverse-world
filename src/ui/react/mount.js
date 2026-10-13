import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * 把一个 React 面板挂到静态容器上。每个面板一个 root：Zustand 不需要 Provider，
 * 多个 root 共享同一个 store，CSS 与 E2E 选择器也零改动。
 *
 * 返回的面板句柄与旧手写面板接口一致（都有 render），所以 bridge 不必区分实现；
 * React 面板自己订阅 store，render 是空动作。
 */
export function mountPanel(container, Component, props) {
  const root = createRoot(container);
  root.render(createElement(Component, props));
  return {
    root,
    render() {},
    unmount() { root.unmount(); },
  };
}
