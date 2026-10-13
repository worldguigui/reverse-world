import { useStore } from '../../store/index.js';

/** 检查器里统一的「小标题 + 控件」排版 */
export function Labeled({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: '4px' }}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/** 从任何详情页回到世界概览 */
export function BackToOverview() {
  const select = useStore((s) => s.select);
  return (
    <button
      className="btn btn-ghost"
      style={{ marginTop: '10px' }}
      onClick={() => select(null)}
    >
      ← 返回概览
    </button>
  );
}

/**
 * 时间点下拉：'' 表示 null（自始 / 至今）。
 * 选中值由数据决定，所以用受控 —— 时间点增删后选项列表会变，非受控会留下过期的选中态。
 */
export function TimeSelect({ value, onChange, nullLabel = '自始' }) {
  const project = useStore((s) => s.project);
  return (
    <select className="inp" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{nullLabel}</option>
      {(project?.timePoints ?? []).map((tp, i) => (
        <option key={tp.id} value={tp.id}>{`${i + 1}. ${tp.label}`}</option>
      ))}
    </select>
  );
}
