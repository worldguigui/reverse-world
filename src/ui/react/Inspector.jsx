import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { WelcomePanel } from './panels/WelcomePanel.jsx';
import { OverviewPanel } from './panels/OverviewPanel.jsx';
import { ItemEditor } from './panels/ItemEditor.jsx';
import { EventEditor } from './panels/EventEditor.jsx';
import { EventList } from './panels/EventList.jsx';
import { EventForm } from './panels/EventForm.jsx';
import { DrawForm } from './panels/DrawForm.jsx';
import { CharacterList, CharacterEditor } from './panels/CharacterEditor.jsx';
import { ChapterList } from './panels/ChapterList.jsx';

/**
 * 右侧检查器：按当前模式与选中对象分发到对应面板。
 * 编辑模式优先于选中状态（正在绘制/放置时就该显示那张表单）。
 */
export function Inspector() {
  const project = useStore((s) => s.project);
  const mode = useStore((s) => s.mode);
  const selection = useStore((s) => s.selection);
  const overviewOpen = useStore((s) => s.overviewOpen);
  useProjectRevision(); // 选中对象被改名或删除后要重画

  if (!project) return <WelcomePanel />;
  if (mode === 'add-event') return <EventForm key="add-event" />;
  // 两种绘制模式是同一个组件，直接切换时 React 会复用实例、输入框留旧值，故用 key 强制重挂载
  if (mode === 'draw-route') return <DrawForm key="draw-route" kind="route" />;
  if (mode === 'draw-region') return <DrawForm key="draw-region" kind="region" />;
  // 概览可以被手动收起；收起后检查器渲染空，容器靠 :empty 隐掉
  if (!selection) return overviewOpen ? <OverviewPanel /> : null;
  // 清单页与详情页共用同一个选中入口，不必再多一个开关去跟选中态对齐
  if (selection.kind === 'events') return <EventList />;
  if (selection.kind === 'characters') return <CharacterList />;
  if (selection.kind === 'groups') return <ChapterList />;
  // 人物没有坐标也没有存续区间，与事件/路线/区域那几张卡差得远，单独一张
  if (selection.kind === 'character') return <CharacterEditor key={selection.id} id={selection.id} />;
  // 事件要先存草稿再保存，路线与区域仍是改了就算，两者不共用一张卡
  if (selection.kind === 'event') return <EventEditor key={selection.id} id={selection.id} />;

  // 换一个选中对象就重挂载，各输入框自然取到新对象的值，不会残留上一个对象的内容
  return <ItemEditor key={`${selection.kind}:${selection.id}`} kind={selection.kind} id={selection.id} />;
}
