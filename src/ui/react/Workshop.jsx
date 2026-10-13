import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import * as W from '../workshop-session.js';

/** 四种画笔：id、按钮文案、悬停说明 */
const TOOLS = [
  ['raise', '⛰ 抬升', '点一下，一个区域变高——山脉就是这么做出来的'],
  ['lower', '🌊 降低', '压低地形，涂沉大陆、挖出海盆地'],
  ['smooth', '🪄 抹平', '把崎岖的区域磨平'],
  ['river', '💧 河流', '拖动画出河流，宽度由笔刷大小决定'],
];

/** 画布本身是网格自带的节点，塞进来后要撑满容器并保持像素感 */
const CANVAS_STYLE = 'width:100%;height:100%;object-fit:contain;image-rendering:pixelated;'
  + 'cursor:crosshair;background:#000;touch-action:none;display:block;';

/**
 * 底图工坊：全屏栅格绘制。
 * 面板外壳与控件由 React 渲染，画笔涂抹与撤销仍是命令式（见 ui/workshop-session.js）。
 * @param {{ container: HTMLElement }} props 常驻的 #workshop 容器，用来切 .hidden
 */
export function Workshop({ container }) {
  const open = useStore((s) => s.workshopOpen);
  const tool = useStore((s) => s.workshopTool);
  const size = useStore((s) => s.workshopSize);
  const strength = useStore((s) => s.workshopStrength);
  const hard = useStore((s) => s.workshopHard);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const setWorkshopBrush = useStore((s) => s.setWorkshopBrush);
  const [generating, setGenerating] = useState(false);
  const wrapRef = useRef(null);

  // 容器常驻 DOM，只切 .hidden——不卸载，E2E 与样式都按这个来
  useEffect(() => { container.classList.toggle('hidden', !open); }, [container, open]);

  // 把网格的画布插进容器并装上绘制事件；关掉时原样摘走，画布留着下次用
  useEffect(() => {
    const canvas = open ? W.workshop.grid?.colorCanvas : null;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    canvas.style.cssText = CANVAS_STYLE;
    wrap.appendChild(canvas);
    const detach = W.attachCanvas(canvas);
    return () => {
      detach();
      if (canvas.parentNode === wrap) wrap.removeChild(canvas);
    };
  }, [open]);

  // 快捷键：Esc 取消，Ctrl+Z / Ctrl+Y 撤销重做
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') W.cancelWorkshop();
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); W.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); W.redo(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const grid = W.workshop.grid;

  const loadRealEarth = async () => {
    setGenerating(true);
    try {
      await W.copyFromRealEarth();
    } catch (err) {
      alert('真实地球数据加载失败：' + err.message);
    }
    setGenerating(false);
  };

  return (
    <div className="workshop">
      <div className="wk-top glass">
        <span className="wk-title">🖌 底图工坊</span>
        <span className="wk-dim">{`${grid.w}×${grid.h} 栅格 · 画完切到主视图看球体效果`}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!canUndo} onClick={() => W.undo()}>↶ 撤销</button>
        <button className="btn" disabled={!canRedo} onClick={() => W.redo()}>↷ 重做</button>
        <button className="btn" onClick={() => W.resetOcean()}>重置为海洋</button>
        <button className="btn" disabled={generating} onClick={loadRealEarth}>
          {generating ? '生成中…' : '🌐 真实地球'}
        </button>
        <button className="btn btn-primary" onClick={() => W.commitWorkshop()}>✔ 完成</button>
        <button className="btn" onClick={() => W.cancelWorkshop()}>取消</button>
      </div>

      <div className="wk-body">
        <div className="wk-side glass">
          {TOOLS.map(([id, label, tip]) => (
            <button
              key={id}
              className={`wk-tool${tool === id ? ' active' : ''}`}
              title={tip}
              onClick={() => setWorkshopBrush({ workshopTool: id })}
            >
              {label}
            </button>
          ))}

          <div className="wk-slider">
            <span className="field-label">笔刷大小 </span><b>{size}</b>
            <input
              type="range"
              min={2}
              max={48}
              value={size}
              onChange={(e) => setWorkshopBrush({ workshopSize: +e.target.value })}
            />
          </div>

          <div className="wk-slider">
            <span className="field-label">厚度 </span><b>{Math.round(strength * 100)}%</b>
            <input
              type="range"
              min={1}
              max={500}
              value={Math.round(strength * 100)}
              onChange={(e) => setWorkshopBrush({ workshopStrength: +e.target.value / 100 })}
            />
          </div>

          <button
            className={`btn wk-tool${hard ? ' active' : ''}`}
            title={'开：半径内全强度，无扩散——画垂直悬崖 / 高塔 / 笔直边界\n关：高斯衰减的软笔，自然平滑山脉'}
            onClick={() => setWorkshopBrush({ workshopHard: !hard })}
          >
            {hard ? '■ 硬笔（无扩散）' : '● 软笔（高斯）'}
          </button>

          <p className="insp-hint">硬笔=半径内全强度，画垂直悬崖/方柱/笔直边界；软笔=高斯自然山脉。按住拖动连续涂抹。</p>
        </div>

        <div className="wk-canvas-wrap" ref={wrapRef} />
      </div>
    </div>
  );
}
