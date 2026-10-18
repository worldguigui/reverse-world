import { useRef } from 'react';
import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { timeDomain, timeTicks, formatYear } from '../../core/timeline.js';
import { isViewFiltered } from '../../core/project.js';
import { Chronicle } from './Chronicle.jsx';

/**
 * 底部时间轴：一条按时间线性铺开的轴 + 一根可拖的游标，外加编年史入口。
 *
 * 轴上没有「槽位」这个概念——刻度由事件自己的年份算出来，游标是一根连续的数轴。
 * 定义域里一条带时间的对象都没有时整根轴不出现：纯地理的世界不需要叙事轴。
 */
export function Timeline() {
  const project = useStore((s) => s.project);
  const cursor = useStore((s) => s.cursor);
  const stepCursor = useStore((s) => s.stepCursor);
  const jumpToEvent = useStore((s) => s.jumpToEvent);
  const toggleChronicle = useStore((s) => s.toggleChronicle);
  const viewFilter = useStore((s) => s.viewFilter);
  useProjectRevision(); // 事件的年份改了，轴上的刻度要跟着重排

  const trackRef = useRef(null);
  const dragging = useRef(false);

  const domain = timeDomain(project);
  // 收窄视图只收窄画在轴上的刻度：轴的跨度与游标照旧，拖与点都不受影响。
  // 选中的章节、实时人物筛与临时章节都在 viewFilter 里，轴上与长卷看到的是同一批事件
  const ticks = timeTicks(project, viewFilter);
  const filtering = isViewFiltered(viewFilter);
  const span = domain ? domain.end - domain.start : 0;
  const posOf = (year) => (span > 0 ? ((year - domain.start) / span) * 100 : 0);

  if (!project || !domain) return null;

  const yearAt = (clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width < 2) return null;
    const t = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return domain.start + t * span;
  };

  const scrub = (clientX) => {
    const y = yearAt(clientX);
    if (y != null) useStore.getState().setCursorYear(y);
  };

  const onPointerDown = (e) => {
    // 点在刻度上就交给刻度自己处理，别在这里又拖一次游标
    if (e.target.closest('.tl-tick')) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub(e.clientX);
  };
  const onPointerMove = (e) => { if (dragging.current) scrub(e.clientX); };
  const onPointerUp = (e) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <>
      <Chronicle />

      <div className="tl-inner">
        {/* 读数只报游标停在哪一年。「讲的是哪一条」由长卷高亮与检查器说了算——
            这里再报一遍事件标题就是第三个信号，同年里挤着好几条时它挑不准，
            反倒与另外两处打架 */}
        <div className="tl-readout" title="当前游标所在的年份">
          <span className="tl-year">{formatYear(cursor)}</span>
          {ticks.length === 0 && (
            <span className="tl-near">{filtering ? '筛选内没有事件' : '还没有事件'}</span>
          )}
        </div>

        <button className="tl-arrow" title="上一个刻度 (←)" onClick={() => stepCursor(-1)}>◀</button>

        <div
          className="tl-track"
          ref={trackRef}
          title="拖动游标，或单击轴上任意一年"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {ticks.map((t) => {
            // 有终点的刻度拉一根横线表示区间；没有终点就只是孤零零一个点
            const end = typeof t.to === 'number' && t.to > t.from ? t.to : null;
            const atCursor = Math.abs(t.from - cursor) < (span > 0 ? span * 0.004 : 1);
            return (
              <span key={t.id}>
                {end != null && (
                  <span
                    className="tl-span"
                    style={{ left: `${posOf(t.from)}%`, width: `${posOf(end) - posOf(t.from)}%` }}
                  />
                )}
                <button
                  className={`tl-tick${atCursor ? ' at-cursor' : ''}`}
                  style={{ left: `${posOf(t.from)}%` }}
                  title={`${t.title} · ${formatYear(t.from)}`}
                  onClick={() => jumpToEvent(t.id)}
                />
              </span>
            );
          })}
          <span className="tl-cursor" style={{ left: `${posOf(cursor)}%` }} />
        </div>

        <button className="tl-arrow" title="下一个刻度 (→)" onClick={() => stepCursor(1)}>▶</button>

        <button className="tl-arrow" id="tl-chronicle" title="编年史长卷：全部事件" onClick={toggleChronicle}>📜</button>
      </div>
    </>
  );
}
