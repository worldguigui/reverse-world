import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import * as W from '../workshop-session.js';

/**
 * 五支画笔，按「写哪个通道」分成两组。
 * 形态组只改高度（球面的凹凸），颜色组只改 RGB565 地表色，两组互不影响：
 * 蓝色高山、绿色盆地都是许画出来的，不必符合物理。
 */
const TOOL_GROUPS = [
  ['形态', [
    ['raise', '⛰ 抬升', '点一下，一个区域变高——山脉就是这么做出来的'],
    ['lower', '⬇ 压低', '压低地形，挖出海盆地、崖壁与峡谷'],
    ['smooth', '🪄 抹平', '把崎岖的区域磨平'],
  ]],
  ['颜色', [
    ['paint', '🎨 上色', '用下方颜色涂格子：海洋、湖泊、草地与河流都用它'],
    ['clearColor', '🧽 去色', '把格子恢复成按当前高度与坡度生成的地形色'],
  ]],
];

/** 当前画笔写哪个通道：颜色笔只改颜色，形态笔只改几何 */
const TOOL_WRITES = {
  raise: '写入：高度（球面起伏）',
  lower: '写入：高度（球面起伏）',
  smooth: '写入：高度（球面起伏）',
  paint: '写入：颜色（RGB565，不动高度）',
  clearColor: '写入：颜色（RGB565，不动高度）',
};

/**
 * 画布本身是网格自带的节点，塞进来后按「一格一 CSS 像素」摆好，缩放交给 transform。
 * 尺寸由 workshop-session 在 attachCanvas 时写死（跟着网格分辨率走），这里只管定位与像素感。
 */
const CANVAS_STYLE = 'position:absolute;left:0;top:0;transform-origin:0 0;'
  + 'image-rendering:pixelated;cursor:crosshair;background:#000;touch-action:none;display:block;';

/**
 * 地图工坊：全屏栅格绘制。
 * 面板外壳与控件由 React 渲染，画笔涂抹与撤销仍是命令式（见 ui/workshop-session.js）。
 * @param {{ container: HTMLElement }} props 常驻的 #workshop 容器，用来切 .hidden
 */
