import { useState } from 'react';
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
 * 按名字或别名检索人物。exclude 里的 id 不进结果。
 *
 * 名字开头命中的排在名字中间命中的前面，都排在只命中别名的前面：
 * 敲「威尔逊」时正主该在第一条，而别名里带这两个字的另一位要沉到后面去。
 * 同分的保持录入先后（sort 稳定），不再另排。
 *
 * 编年史的按姓名筛也走这一套：「搜得到谁」在两处必须一致。
 */
export function searchCharacters(characters, query, exclude = []) {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const scored = [];
  for (const c of characters) {
    if (exclude.includes(c.id)) continue;
    const name = c.name.toLowerCase();
    const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
    const rank = name.startsWith(key) ? 0
      : name.includes(key) ? 1
        : aliases.some((a) => a.includes(key)) ? 2 : -1;
    if (rank >= 0) scored.push({ c, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((x) => x.c);
}

/** 挂人时的候选：已经挂上的不再出现，最多列 8 条 */
function matchCharacters(characters, taken, query) {
  return searchCharacters(characters, query, taken).slice(0, 8);
}

/**
 * 「涉及人物」：常态只列出已经挂上的那几位，其余的去搜索里找。
 *
 * 早先的写法是把项目里所有人物铺成一排可勾的 tag。人物一多，检查器里先长出一面
 * 别人的名字墙，真正要看的「这条事件都有谁」被淹在里面；而且没挂上的人跟挂上的人
 * 只差一点描边颜色，扫一眼分不出。现在反过来：已选的留成 tag，没选的只在敲了字之后
 * 才作为候选浮出来，一个都不敲就一个都不显示。
 *
 * 名字与别名一起搜——史料里同一个人常以称号出现，只认正名会搜不到。
 *
 * 它是受控的——结果由调用方写回数据，所以新建事件（写草稿）与编辑已有事件（写数据）
 * 共用一套，差别只在往哪儿写。
 *
 * @param {string[]} ids 已挂上的人物 id
 * @param {(ids: string[]) => void} onChange 变化后的完整清单
 */
export function CharacterPicker({ ids = [], onChange }) {
  const project = useStore((s) => s.project);
  const characters = project?.characters ?? [];
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [hit, setHit] = useState(0);

  const picked = ids.map((id) => characters.find((c) => c.id === id)).filter(Boolean);
  const cands = matchCharacters(characters, ids, query);
  // 输着字且光标还在框里时才展开候选；面板一失焦就收，免得挡住下面的字段
  const open = focused && query.trim().length > 0;

  const add = (id) => {
    onChange([...ids, id]);
    setQuery('');
    setHit(0); // 候选换了一批，高亮位要退回第一条，否则会指到不存在的那一行上
  };

  const onKeyDown = (e) => {
    // 输入法还在组字时，回车是在确认候选字，不是在选人物
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      setQuery('');
      e.currentTarget.blur();
      return;
    }
    if (!cands.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHit((i) => (i + 1) % cands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHit((i) => (i - 1 + cands.length) % cands.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(cands[Math.min(hit, cands.length - 1)].id);
    }
  };

  if (!characters.length) {
    return <p className="insp-hint">还没有人物。用顶栏的「🧝 人物」先录几位进来。</p>;
  }

  return (
    <div className="char-pick">
      {picked.length === 0 ? (
        <p className="insp-hint">还没有涉及人物，在下面搜一个名字。</p>
      ) : (
        <div className="chips">
          {picked.map((c) => (
            <button
              key={c.id}
              type="button"
              className="chip on"
              title="点一下从这条事件里移除"
              onClick={() => onChange(ids.filter((x) => x !== c.id))}
            >
              <span className="chip-name">{c.name}</span>
              <span className="chip-x">✕</span>
            </button>
          ))}
        </div>
      )}

      <div className="char-search">
        <input
          className="inp"
          type="text"
          value={query}
          placeholder="搜索人物（名字或别名）"
          onChange={(e) => { setQuery(e.target.value); setHit(0); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {open && (
          <div className="char-menu">
            {cands.length === 0 ? (
              <p className="char-none">没有匹配的人物</p>
            ) : (
              cands.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  className={`char-opt${i === hit ? ' hit' : ''}`}
                  // 按下时挡掉默认行为，别让候选抢走输入框的焦点：
                  // 一失焦候选就收起来，紧接着的 click 落在一张已经不存在的列表上，点了白点
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHit(i)}
                  onClick={() => add(c.id)}
                >
                  <i className="char-dot" style={{ background: c.color }} />
                  <span className="char-name">{c.name}</span>
                  {c.aliases?.length > 0 && <span className="char-alias">{c.aliases.join('、')}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>
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
    return <p className="insp-hint">还没有章节。顶栏「章节」里建一个，再来归类。</p>;
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
