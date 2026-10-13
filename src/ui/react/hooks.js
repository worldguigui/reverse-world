import { useStore } from '../../store/index.js';

/**
 * 订阅「项目数据发生过变更」这个信号，返回那份派生快照。
 *
 * core/project.js 的增删改全部就地修改，project 与其数组的引用永远不变，
 * 组件只订阅 project 是收不到通知的；derived 在每次 mutateProject 后重建，
 * 引用必然更新，因此拿它当重渲染的信号源（数据本身仍从 project 上现取）。
 */
export function useProjectRevision() {
  return useStore((s) => s.derived);
}
