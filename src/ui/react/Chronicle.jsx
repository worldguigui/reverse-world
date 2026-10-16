import { useEffect, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { timeTicks, formatYear } from '../../core/timeline.js';

/** 章节标签上的时间范围：只有一年就只写那一年，算不出来就不写 */
function spanText(span) {
  if (!span) return '';
  const from = formatYear(span.min);
  return span.min === span.max ? from : `${from}–${formatYear(span.max)}`;
}

/**
 * 编年史长卷：按时间排好的事件，浮在时间轴上方。
 *
 * 数据与时间轴上的刻度是同一份，差在铺得开——轴上的刻度挤成一个小点，装不下标题，
 * 这里才有地方把「哪一年、发生了什么」写成一行行读给人听。
 * 没有地点的事件也在这里：它们不上球，但同属这个世界的叙事。
 *
 * 两条时间线索分工不同：**游标管远近**——还没走到的事件先淡着；**选中管焦点**——
 * 亮起来并自动滚进视野的，是检查器里正在讲的那一条。
 *
 * 顶上那排标签是视图条件的唯一入口：点一章就只列这章。按人物筛出来的临时组也挂在这一排，
 * 但它不落盘——它是算出来的，用完点个叉就没了。
 */
export function Chronicle() {
  const project = useStore((s) => s.project);
  const cursor = useStore((s) => s.cursor);
  const selection = useStore((s) => s.selection);
  const open = useStore((s) => s.chronicleOpen);
  const jumpToEvent = useStore((s) => s.jumpToEvent);
  const setChronicleOpen = useStore((s) => s.setChronicleOpen);
  const viewFilter = useStore((s) => s.viewFilter);
  const setViewFilter = useStore((s) => s.setViewFilter);
  const groupSpan = useStore((s) => s.groupSpan);
  useProjectRevision(); // 事件改了名字或年份、或换了章节，长卷要跟着重排

  const ticks = timeTicks(project, viewFilter);
  const groups = project?.groups ?? [];
  const filtering = !!(viewFilter.groupId || viewFilter.characterId);
  // 按人物筛出来的临时组：名字现取，它不在 groups 里
  const byCharacter = viewFilter.characterId
    ? (project?.characters ?? []).find((c) => c.id === viewFilter.characterId) ?? null
    : null;
  // 亮的是检查器里正在讲的那一条。
  //
  // 不能拿游标去推：游标是一个**纯年份**，同年里挤着好几条时它分不出是哪一条——
  // 按「游标之前最后一条」去算，高亮会永远落在当年最后那一条上，而面板里显示的是
  // 你点的那条，两条线索当场错开（示例世界里 32 条事件有 26 条对不上）。
  // 选中的不是事件（点球面、选路线区域）时一条都不亮，游标那一路只负责让未到的淡着。
  const currentId = selection?.kind === 'event' ? selection.id : null;

  const activeRef = useRef(null);
  // 只在焦点真的换了、或长卷刚摊开时滚一次；
  // 逐帧调 scrollIntoView 会把长卷抖成一团
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [currentId, open]);

  if (!open || !project) return null;

  return (
    <div className="chronicle glass">
      <div className="chr-head">
        <span className="chr-title">编年史</span>
        <span className="chr-count">
          {ticks.length
            ? `${ticks.length} 条事件${filtering ? '（已筛选）' : ''}`
            : '还没有事件'}
        </span>
        <button className="icon-btn" title="收起长卷" onClick={() => setChronicleOpen(false)}>✕</button>
      </div>

      <div className="chr-tabs">
        <button
          className={`chr-tab${filtering ? '' : ' on'}`}
          onClick={() => setViewFilter({ groupId: null, characterId: null })}
        >
          全部
        </button>
        {groups.map((g) => {
          const span = spanText(groupSpan(g.id));
          return (
            <button
              key={g.id}
              className={`chr-tab${viewFilter.groupId === g.id ? ' on' : ''}`}
              title="只看这一章"
              onClick={() => setViewFilter({ groupId: g.id, characterId: null })}
            >
              {span ? `${g.name} · ${span}` : g.name}
            </button>
          );
        })}
        {/* 按人物筛出来的临时组：不在 groups 里，是个叉就能退出 */}
        {byCharacter && (
          <span className="chr-tab on" id="chr-by-character">
            🧝 {byCharacter.name}
            <button
              className="chr-x"
              title="退出筛选"
              onClick={() => setViewFilter({ characterId: null })}
            >
              ✕
            </button>
          </span>
        )}
      </div>

      <div className="chr-strip">
        {ticks.length === 0 && (
          <p className="insp-hint">
            {filtering
              ? '这个筛选下没有事件。换个标签，或点「全部」看整部长卷。'
              : '还没有事件。用顶栏的「⚡ 事件」在球上落下第一件事，它会带着年份出现在这里。'}
          </p>
        )}
        {ticks.map((t) => {
          const cls = ['chr-item', t.id === currentId && 'at-cursor', t.from > cursor && 'ahead']
            .filter(Boolean).join(' ');
          return (
            <button
              key={t.id}
              ref={t.id === currentId ? activeRef : null}
              className={cls}
              title={t.lat == null ? '没有地点：只在这条长卷里' : '跳到它发生的那一年并飞过去'}
              onClick={() => jumpToEvent(t.id)}
            >
              <span className="chr-year">{formatYear(t.from)}</span>
              <span className="chr-name">{t.title}</span>
              {t.lat == null && <span className="chr-note">无地点</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