export function Workshop({ container }) {
  const open = useStore((s) => s.workshopOpen);
  const tool = useStore((s) => s.workshopTool);
  const storedSize = useStore((s) => s.workshopSize);
  const strength = useStore((s) => s.workshopStrength);
  const hard = useStore((s) => s.workshopHard);
  const shape = useStore((s) => s.workshopShape);
  const color = useStore((s) => s.workshopColor);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const zoom = useStore((s) => s.workshopZoom);
  const showOverlay = useStore((s) => s.workshopShowOverlay);
  const setWorkshopBrush = useStore((s) => s.setWorkshopBrush);
  const [generating, setGenerating] = useState(false);
  const wrapRef = useRef(null);

  // 上限跟着当前栅格的分辨率走（见 brushSizeMax）。store 里的值可能是上一张网格留下的，
  // 读数与滑块都夹到当前上限，免得显示一个落不到的数
  const sizeMax = W.brushSizeMax();
  const size = Math.min(storedSize, sizeMax);

  // 容器常驻 DOM，只切 .hidden——不卸载，E2E 与样式都按这个来。
  // 这一步必须排在下面挂画布之前：容器还 display:none 时量不出尺寸，算不出适应窗口的比例。
  useEffect(() => { container.classList.toggle('hidden', !open); }, [container, open]);

  // 把网格的画布插进容器并装上涂抹/平移/缩放；关掉时原样摘走，画布留着下次用
  useEffect(() => {
    const canvas = open ? W.workshop.grid?.colorCanvas : null;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    canvas.style.cssText = CANVAS_STYLE;
    wrap.appendChild(canvas);
    const detach = W.attachCanvas(canvas, wrap);
    return () => {
      detach();
      if (canvas.parentNode === wrap) wrap.removeChild(canvas);
    };
  }, [open]);

  // 路线/区域参考层由 attachCanvas 建好：开关只切显隐，打开时补画一次
  useEffect(() => { if (open) W.syncOverlayView(); }, [showOverlay, open]);

  // 快捷键：Esc 取消，Ctrl+Z / Ctrl+Y 撤销重做。
  // 真实地球还在下载时不能取消：此时关掉会话会让下载结果落空，也让“生成中”的按钮无处可归。
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !generating) W.cancelWorkshop();
      if (generating) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); W.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); W.redo(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, generating]);

  if (!open) return null;
  const grid = W.workshop.grid;
  const colorTool = tool === 'paint' || tool === 'clearColor';

  const loadRealEarth = async () => {
    setGenerating(true);
    try {
      await W.copyFromRealEarth();
    } catch (err) {
      alert('真实地球数据加载失败：' + err.message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="workshop">
      <div className="wk-top glass">
        <span className="wk-title">🖌 地图工坊</span>
        <span className="wk-dim">{`${grid.w}×${grid.h} 栅格 · 画完切到主视图看球体效果`}</span>
        <span className="wk-dim">{`缩放 ${Math.round(zoom * 100)}%`}</span>
        <button className="btn btn-mini" title="恢复「整张地图铺满窗口」" onClick={() => W.fitView()}>
          ⤢ 适应窗口
        </button>
        <span style={{ flex: 1 }} />
        <button
          className={showOverlay ? 'btn active' : 'btn'}
          title="把已有的路线与区域半透明叠在画布上，方便照着它们勾地形；只读，不能点选或编辑"
          onClick={() => setWorkshopBrush({ workshopShowOverlay: !showOverlay })}
        >
          🗺 路线区域
        </button>
        <button className="btn" disabled={!canUndo || generating} onClick={() => W.undo()}>↶ 撤销</button>
        <button className="btn" disabled={!canRedo || generating} onClick={() => W.redo()}>↷ 重做</button>
        <button className="btn" disabled={generating} onClick={() => W.resetOcean()}>重置为海洋</button>
        <button className="btn" disabled={generating} onClick={loadRealEarth}>
          {generating ? '生成中…' : '🌐 真实地球'}
        </button>
        <button className="btn btn-primary" disabled={generating} onClick={() => W.commitWorkshop()}>✔ 完成</button>
        <button className="btn" disabled={generating} onClick={() => W.cancelWorkshop()}>取消</button>
      </div>

      <div className="wk-body">
        <div className="wk-side glass">
          {TOOL_GROUPS.map(([group, items]) => (
            <div key={group} className="wk-group">
              <div className="wk-group-label">{group}</div>
              {items.map(([id, label, tip]) => (
                <button
                  key={id}
                  className={`wk-tool${tool === id ? ' active' : ''}`}
                  title={tip}
                  onClick={() => setWorkshopBrush({ workshopTool: id })}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
          <div className="wk-dim">{TOOL_WRITES[tool]}</div>

          <div className="wk-slider">
            <span className="field-label">上色颜色</span>
            <input
              type="color"
              aria-label="上色颜色"
              value={color}
              onChange={(e) => setWorkshopBrush({ workshopColor: e.target.value })}
            />
          </div>

          <div className="wk-slider">
            <span className="field-label">笔形</span>
            <div className="wk-row" role="group" aria-label="笔形">
              <button
                type="button"
                className={`wk-tool${shape === 'round' ? ' active' : ''}`}
                aria-pressed={shape === 'round'}
                onClick={() => setWorkshopBrush({ workshopShape: 'round' })}
              >
                ● 圆形
              </button>
              <button
                type="button"
                className={`wk-tool${shape === 'square' ? ' active' : ''}`}
                aria-pressed={shape === 'square'}
                onClick={() => setWorkshopBrush({ workshopShape: 'square' })}
              >
                ■ 方形
              </button>
            </div>
          </div>

          <div className="wk-slider">
            <span className="field-label">笔刷大小 </span><b>{size} 格</b>
            <input
              type="range"
              min={1}
              max={sizeMax}
              value={size}
              onChange={(e) => setWorkshopBrush({ workshopSize: +e.target.value })}
            />
          </div>

          <div className="wk-slider">
            <span className="field-label">{colorTool ? '颜料浓度' : '厚度'} </span>
            <b>{Math.round(strength * 100)}%</b>
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

          <p className="insp-hint">
            形态笔改高低，颜色笔改地表色，两个通道互不影响——蓝色高山、绿色盆地都画得出来。
            颜色存成 RGB565，换设备打开也会保持同一套颜色。
            <br />
            圆形笔按半径覆盖，方形笔按边长覆盖；硬笔=半径内全强度，画垂直悬崖/方柱/笔直边界，
            软笔=高斯自然过渡。按住拖动连续涂抹。
            <br />
            <b>滚轮</b>缩放（以光标为中心），<b>Shift+左键 / 中键 / 右键拖动</b>平移。
            笔刷最小 1 格，放大到看得清落点再抠细节。
          </p>
        </div>

        {/* 画布绝对定位在 .wk-stage 里，靠 transform 缩放；外层只管边框与裁切 */}
        <div className="wk-canvas-wrap">
          <div className="wk-stage" ref={wrapRef} />
        </div>
      </div>
    </div>
  );
}
