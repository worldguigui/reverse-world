import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import * as W from '../workshop-session.js';

/**
 * 地形工具箱按用途分成七块：形态、颜色、阴影、实时预览、颜色盘、地图操作、画布交互。
 * 形态与颜色是笔刷，阴影/预览/颜色盘是设置，地图操作是命令，画布交互只是快捷键说明。
 * 笔刷统一是正方形，边长恒为奇数：1 格只涂指针所在格，更大的以该格为中心对称展开。
 */
const SHAPE_TOOLS = [
  ['raise', '抬升', '点一下让一个区域变高'],
  ['lower', '压低', '点一下让一个区域变低'],
  ['smooth', '抹平', '把陡的区域磨平'],
];

/**
 * 画布本身是网格自带的节点，塞进来后按「一格一 CSS 像素」摆好，缩放交给 transform。
 * 尺寸由 workshop-session 在 attachCanvas 时写死（跟着网格分辨率走），这里只管定位与像素感。
 */
const CANVAS_STYLE = 'position:absolute;left:0;top:0;transform-origin:0 0;'
  + 'image-rendering:pixelated;cursor:crosshair;background:#000;touch-action:none;display:block;';

/**
 * 当前颜色行：排版与颜色盘一致，左侧色块、中间名称、右侧箭头。
 * 它与预设色不同——中间只显示色值，不承担「套用」动作；点色块或箭头才打开取色器。
 * 整行刻意不包成 <label>：取色器开着时点名称应当关掉它，而标签会再次激活输入框、把弹窗重新拉起来。
 */
