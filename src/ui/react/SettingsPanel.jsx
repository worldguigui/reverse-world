import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';

/** 浮点累加会出现 0.30000000000000004，显示前按步长精度收一下 */
const fmt = (v) => Number(Number(v).toFixed(3));

/**
 * 「画面设置」面板：只影响渲染观感，不写进项目文件。
 * 整份设置就是 store 里的 viewConfig，控件直接读写它；各项的取值范围与步长沿用原有约定。
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
 */
function Slider({ label, value, min, max, step, commit = 'live', onChange }) {
  const [draft, setDraft] = useState(value);
  // 数值被外部改掉（如飞行暂停了自动旋转）时跟上；拖动期间 value 没变，不会打断手上的操作
  useEffect(() => setDraft(value), [value]);
  const shown = commit === 'release' ? draft : value;
  const send = (v) => onChange(fmt(v));

  return (
    <label className="set-row">
      <span className="set-row-top">
        <span>{label}</span>
        <span className="set-val">{fmt(shown)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => (commit === 'release' ? setDraft(Number(e.target.value)) : send(e.target.value))}
        // 松手（或键盘调完后抬手）再提交，避免拖一次就重建一遍
        onPointerUp={() => commit === 'release' && send(draft)}
        onKeyUp={() => commit === 'release' && send(draft)}
      />
    </label>
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

      <Group title="🎨 大气与星空">
        <Check label="大气层" checked={config.atmosphere.enabled}
          onChange={(v) => set({ atmosphere: { enabled: v } })} />
        <Color label="大气颜色" value={config.atmosphere.color}
          onChange={(v) => set({ atmosphere: { color: v } })} />
        <Slider label="大气强度" value={config.atmosphere.strength} min={0} max={3} step={0.05}
          onChange={(v) => set({ atmosphere: { strength: v } })} />
        <Check label="星空" checked={config.stars.enabled}
          onChange={(v) => set({ stars: { enabled: v } })} />
        <Slider label="星星数量" value={config.stars.count} min={0} max={12000} step={100} commit="release"
          onChange={(v) => set({ stars: { count: v } })} />
      </Group>

      <Group title="💡 光照">
        <Slider label="主光" value={config.light.key} min={0} max={4} step={0.05}
          onChange={(v) => set({ light: { key: v } })} />
        <Slider label="环境光" value={config.light.ambient} min={0} max={2} step={0.05}
          onChange={(v) => set({ light: { ambient: v } })} />
      </Group>

      <Group title="🏔 地形">
        <Slider label="地形夸张" value={config.terrain.exaggeration} min={0} max={0.15} step={0.005}
          onChange={(v) => set({ terrain: { exaggeration: v } })} />
      </Group>

      <Group title="📍 事件与路线">
        <Slider label="事件光点 px" value={config.markers.dotPx} min={8} max={44} step={1}
          onChange={(v) => set({ markers: { dotPx: v } })} />
        <Slider label="路线宽度 px" value={config.markers.routeWidth} min={1} max={8} step={0.5}
          onChange={(v) => set({ markers: { routeWidth: v } })} />
        <Slider label="区域填充浓度" value={config.markers.fillOpacity} min={0} max={0.8} step={0.01}
          onChange={(v) => set({ markers: { fillOpacity: v } })} />
      </Group>

      <Group title="📷 视角">
        <Slider label="视场角 FOV" value={config.camera.fov} min={20} max={90} step={1}
          onChange={(v) => set({ camera: { fov: v } })} />
        {/* 球可以往任意方向连续翻滚，转晕了就按这个把「上」掰回正北 */}
        <button className="btn" onClick={() => resetView()}>🧭 复位视角（正北朝上）</button>
        <Check label="自动旋转" checked={config.rotation.enabled}
          onChange={(v) => set({ rotation: { enabled: v } })} />
        <Slider label="旋转速度 °/s" value={config.rotation.speed} min={0} max={5} step={0.05}
          onChange={(v) => set({ rotation: { speed: v } })} />
      </Group>
    </div>
  );
}
