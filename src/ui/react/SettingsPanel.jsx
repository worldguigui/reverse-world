import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import {
  STARS_COUNT_MIN, STARS_COUNT_MAX, TERRAIN_MESH_SEGMENTS,
} from '../../config.js';

/** 浮点累加会出现 0.30000000000000004，显示前按步长精度收一下 */
const fmt = (v) => Number(Number(v).toFixed(3));

/**
 * 「画面设置」面板：只影响渲染观感，不写进项目文件。
 * 大部分控件直接读写 store 里的 viewConfig；视角档位是当前镜头状态，
 * 与滚轮共用同一个数，所以走单独的 cameraLevel，不落盘。
 */

/** 分组小标题 */
function Group({ title, children }) {
  return (
    <div className="set-group">
      <div className="set-head">{title}</div>
      {children}
    </div>
  );
}

/**
 * 滑块。commit='release' 用于代价高的设置（如重建星场）：
 * 拖动过程中只更新本地显示，松手才真正写进 store。
 * format 只改显示文本，不改提交的值。
 * nudgeStep 是 ± 按钮一次走多远：默认与滑块步长一致；显示值四舍五入过的项
 * （如镜头档位只显示整数）要单独给一个看得见变化的步长。
 */
function Slider({
  label, value, min, max, step, commit = 'live', format = fmt, nudgeStep = step, onChange,
}) {
  const [draft, setDraft] = useState(value);
  // 数值被外部改掉（如滚轮改了镜头档位）时跟上；拖动期间 value 没变，不会打断手上的操作
  useEffect(() => setDraft(value), [value]);
  const shown = commit === 'release' ? draft : value;
  const send = (v) => onChange(fmt(v));

  // 从当前显示值朝 min 对齐到格点，再跨一格；这样 0.1+0.2 不会攒出浮点尾巴
  const nudge = (dir) => {
    const k = Math.round((shown - min) / nudgeStep);
    send(Math.min(max, Math.max(min, min + (k + dir) * nudgeStep)));
  };

  return (
    // 不能再用 <label> 包整行：里面有 ± 两个按钮，点标签空白会把第一个按钮当成
    // 被标注的控件一起触发。范围输入用 aria-label 保留读屏名称。
    <div className="set-row">
      <span className="set-row-top">
        <span>{label}</span>
        <span className="set-val">{format(shown)}</span>
      </span>
      {/* ± 放在滑块两端，数字仍留在上方原来的位置 */}
      <span className="set-slider">
        <button
          type="button"
          className="set-step"
          title={`减小 ${nudgeStep}`}
          disabled={shown <= min}
          onClick={() => nudge(-1)}
        >
          -
        </button>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={shown}
          onChange={(e) => (commit === 'release' ? setDraft(Number(e.target.value)) : send(e.target.value))}
          // 松手（或键盘调完后抬手）再提交，避免拖一次就重建一遍
          onPointerUp={() => commit === 'release' && send(draft)}
          onKeyUp={() => commit === 'release' && send(draft)}
        />
        <button
          type="button"
          className="set-step"
          title={`增大 ${nudgeStep}`}
          disabled={shown >= max}
          onClick={() => nudge(1)}
        >
          +
        </button>
      </span>
    </div>
  );
}

/** 各档网格精度的说明；2048 只有在 2048 宽的地图上才会真正一一对应 */
const MESH_HINT = {
  256: '极低精度，最省性能；夸张后山形会明显变块',
  512: '流畅精度（默认），省性能，山形较粗',
  1024: '标准精度，山形较细',
  2048: '最高精度，较吃显卡；地图宽 2048 时可完整使用高度图',
};

/** 分段选择：用于只有几个固定档位的设置 */
function Choice({ label, value, hint, options, onChange }) {
  return (
    <div className="set-row">
      <span>{label}</span>
      <div
        className="set-choice"
        role="group"
        aria-label={label}
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((v) => (
          <button
            key={v}
            type="button"
            className={`set-choice-btn${v === value ? ' active' : ''}`}
            aria-pressed={v === value}
            onClick={() => onChange(v)}
          >
            {v}
          </button>
        ))}
      </div>
      {hint && <span className="set-note">{hint}</span>}
    </div>
  );
}

