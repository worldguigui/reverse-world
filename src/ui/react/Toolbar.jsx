import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { ProjectMenu } from './ProjectMenu.jsx';
import { CloudDialog } from './CloudDialog.jsx';

/** 各编辑模式下显示在右上角的一句提示 */
const MODE_HINTS = {
  browse: '',
  'add-event': '单击球面选定具体位置（也可以不点），Esc 退出',
  'draw-route': '单击依次添加途经点，Enter 完成',
  'draw-region': '单击勾画边界，靠近起点点击或 Enter 自动闭合',
};

const MODES = [
  { id: 'browse', label: '浏览', title: '浏览模式：悬停查看、单击选中、双击定位' },
  { id: 'add-event', label: '事件', title: '在球面上单击给它一个坐标；不点则是没有坐标的纯叙事事件' },
  { id: 'draw-route', label: '路线', title: '依次单击途经点绘制路线' },
  { id: 'draw-region', label: '区域', title: '逐点勾画区域' },
];

/**
 * 顶栏：世界名称 + 项目菜单 + 编辑模式切换 + 画面设置开关。
 */
export function Toolbar() {
  const project = useStore((s) => s.project);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const select = useStore((s) => s.select);
  const openOverview = useStore((s) => s.openOverview);
  const toggleSettings = useStore((s) => s.toggleSettings);
  useProjectRevision(); // 世界改名后标题要跟着变

  const [menuOpen, setMenuOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);

  // 点菜单以外的任何地方都收起菜单。菜单按钮与菜单本身各自 stopPropagation，
  // 否则这一次点击会先把菜单关掉、再被按钮的 onClick 重新打开。
  // Esc 只收起菜单，不再传给全局：否则会顺带退出正在进行的编辑模式。
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = () => setMenuOpen(false);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      document.activeElement?.blur?.();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // 清单与概览不改变球面的编辑方式，但检查器同一时间只显示一页：
  // 编辑模式下要先退回浏览，否则点了「人物」右侧仍是原来的绘制表单。
  const showPage = (selection) => {
    setMode('browse');
    // 世界概览可以被手动收起，从品牌位点进来时顺带把它打开
    if (selection) select(selection);
    else openOverview();
  };

  return (
    <div className="topbar-inner">
      <div className="bar-side">
        <button
          className="icon-btn"
          title="项目菜单"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((open) => !open); }}
        >
          ☰
        </button>
        <button className="brand" title="查看世界概览" onClick={() => showPage(null)}>
          {project ? project.name : '世界观工具'}
        </button>
      </div>

      <div className="bar-center">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`mode-btn${m.id === mode ? ' active' : ''}`}
            title={m.title}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="bar-side bar-right">
        <span className="mode-hint" id="mode-hint">{MODE_HINTS[mode] ?? ''}</span>
        {/* 事件、人物与章节的清单都不进模式那一排：它们不改球面的交互方式，
            只是把检查器翻到另一页；球面上的「事件」模式是另一回事，管的是新建 */}
        <button
          className="mode-btn"
          id="tb-events"
          title="事件：按时间查看全部事件"
          onClick={() => showPage({ kind: 'events' })}
        >
          事件
        </button>
        <button
          className="mode-btn"
          id="tb-characters"
          title="人物：录入角色，看他们各自涉及哪些事件"
          onClick={() => showPage({ kind: 'characters' })}
        >
          人物
        </button>
        <button
          className="mode-btn"
          id="tb-groups"
          title="章节：把事件分成有名字的一组组"
          onClick={() => showPage({ kind: 'groups' })}
        >
          章节
        </button>
        <button className="icon-btn" title="画面设置" onClick={() => toggleSettings()}>⚙</button>
      </div>

      {menuOpen && (
        <ProjectMenu
          onClose={() => setMenuOpen(false)}
          onCloud={() => setCloudOpen(true)}
        />
      )}
      {cloudOpen && <CloudDialog onClose={() => setCloudOpen(false)} />}
    </div>
  );
}