function ColorField({ label, value, title, onChange }) {
  const inputRef = useRef(null);
  return (
    <div className="wk-preset" title={title}>
      <label className="wk-preset-swatch" style={{ background: value }}>
        <input
          ref={inputRef}
          type="color"
          aria-label={`修改${label}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <div className="wk-preset-apply is-static">
        <b>{label}</b>
        <span>{value.toUpperCase()}</span>
      </div>
      <button
        type="button"
        className="wk-preset-arrow"
        aria-label={`修改${label}`}
        onClick={() => inputRef.current?.click()}
      >
        ›
      </button>
    </div>
  );
}

/** 开关行：整行可点，右侧是滑块样式的开关 */
function ToggleRow({ label, checked, title, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`wk-toggle-row${checked ? ' on' : ''}`}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span className="wk-switch" aria-hidden="true" />
    </button>
  );
}

/**
 * 预设色：点中间的名字把预设色设为上色颜色并切到上色笔；
 * 点左侧色块或右侧箭头只改预设色本身，不动当前上色颜色。
 */
function PresetRow({ label, value, title, onApply, onChange }) {
  const inputRef = useRef(null);
  return (
    <div className="wk-preset" title={title}>
      <label className="wk-preset-swatch" style={{ background: value }}>
        <input
          ref={inputRef}
          type="color"
          aria-label={`修改${label}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <button type="button" className="wk-preset-apply" onClick={onApply}>
        <b>{label}</b>
        <span>点击套用到上色颜色中</span>
      </button>
      <button
        type="button"
        className="wk-preset-arrow"
        aria-label={`修改${label}`}
        onClick={() => inputRef.current?.click()}
      >
        ›
      </button>
    </div>
  );
}

/** 分区卡片：左侧标题，右侧可带一句小注 */
function Section({ title, note, children }) {
  return (
    <section className="wk-card">
      <div className="wk-sec-head">
        <span className="wk-sec-title">{title}</span>
        {note && <span className="wk-sec-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * 地图工坊：全屏栅格绘制。
 * 面板外壳与控件由 React 渲染，画笔涂抹与撤销仍是命令式（见 ui/workshop-session.js）。
 * @param {{ container: HTMLElement, preview?: { attach: Function, detach: Function } }} props
 *   container 是常驻的 #workshop 容器，用来切 .hidden；
 *   preview 由 main.js 注入，负责把主渲染画布搬进画布右下角的预览框（见下方 effect）
 */
export function Workshop({ container, preview }) {
  const open = useStore((s) => s.workshopOpen);
  const tool = useStore((s) => s.workshopTool);
  const storedSize = useStore((s) => s.workshopSize);
  const strength = useStore((s) => s.workshopStrength);
  const hard = useStore((s) => s.workshopHard);
  const color = useStore((s) => s.workshopColor);
  const paintShadow = useStore((s) => s.workshopPaintShadow);
  const heightColor = useStore((s) => s.workshopHeightColor);
  const landColor = useStore((s) => s.workshopLandColor);
  const oceanColor = useStore((s) => s.workshopOceanColor);
  const previewOn = useStore((s) => s.workshopPreviewOn);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const zoom = useStore((s) => s.workshopZoom);
  const showOverlay = useStore((s) => s.workshopShowOverlay);
  const setWorkshopBrush = useStore((s) => s.setWorkshopBrush);
  const [generating, setGenerating] = useState(false);
  const [previewBig, setPreviewBig] = useState(false);
  const wrapRef = useRef(null);
  const previewRef = useRef(null);

  // 上限跟着当前栅格的分辨率走（见 brushSizeMax）。store 里的值可能是上一张网格留下的，
  // 读数与滑块都夹到当前上限，免得显示一个落不到的数；滑块只停奇数，显示值也取奇数
  const sizeMax = W.brushSizeMax();
  const clampedSize = Math.min(storedSize, sizeMax);
  const size = clampedSize % 2 === 1 ? clampedSize : clampedSize + 1;
  const isHeightTool = tool !== 'paint';

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

  // 主画布平时铺满窗口，被工坊全屏层盖住；打开工坊时把它搬进右下角的预览框，
  // 渲染尺寸缩到框内后，同一个球体就会跟着每一笔实时变化。
  // 关掉预览或工坊时由 detach 搬回 body 并恢复整窗尺寸，主场景不会沿用预览框的宽高比。
  useEffect(() => {
    if (!open || !previewOn || !preview) return undefined;
    const el = previewRef.current;
    if (!el) return undefined;
    preview.attach(el);
    return () => preview.detach();
  }, [open, previewOn, preview]);

  // 每次重新打开都从小窗开始，放大状态不跨会话保留
  useEffect(() => { if (!open) setPreviewBig(false); }, [open]);

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

  const applyPreset = (hex) => setWorkshopBrush({ workshopTool: 'paint', workshopColor: hex });

  return (
    <div className="workshop">
      <div className="wk-top glass">
        <span className="wk-title">地图工坊</span>
        <span className="wk-dim">{`尺寸 ${grid.w}×${grid.h}`}</span>
        <span className="wk-dim">{`缩放 ${Math.round(zoom * 100)}%`}</span>
        <button className="btn btn-mini" onClick={() => W.fitView()}>
          ⤢ 适应窗口
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!canUndo || generating} onClick={() => W.undo()}>↶ 撤销</button>
        <button className="btn" disabled={!canRedo || generating} onClick={() => W.redo()}>↷ 重做</button>
        <button className="btn btn-primary" disabled={generating} onClick={() => W.commitWorkshop()}>✔ 完成</button>
        <button className="btn" disabled={generating} onClick={() => W.cancelWorkshop()}>取消</button>
      </div>

      <div className="wk-body">
        <aside className="wk-side">
          <div className="wk-card wk-side-head">
            <span className="wk-side-title">地形工具箱</span>
          </div>

          <Section title="形态" note="笔刷工具">
            <div className="wk-toolgrid">
              {SHAPE_TOOLS.map(([id, label, tip]) => (
                <button
                  key={id}
                  className={`wk-tool${tool === id ? ' active' : ''}`}
                  aria-pressed={tool === id}
                  title={tip}
                  onClick={() => setWorkshopBrush({ workshopTool: id })}
                >
                  {label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="颜色" note="绘制与参数">
            <button
              className={`wk-tool wk-tool-wide${tool === 'paint' ? ' active' : ''}`}
              aria-pressed={tool === 'paint'}
              title="改变某一像素格子的颜色，开启阴影后，就可以按坡度叠明暗"
              onClick={() => setWorkshopBrush({ workshopTool: 'paint' })}
            >
              <b>上色</b>
              <span>在地图上绘制颜色</span>
            </button>

            <ColorField
              label="上色颜色"
              value={color}
              title="上色笔写入的颜色"
              onChange={(value) => setWorkshopBrush({ workshopColor: value })}
            />
            <ColorField
              label="高度基色"
              value={heightColor}
              title="抬高压低时用到的底色，抬高渐亮、压低渐暗"
              onChange={(value) => setWorkshopBrush({ workshopHeightColor: value })}
            />

            <label className="wk-slider">
              <span className="wk-slider-head">
                <span className="wk-field-label">笔刷边长</span>
                <b>{size} 格</b>
              </span>
              <input
                type="range"
                min={1}
                max={sizeMax}
                step={2}
                value={size}
                title="正方形笔刷的边长"
                onChange={(e) => setWorkshopBrush({ workshopSize: +e.target.value })}
              />
            </label>

            {isHeightTool && (
              <>
                <label className="wk-slider">
                  <span className="wk-slider-head">
                    <span className="wk-field-label">厚度</span>
                    <b>{Math.round(strength * 100)}%</b>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={500}
                    value={Math.round(strength * 100)}
                    title="高度笔每落一笔改变的高度"
                    onChange={(e) => setWorkshopBrush({ workshopStrength: +e.target.value / 100 })}
                  />
                </label>

                <button
                  className={`wk-tool${hard ? ' active' : ''}`}
                  onClick={() => setWorkshopBrush({ workshopHard: !hard })}
                >
                  {hard ? '硬笔（无扩散）' : '软笔（高斯）'}
                </button>
              </>
            )}
          </Section>

          <Section title="阴影">
            <ToggleRow
              label="启用地形阴影"
              checked={paintShadow}
              title="开启后，上色时会按当前地形给所选颜色叠明暗"
              onChange={(checked) => setWorkshopBrush({ workshopPaintShadow: checked })}
            />
          </Section>

          <Section title="实时预览">
            <ToggleRow
              label="显示三维预览"
              checked={previewOn}
              title="在画布右下角显示当前地形对应的三维地球；拖动旋转、滚轮缩放"
              onChange={(checked) => setWorkshopBrush({ workshopPreviewOn: checked })}
            />
          </Section>

          <Section title="颜色盘">
            <PresetRow
              label="陆地初始颜色"
              value={landColor}
              title="点名字把陆地预设色设为上色颜色；点色块或箭头修改预设色"
              onApply={() => applyPreset(landColor)}
              onChange={(value) => setWorkshopBrush({ workshopLandColor: value })}
            />
            <PresetRow
              label="海洋初始颜色"
              value={oceanColor}
              title="点名字把海洋预设色设为上色颜色；点色块或箭头修改预设色"
              onApply={() => applyPreset(oceanColor)}
              onChange={(value) => setWorkshopBrush({ workshopOceanColor: value })}
            />
          </Section>

          <Section title="地图操作">
            <div className="wk-ops">
              <button
                className="wk-op"
                disabled={generating}
                title="用真实地球的高程与河网覆盖整张地图"
                onClick={loadRealEarth}
              >
                <span className="wk-op-text">
                  <b>{generating ? '载入中…' : '载入真实地球'}</b>
                  <span>导入真实地形数据</span>
                </span>
              </button>
              <button
                className={`wk-op${showOverlay ? ' on' : ''}`}
                aria-pressed={showOverlay}
                title="把已有的路线与区域半透明叠在画布上，只读，不能点选或编辑"
                onClick={() => setWorkshopBrush({ workshopShowOverlay: !showOverlay })}
              >
                <span className="wk-op-text">
                  <b>路线区域</b>
                  <span>叠加已有路线与区域</span>
                </span>
              </button>
              <button
                className="wk-op"
                disabled={generating}
                title="整张地图铺成海洋预设色，并压到海平面以下"
                onClick={() => W.resetOcean()}
              >
                <span className="wk-op-text">
                  <b>重置为海洋</b>
                  <span>使用海洋预设色</span>
                </span>
              </button>
              <button
                className="wk-op"
                disabled={generating}
                title="整张地图铺成陆地预设色，并抬到海平面以上"
                onClick={() => W.resetLand()}
              >
                <span className="wk-op-text">
                  <b>重置为陆地</b>
                  <span>使用陆地预设色</span>
                </span>
              </button>
            </div>
          </Section>

          <Section title="画布交互">
            <div className="wk-interact">
              <div className="wk-interact-row">
                <b>移动画布</b>
                <span><kbd className="wk-kbd">Shift</kbd> + 鼠标左键拖动</span>
              </div>
              <div
                className="wk-interact-row"
                title="把三维预览的镜头转到点击的位置；二维画布本身不动"
              >
                <b>定位预览</b>
                <span><kbd className="wk-kbd">Ctrl</kbd> + 鼠标左键点击</span>
              </div>
            </div>
          </Section>
        </aside>

        <div className="wk-canvas-wrap">
          {/* 画布绝对定位在 .wk-stage 里，靠 transform 缩放；外层只管边框与裁切 */}
          <div className="wk-stage" ref={wrapRef} />

          {/* 主渲染画布在打开预览时会被搬进这里；尺寸由 main.js 量取后同步给渲染器 */}
          {previewOn && (
            <div className={`wk-preview${previewBig ? ' big' : ''}`}>
              <div
                className="wk-preview-stage"
                ref={previewRef}
                role="img"
                aria-label="地形实时预览"
              />
              <div className="wk-preview-tools">
                <button
                  type="button"
                  className="wk-preview-btn"
                  title={previewBig ? '缩小预览' : '放大预览'}
                  onClick={() => setPreviewBig((v) => !v)}
                >
                  {previewBig ? '⤡' : '⤢'}
                </button>
                <button
                  type="button"
                  className="wk-preview-btn"
                  title="收起预览；可在这里重新打开"
                  onClick={() => setWorkshopBrush({ workshopPreviewOn: false })}
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
