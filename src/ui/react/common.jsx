import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { normalizeTime } from '../../core/datetime.js';

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

/**
 * 挂人时的候选：已经挂上的不再出现。
 * 不截断条数——菜单本身限高并可滚动，按条数截断只会让第 9 个以后的名字永远选不到。
 */
function matchCharacters(characters, taken, query) {
  return searchCharacters(characters, query, taken);
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

  // 候选可能比菜单高；键盘移到看不见的那条时把它滚进视野
  const hitRef = useRef(null);
  useEffect(() => {
    hitRef.current?.scrollIntoView({ block: 'nearest' });
  }, [hit, query]);

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
                  ref={i === hit ? hitRef : null}
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
 * 章节候选：已经挂上的不再出现；名字开头命中的排在名字中间命中的前面。
 * 不截断条数，理由同人物候选：菜单自己会滚动，截断只会让后面的章节选不到。
 */
function matchGroups(groups, taken, query) {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const scored = [];
  for (const g of groups) {
    if (taken.includes(g.id)) continue;
    const name = g.name.toLowerCase();
    const rank = name.startsWith(key) ? 0 : name.includes(key) ? 1 : -1;
    if (rank >= 0) scored.push({ g, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((x) => x.g);
}

/**
 * 「所属章节」：与「涉及人物」同一套搜索下拉——常态只列出已经挂上的章节，
 * 其余的在搜索框里敲字才浮出来。
 *
 * 早先这里把项目里每一章都铺成一排可勾的 tag，没挂上的章节也留在原地（只差描边），
 * 于是「威廉二世」这一章会出现在每一条事件下面，看上去像所有事件都属于他。
 * 现在没挂上的章节在界面上完全不占位置，一条事件属于哪几章，看到的就只有哪几章。
 *
 * 一条事件可以同时挂进多章；点已完成章节上的 ✕ 或再搜一次即可摘掉。
 *
 * @param {string[]} ids 已挂上的章节 id
 * @param {(ids: string[]) => void} onChange 变化后的完整清单
 */
export function GroupPicker({ ids = [], onChange }) {
  const project = useStore((s) => s.project);
  const groups = project?.groups ?? [];
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [hit, setHit] = useState(0);

  const picked = ids.map((id) => groups.find((g) => g.id === id)).filter(Boolean);
  const cands = matchGroups(groups, ids, query);
  // 输着字且光标还在框里时才展开候选；一失焦就收，免得挡住下面的字段
  const open = focused && query.trim().length > 0;

  // 候选可能比菜单高；键盘移到看不见的那条时把它滚进视野
  const hitRef = useRef(null);
  useEffect(() => {
    hitRef.current?.scrollIntoView({ block: 'nearest' });
  }, [hit, query]);

  const add = (id) => {
    onChange([...ids, id]);
    setQuery('');
    setHit(0); // 候选换了一批，高亮位要退回第一条，否则会指到不存在的那一行上
  };

  const onKeyDown = (e) => {
    // 输入法还在组字时，回车是在确认候选字，不是在选章节
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

  if (!groups.length) {
    return <p className="insp-hint">还没有章节。顶栏「章节」里建一个，再来归类。</p>;
  }

  return (
    <div className="char-pick">
      {picked.length === 0 ? (
        <p className="insp-hint">还没有所属章节，在下面搜一章。</p>
      ) : (
        <div className="chips">
          {picked.map((g) => (
            <button
              key={g.id}
              type="button"
              className="chip on"
              title="点一下从这一章里移除"
              onClick={() => onChange(ids.filter((x) => x !== g.id))}
            >
              <span className="chip-name">{g.name}</span>
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
          placeholder="搜索章节"
          onChange={(e) => { setQuery(e.target.value); setHit(0); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {open && (
          <div className="char-menu">
            {cands.length === 0 ? (
              <p className="char-none">没有匹配的章节</p>
            ) : (
              cands.map((g, i) => (
                <button
                  key={g.id}
                  ref={i === hit ? hitRef : null}
                  type="button"
                  className={`char-opt${i === hit ? ' hit' : ''}`}
                  // 与人物候选同一个坑：按下时挡住默认行为，别让候选抢走输入框焦点
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHit(i)}
                  onClick={() => add(g.id)}
                >
                  <span className="char-name">{g.name}</span>
                  <span className="char-alias">{g.eventIds?.length ?? 0} 条事件</span>
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

/**
 * 事件 / 人物的时间输入：Y、YM、YMD、YMDH、YMDHM、YMDHMS 都可，空格后写备注。
 *
 * 与 YearInput 一样失焦或回车才提交；提交后只把各段补零并回写，没写的月日时分秒不会补。
 * 日期与小时之间必须用 T——空格留给备注。非法输入退回上一次的有效值。
 *
 * @param {string|null} value 规范时间串
 * @param {(value: string|null) => void} onChange
 * @param {string} placeholder 空值时的提示语
 */
export function TimeInput({ value, onChange, placeholder = '如 1914、1914-06、1914-06-28T08:30' }) {
  const shown = normalizeTime(value) ?? '';
  const ref = useRef(null);

  // 外部值变了（例如切换到另一条事件）就同步到输入框；正在输入时不打断
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.value = shown;
  }, [shown]);

  const commit = (raw) => {
    const text = raw.trim();
    if (!text) {
      if (ref.current) ref.current.value = '';
      onChange(null);
      return;
    }
    const normalized = normalizeTime(text);
    if (!normalized) {
      if (ref.current) ref.current.value = shown;
      return;
    }
    if (ref.current) ref.current.value = normalized;
    onChange(normalized);
  };

  return (
    <input
      ref={ref}
      className="inp"
      type="text"
      spellCheck={false}
      placeholder={placeholder}
      defaultValue={shown}
      title="格式：1914 / 1914-06 / 1914-06-28 / 1914-06-28T08 / 1914-06-28T08:30 / 1914-06-28T08:30:15；空格后可写备注"
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
    />
  );
}

/**
 * 经纬度输入：失焦或回车提交，并夹到合法区间。
 * 用 value 做 key 是为了让球面重新选点或提交后的规范值能立刻回显——
 * 输入框在编辑过程中保持非受控，不会每敲一个字符就回写 store。
 */
export function CoordInput({ id, value, min, max, onChange, placeholder = '' }) {
  const shown = typeof value === 'number' ? value.toFixed(4) : '';
  const commit = (raw, input) => {
    const text = raw.trim();
    const n = Number(text);
    if (!text || !Number.isFinite(n)) {
      input.value = shown;
      return;
    }
    onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <input
      id={id}
      key={shown}
      className="inp"
      type="text"
      inputMode="decimal"
      placeholder={placeholder}
      defaultValue={shown}
      onBlur={(e) => commit(e.target.value, e.target)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
    />
  );
}