/** 勾选框 */
function Check({ label, checked, onChange }) {
  return (
    <label className="set-check">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** 颜色选择 */
function Color({ label, value, onChange }) {
  return (
    <label className="set-row">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const config = useStore((s) => s.viewConfig);
  const setViewConfig = useStore((s) => s.setViewConfig);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const resetView = useStore((s) => s.resetView);
  const cameraLevel = useStore((s) => s.cameraLevel);
  const setCameraLevel = useStore((s) => s.setCameraLevel);
  // 收起时整个渲染成空，容器靠 #settings:empty 隐掉（与检查器同一套办法）
  if (!open) return null;

  // 每次只改一项，其余原样深合并
  const set = (patch) => setViewConfig(patch);

  return (
    <div className="insp-block">
      <div className="set-row-top">
        <div className="insp-title">⚙ 画面设置</div>
        <button className="icon-btn" title="收起" onClick={() => setSettingsOpen(false)}>✕</button>
      </div>

      <Group title="大气与星空">
        <Check label="大气层" checked={config.atmosphere.enabled}
          onChange={(v) => set({ atmosphere: { enabled: v } })} />
        <Color label="大气颜色" value={config.atmosphere.color}
          onChange={(v) => set({ atmosphere: { color: v } })} />
        <Slider label="大气强度" value={config.atmosphere.strength} min={0} max={3} step={0.05}
          onChange={(v) => set({ atmosphere: { strength: v } })} />
        <Check label="星空" checked={config.stars.enabled}
          onChange={(v) => set({ stars: { enabled: v } })} />
        <Slider label="星星数量" value={config.stars.count} min={STARS_COUNT_MIN} max={STARS_COUNT_MAX} step={1} commit="release"
          onChange={(v) => set({ stars: { count: v } })} />
      </Group>

      <Group title="光照">
        <Slider label="主光" value={config.light.key} min={0} max={4} step={0.05}
          onChange={(v) => set({ light: { key: v } })} />
        <Slider label="环境光" value={config.light.ambient} min={0} max={2} step={0.05}
          onChange={(v) => set({ light: { ambient: v } })} />
      </Group>

      <Group title="地形">
        <Choice
          label="地形网格"
          value={config.terrain.meshSegments}
          hint={MESH_HINT[config.terrain.meshSegments]}
          options={TERRAIN_MESH_SEGMENTS}
          onChange={(v) => set({ terrain: { meshSegments: v } })}
        />
        <Slider label="地形夸张" value={config.terrain.exaggeration} min={0} max={0.15} step={0.005}
          onChange={(v) => set({ terrain: { exaggeration: v } })} />
      </Group>

      <Group title="事件与路线">
        <Slider label="事件光点 px" value={config.markers.dotPx} min={8} max={44} step={1}
          onChange={(v) => set({ markers: { dotPx: v } })} />
        <Slider label="路线宽度 px" value={config.markers.routeWidth} min={1} max={8} step={0.5}
          onChange={(v) => set({ markers: { routeWidth: v } })} />
        <Slider label="区域填充浓度" value={config.markers.fillOpacity} min={0} max={0.8} step={0.01}
          onChange={(v) => set({ markers: { fillOpacity: v } })} />
      </Group>

      <Group title="视角">
        {/* 与滚轮共用「当前档位」：拖动滑块就是缩放，滚轮转了滑块也跟着走。
            数字与「事件镜头档位」同一套 1–64；滚轮拉远超过出厂（档位 <1）时滑块停在 1。 */}
        <Slider label="视角镜头档位" value={cameraLevel}
          min={1} max={64} step={0.01} nudgeStep={1}
          format={(v) => Math.max(1, Math.round(v))}
          onChange={(v) => setCameraLevel(v)} />
        {/* 点开一条事件时镜头落到哪一档，1 = 出厂视角，64 = 推到底再加满镜头倍率 */}
        <Slider label="事件镜头档位" value={config.camera.eventLevel} min={1} max={64} step={1}
          onChange={(v) => set({ camera: { eventLevel: v } })} />
        {/* 球可以往任意方向连续翻滚，转晕了就按这个把「上」掰回正北 */}
        <button className="btn" onClick={() => resetView()}>视角复位</button>
        <Check label="自动旋转" checked={config.rotation.enabled}
          onChange={(v) => set({ rotation: { enabled: v } })} />
        <Slider label="旋转速度 °/s" value={config.rotation.speed} min={0} max={5} step={0.05}
          onChange={(v) => set({ rotation: { speed: v } })} />
      </Group>
    </div>
  );
}
