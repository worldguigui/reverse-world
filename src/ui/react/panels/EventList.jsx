import { useState } from 'react';
import { useStore } from '../../../store/index.js';
import { inView } from '../../../core/project.js';
import { formatTime, compareDateTime } from '../../../core/datetime.js';
import { useProjectRevision } from '../hooks.js';
import { BackToOverview } from '../common.jsx';

/**
 * 事件清单：顶栏「事件」入口落到这里，按时间先后列出全部事件。
 *
 * 未定年的事件排在最后——它们不进编年史与时间轴，但仍是一条正经事件，
 * 在这里总得有个位置。
 */
export function EventList() {
  const project = useStore((s) => s.project);
  const select = useStore((s) => s.select);
  const jumpToEvent = useStore((s) => s.jumpToEvent);
  const setChronicleOpen = useStore((s) => s.setChronicleOpen);
  const viewFilter = useStore((s) => s.viewFilter);
  const setViewFilter = useStore((s) => s.setViewFilter);
  useProjectRevision(); // 改了标题或时间，这一排要跟着重排

  const events = [...(project?.events ?? [])]
    .sort((a, b) => compareDateTime(a.from, b.from));
  const [query, setQuery] = useState('');
  const key = query.trim().toLowerCase();
  const shown = key
    ? events.filter((ev) => ev.title.toLowerCase().includes(key))
    : events;

  /**
   * 「看」不只要打开编年史：还要把游标落到这条事件上，长卷才会滚到它那儿。
   * 当前视图若把这条事件筛掉了，先退出筛选，否则长卷打开了却找不到它。
   */
  const look = (ev) => {
    if (!inView(project, viewFilter, ev)) {
      setViewFilter({ groupIds: [], characterId: null });
    }
    setChronicleOpen(true);
    jumpToEvent(ev.id);
  };

  return (
    <div className="insp-block insp-list-page">
      <div className="insp-title">事件</div>

      {events.length === 0 ? (
        <p className="insp-hint">
          还没有事件。点顶栏中间的「事件」模式新建：在球上单击可以给它坐标，不点也能创建纯叙事事件。
        </p>
      ) : (
        <>
          <input
            className="inp"
            type="text"
            value={query}
            placeholder="搜索事件（标题）"
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className="insp-hint">没有匹配的事件。</p>
          ) : (
            <div className="char-list">
              {shown.map((ev) => (
                <div className="event-row" key={ev.id}>
                  <button
                    className="char-row"
                    title="查看并编辑这条事件"
                    onClick={() => select({ kind: 'event', id: ev.id })}
                  >
                    <b>{ev.from == null ? '未定年' : formatTime(ev.from)}</b>
                    <span>{ev.title}</span>
                  </button>
                  <button
                    className="btn btn-mini"
                    title="在编年史里打开这条事件"
                    onClick={() => look(ev)}
                  >
                    看
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <BackToOverview />
    </div>
  );
}
