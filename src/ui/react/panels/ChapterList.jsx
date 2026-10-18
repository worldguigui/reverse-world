import { useStore } from '../../../store/index.js';
import { formatYear } from '../../../core/timeline.js';
import { useProjectRevision } from '../hooks.js';
import { BackToOverview } from '../common.jsx';

/**
 * 章节清单：顶栏「章节」入口落到这里，改名、删除、翻章都在这一页。
 *
 * 章节是独立对象，事件用 groupId 挂上来——所以一个事件都没有的章节是合法状态
 * （写大纲的常态），也能先建好再往里装。
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
  const addGroup = useStore((s) => s.addGroup);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const groupSpan = useStore((s) => s.groupSpan);
  useProjectRevision(); // 事件换了章节，这里每条后面的条数与范围都要重算

  const groups = project?.groups ?? [];
  const countOf = (id) => project.events.filter((e) => e.groupId === id).length;

  return (
    <div className="insp-block">
      <div className="insp-title">章节</div>

      {groups.length === 0 ? (
        <p className="insp-hint">
          还没有章节。把事件分进章节之后，长卷顶上会多出一排标签，点谁看谁。
        </p>
      ) : (
        <div className="chap-list">
          {groups.map((g) => {
            const n = countOf(g.id);
            const span = spanText(groupSpan(g.id));
            return (
              <div className="chap-row" key={g.id}>
                <input
                  className="inp"
                  defaultValue={g.name}
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
                    onClick={() => setViewFilter({ groupIds: [g.id], characterId: null, activeSnapshotIds: [] })}
                  >
                    看
                  </button>
                  <button
                    className="btn btn-mini btn-danger"
                    title="删除章节"
                    onClick={() => {
                      if (confirm('删除章节？组里的事件会退回「未分组」，事件本身一条都不删。')) {
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

      <button className="btn btn-primary" id="chap-new" onClick={() => addGroup()}>
        ＋ 新建章节
      </button>
      <BackToOverview />
    </div>
  );
}
