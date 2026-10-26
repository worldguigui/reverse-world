import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store/index.js';
import { formatYear } from '../../../core/timeline.js';
import { useProjectRevision } from '../hooks.js';
import { BackToOverview } from '../common.jsx';

/**
 * 章节清单：顶栏「章节」入口落到这里，改名、删除、翻章都在这一页。
 *
 * 章节自己拥有事件清单（eventIds），一个事件可以同时属于多章——所以一个事件都没有的
 * 章节是合法状态（写大纲的常态），先建好再往里装也没问题。姓名搜索生成的章节
 * 也只是普通的一章，在这里和手动建的完全一样。
 */

/** 章节的时间范围写成一截标签：只有一年就只写那一年，算不出来就不写 */
function spanText(span) {
  if (!span) return '';
  const from = formatYear(span.min);
  return span.min === span.max ? from : `${from}–${formatYear(span.max)}`;
}

export function ChapterList() {
  const project = useStore((s) => s.project);
  const setViewFilter = useStore((s) => s.setViewFilter);
  const setChronicleOpen = useStore((s) => s.setChronicleOpen);
  const addGroup = useStore((s) => s.addGroup);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const groupSpan = useStore((s) => s.groupSpan);
  useProjectRevision(); // 事件换了章节，这里每条后面的条数与范围都要重算

  const groups = project?.groups ?? [];
  const countOf = (g) => g.eventIds?.length ?? 0;
  // 章节清单的搜索框：按章节名过滤，空着就照原顺序列全部。
  // 正在改名的这一行不参与过滤——否则把「威廉二世」改成不含搜索词的名字时，
  // 输入框会跟着整行一起消失，打到一半的字就没了。
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const editRef = useRef(null);
  const key = query.trim().toLowerCase();
  const shown = key
    ? groups.filter((g) => g.id === editingId || g.name.toLowerCase().includes(key))
    : groups;

  // 新章节刚建出来时要滚进视野；切到已有行编辑同样保证它没被列表裁掉
  useEffect(() => {
    if (editingId) editRef.current?.scrollIntoView({ block: 'nearest' });
  }, [editingId, groups.length]);

  return (
    <div className="insp-block insp-list-page">
      <div className="insp-title">章节</div>

      {groups.length === 0 ? (
        <p className="insp-hint">
          还没有章节。把事件分进章节之后，长卷顶上会多出一排标签，点谁看谁。
        </p>
      ) : (
        <>
          <input
            className="inp"
            type="text"
            value={query}
            placeholder="搜索章节"
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className="insp-hint">没有匹配的章节。</p>
          ) : (
            <div className="chap-list">
              {shown.map((g) => {
                const n = countOf(g);
                const span = spanText(groupSpan(g.id));
                return (
                  <div className="chap-row" key={g.id} ref={g.id === editingId ? editRef : null}>
                    <input
                      className="inp"
                      defaultValue={g.name}
                      autoFocus={g.id === editingId}
                      onFocus={() => setEditingId(g.id)}
                      onBlur={() => setEditingId(null)}
                      onChange={(e) => updateItem('group', g.id, { name: e.target.value })}
                    />
                    <div className="chap-meta">
                      <span className="insp-hint">
                        {n ? `${n} 条事件${span ? ` · ${span}` : ''}` : '空章节'}
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        className="btn btn-mini"
                        title="只看这一章：取消其他选中，长卷、时间轴刻度、球上的事件一起收窄"
                        onClick={() => {
                          setViewFilter({ groupIds: [g.id], characterId: null });
                          setChronicleOpen(true);
                        }}
                      >
                        Go
                      </button>
                      <button
                        className="btn btn-mini btn-danger"
                        title="删除章节"
                        onClick={() => {
                          if (confirm('删除章节？章节只是事件的一种归类，事件本身一条都不删。')) {
                            deleteItem('group', g.id);
                          }
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <button
        className="btn btn-primary"
        id="chap-new"
        title={key ? '新建章节并清空搜索，让新行立刻可见' : '新建章节'}
        onClick={() => {
          const g = addGroup();
          if (!g) return;
          // 搜索词非空时新章节多半不匹配，不清掉搜索就会“点了没反应”
          setQuery('');
          setEditingId(g.id);
        }}
      >
        ＋ 新建章节
      </button>
      <BackToOverview />
    </div>
  );
}
