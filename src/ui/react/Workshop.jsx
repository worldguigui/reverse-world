import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import * as W from '../workshop-session.js';

/**
 * 五支画笔分两组，笔刷统一是正方形：
 * 形态组改高度，并用「高度基色」按新高度与坡度重算被涂格的 RGB565 地表色——
 * 0 高度的平地就是基色，越高越亮、越低越暗，坡度再叠一层西北光明暗，
 * 起伏与沟壑在顶视图里都看得见；颜色组只改地表色，不动高度。
 * 颜色笔按矩形满铺，重复点击结果不变；上色时可以额外开启「加入阴影」，
 * 按地形坡度给所选颜色叠明暗。手动颜色一直保留到下一次形态笔经过该格。
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

/** 当前画笔写哪个通道：颜色笔只改颜色，形态笔改高度并按高度、坡度重算颜色 */
const TOOL_WRITES = {
  raise: '写入：高度 + 按高度/坡度重算基色',
  lower: '写入：高度 + 按高度/坡度重算基色',
  smooth: '写入：高度 + 按高度/坡度重算基色',
  paint: '写入：颜色（RGB565，矩形满铺，不动高度）',
  clearColor: '写入：颜色（RGB565，矩形满铺，不动高度）',
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
  const color = useStore((s) => s.workshopColor);
  const paintShadow = useStore((s) => s.workshopPaintShadow);
  const heightColor = useStore((s) => s.workshopHeightColor);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const zoom = useStore((s) => s.workshopZoom);
  const showOverlay = useStore((s) => s.workshopShowOverlay);
  const setWorkshopBrush = useStore((s) => s.setWorkshopBrush);
  const [generating, setGenerating] = useState(false);
  const wrapRef = useRef(null);

  // 上限跟着当前栅格的分辨率走（见 brushSizeMax）。store 里的值可能是上一张网格留下的，
  // 读数与滑块都夹到当前上限，免得显示一个落不到的数；滑块只停奇数，显示值也取奇数
  const sizeMax = W.brushSizeMax();
  const clampedSize = Math.min(storedSize, sizeMax);
  const size = clampedSize % 2 === 1 ? clampedSize : clampedSize + 1;

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
            <span className="field-label" title="0 高度的平地就是这支颜色；抬高渐亮、压低渐暗，坡度另叠一层西北光明暗">
              高度基色
            </span>
            <input
              type="color"
              aria-label="高度基色"
              value={heightColor}
              onChange={(e) => setWorkshopBrush({ workshopHeightColor: e.target.value })}
            />
          </div>

          {tool === 'paint' && (
            <button
              className={`btn wk-tool${paintShadow ? ' active' : ''}`}
              aria-pressed={paintShadow}
              title={'开启后，上色会按当前地形坡度给所选颜色叠明暗：只改亮度，不改色相。关闭则平涂精确颜色'}
              onClick={() => setWorkshopBrush({ workshopPaintShadow: !paintShadow })}
            >
              {paintShadow ? '🌗 已加入阴影' : '🌑 加入阴影'}
            </button>
          )}

          <div className="wk-slider">
            <span className="field-label">笔刷边长 </span><b>{size} 格</b>
            <input
              type="range"
              min={1}
              max={sizeMax}
              step={2}
              value={size}
              onChange={(e) => setWorkshopBrush({ workshopSize: +e.target.value })}
            />
          </div>

          {!colorTool && (
            <>
              <div className="wk-slider">
                <span className="field-label">厚度 </span>
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
                title={'开：矩形内全强度，无扩散——画垂直悬崖 / 高塔 / 笔直边界\n关：从四边向中心衰减的软笔，自然平滑山脉'}
                onClick={() => setWorkshopBrush({ workshopHard: !hard })}
              >
                {hard ? '■ 硬笔（无扩散）' : '● 软笔（高斯）'}
              </button>
            </>
          )}

          <p className="insp-hint">
            形态笔改高低，并按「高度基色」重算被涂格的地表色：越高越亮、越低越暗，
            坡度再叠一层西北光明暗，山脊与沟壑会重新显出来；压回原高度颜色也会恢复。
            颜色笔按矩形满铺、不动高度，重复点击同一格结果不变；形态笔再经过时，
            这些格子会以基色为准重新着色。「加入阴影」让上色按当前坡度叠明暗，
            只改亮度、不改色相，平地上仍是精确的所选色。
            <br />
            笔刷是正方形，边长恒为奇数：1 格只涂指针所在格，更大的以该格为中心
            向四周对称展开。硬笔=矩形内全强度，软笔=从四边向中心衰减。
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
