import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { ProjectMenu } from './ProjectMenu.jsx';
import { CloudDialog } from './CloudDialog.jsx';

/** 各编辑模式下显示在右上角的一句提示 */
const MODE_HINTS = {
  browse: '',
  'add-event': '单击球面给它一个坐标（也可以不点），Esc 退出',
  'draw-route': '单击依次添加途经点，Enter 完成',
  'draw-region': '单击勾画边界（≥3 点），靠近起点点击或 Enter 闭合',
};

const MODES = [
  { id: 'browse', label: '浏览', title: '浏览模式：悬停查看、单击选中、双击定位' },
  { id: 'add-event', label: '事件', title: '在球面上单击给它一个坐标；不点则是没有坐标的纯叙事事件' },
  { id: 'draw-route', label: '路线', title: '依次单击途经点绘制路线' },
  { id: 'draw-region', label: '区域', title: '逐点勾画势力区域' },
];

/**
 * 顶栏：世界名称 + 项目菜单 + 编辑模式切换 + 画面设置开关。
 */
export function Toolbar() {
  const project = useStore((s) => s.project);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const select = useStore((s) => s.select);
  const toggleSettings = useStore((s) => s.toggleSettings);
  useProjectRevision(); // 世界改名后标题要跟着变

  const [menuOpen, setMenuOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);

  // 点菜单以外的任何地方都收起菜单。菜单按钮与菜单本身各自 stopPropagation，
  // 否则这一次点击会先把菜单关掉、再被按钮的 onClick 重新打开。
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

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
        <button className="brand" title="查看世界概览" onClick={() => select(null)}>
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

      <div className="bar-side">
        <span className="mode-hint" id="mode-hint">{MODE_HINTS[mode] ?? ''}</span>
        {/* 人物与章节都不进模式那一排：它们不改球面的交互方式，只是把检查器翻到另一页 */}
        <button
          className="mode-btn"
          id="tb-characters"
          title="人物：录入角色，看他们各自涉及哪些事件"
          onClick={() => select({ kind: 'characters' })}
        >
          人物
        </button>
        <button
          className="mode-btn"
          id="tb-groups"
          title="章节：把事件分成有名字的一组组"
          onClick={() => select({ kind: 'groups' })}
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
