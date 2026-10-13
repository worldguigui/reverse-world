import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { WelcomePanel } from './panels/WelcomePanel.jsx';
import { OverviewPanel } from './panels/OverviewPanel.jsx';
import { TimePointEditor } from './panels/TimePointEditor.jsx';
import { ItemEditor } from './panels/ItemEditor.jsx';
import { EntryForm } from './panels/EntryForm.jsx';
import { DrawForm } from './panels/DrawForm.jsx';

/**
 * 右侧检查器：按当前模式与选中对象分发到对应面板。
 * 编辑模式优先于选中状态（正在绘制/放置时就该显示那张表单）。
 */
export function Inspector() {
  const project = useStore((s) => s.project);
  const mode = useStore((s) => s.mode);
  const selection = useStore((s) => s.selection);
  useProjectRevision(); // 选中对象被改名、删除，或时间点增删后要重画

  if (!project) return <WelcomePanel />;
  if (mode === 'add-entry') return <EntryForm />;
  // 两种绘制模式是同一个组件，直接切换时 React 会复用实例、输入框留旧值，故用 key 强制重挂载
  if (mode === 'draw-route') return <DrawForm key="draw-route" kind="route" />;
  if (mode === 'draw-region') return <DrawForm key="draw-region" kind="region" />;
  if (!selection) return <OverviewPanel />;
  // 换一个时间点也要重挂载，否则名称框里还留着上一个时间点的名字
  if (selection.kind === 'time') return <TimePointEditor key={selection.id} tpId={selection.id} />;

  // 换一个选中对象就重挂载，各输入框自然取到新对象的值，不会残留上一个对象的内容
  return <ItemEditor key={`${selection.kind}:${selection.id}`} kind={selection.kind} id={selection.id} />;
}
