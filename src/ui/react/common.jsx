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
 * 「涉及人物」多选：把项目里的人物铺成一排可勾的tag，勾上即挂到这条事件上。
 *
 * 它是受控的——勾选结果由调用方写回数据，所以新建事件与编辑已有事件能共用一套，
 * 差别只在往草稿里写还是往事件上写。
 *
 * @param {string[]} ids 已勾选的人物 id
 * @param {(ids: string[]) => void} onChange 勾选变化后的完整清单
 */
export function CharacterPicker({ ids = [], onChange }) {
  const project = useStore((s) => s.project);
  const characters = project?.characters ?? [];
  if (!characters.length) {
    return <p className="insp-hint">还没有人物。用顶栏的「🧝 人物」先录几位进来。</p>;
  }
  return (
    <div className="chips">
      {characters.map((c) => {
        const on = ids.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            className={`chip${on ? ' on' : ''}`}
            // 勾上的人用自己的配色描边，一眼看清一条事件里都有谁
            style={on ? { borderColor: c.color, color: c.color } : undefined}
            onClick={() => onChange(on ? ids.filter((x) => x !== c.id) : [...ids, c.id])}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 「所属章节」下拉。章节是独立对象，所以这里只能选一个已有的——
 * 建章节、改名、删除都在顶栏「章节」那一页，事件这一侧只管归类。
 *
 * @param {string|null} value 章节 id，空 = 未分组
 * @param {(id: string|null) => void} onChange
 */
export function GroupSelect({ value, onChange }) {
  const project = useStore((s) => s.project);
  const groups = project?.groups ?? [];
  if (!groups.length) {
    return <p className="insp-hint">还没有章节。顶栏「📖 章节」里建一个，再来归类。</p>;
  }
  return (
    <select
      className="inp"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">未分组</option>
      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );
}

/**
 * 年份输入：空 = 该端开放（自始 / 至今）。
 *
 * 用 defaultValue 而不是 value：年份是敲出来的，受控的话每敲一个字符都会回写数据，
 * 「19」→「191」→「1914」中途的每一次都会被当成一次内容改动，触发整层重建。
 * 失焦或回车才提交，中间态留在输入框里。
 *
 * @param {number|null} value 当前年份
 * @param {(year: number|null) => void} onChange
 * @param {string} placeholder 空值时的提示语（自始 / 至今）
 */
export function YearInput({ value, onChange, placeholder = '自始' }) {
  const commit = (raw) => {
    const text = raw.trim();
    if (!text) return onChange(null);
    const n = Number(text);
    if (Number.isFinite(n)) onChange(n);
  };
  return (
    <input
      className="inp"
      type="text"
      inputMode="numeric"
      placeholder={placeholder}
      defaultValue={value ?? ''}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
    />
  );
}
