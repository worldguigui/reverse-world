import { pickFile } from '../../utils/files.js';
import { useStore } from '../../store/index.js';

/**
 * 项目菜单：世界级操作（新建 / 示例 / 导入导出）与几个数据生成入口。
 * 开合状态由 Toolbar 持有，这里只负责渲染条目并在点击后关掉菜单。
 */
export function ProjectMenu({ onClose }) {
  const newProject = useStore((s) => s.newProject);
  const loadSample = useStore((s) => s.loadSample);
  const importFile = useStore((s) => s.importFile);
  const exportProject = useStore((s) => s.exportProject);
  const openWorkshop = useStore((s) => s.openWorkshop);
  const generateRealEarth = useStore((s) => s.generateRealEarth);
  const select = useStore((s) => s.select);

  const item = (label, run) => (
    <button className="menu-item" onClick={() => { onClose(); run(); }}>{label}</button>
  );

  return (
    // 菜单内部的点击不该冒泡到 document，否则会立刻把菜单关掉
    <div className="menu glass" onClick={(e) => e.stopPropagation()}>
      {item('📁 新建空白世界', newProject)}
      {item('✨ 载入示例世界', loadSample)}
      <div className="menu-sep" />
      {item('🖌 地形工坊（当前时代）', () => openWorkshop())}
      {item('🌐 真实地球地形（当前时代）', () => generateRealEarth())}
      <div className="menu-sep" />
      {item('📂 导入项目 (.world.json)', () => pickFile('.json,application/json').then((f) => f && importFile(f)))}
      {item('💾 导出项目', exportProject)}
      <div className="menu-sep" />
      {item('ℹ 世界概览', () => select(null))}
    </div>
  );
}
