/**
 * 唯一的状态源：把四个分片合成一个 store。
 * React 组件用 useStore(selector) 订阅；非 React 侧（bridge、api）用 useStore.getState()。
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { createUISlice } from './ui.js';
import { createWorldSlice } from './world.js';
import { createViewSlice } from './view.js';
import { createActionsSlice } from './actions.js';

export const useStore = create(
  subscribeWithSelector((...a) => ({
    ...createUISlice(...a),
    ...createWorldSlice(...a),
    ...createViewSlice(...a),
    ...createActionsSlice(...a),
  })),
);

export { buildDerived } from './world.js';
