import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { searchCharacters } from './common.jsx';
import { timeTicks, formatYear } from '../../core/timeline.js';
import { uid, isViewFiltered } from '../../core/project.js';

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
 * 顶上的标签都是「一批事件」的入口：章节是一批，姓名搜索固化下来的快照也是一批，
 * 界面上就是一个临时章节。标签可以选中任意多个，长卷、时间轴与球面看到的都是它们的交集。
 * 快照不实时更新——之后再给事件挂上这个人，清单也不会自己变，要最新的就再搜一次。
 *
 * 取消选中只是退出交集，快照作为标签留在栏里，之后还能点回来；「全部」清掉的是所有选中，
 * 不是这些标签本身。快照要彻底删掉，点它右边的叉。
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
  const { groupIds, snapshots, activeSnapshotIds } = viewFilter;

  // 「全部」只取消所有选中，不删标签：姓名快照留在栏里，随时可以再点回来。
  // 这和章节标签的行为一样——取消选中不等于把章节删掉
  const showAll = () => setViewFilter({ groupIds: [], characterId: null, activeSnapshotIds: [] });
  useProjectRevision(); // 事件改了名字或年份、或换了章节，长卷要跟着重排

  // 按姓名搜人：输入即列候选，选中某位就把「此刻他涉及的事件」固化成临时编年史
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [hit, setHit] = useState(0);

  const characters = project?.characters ?? [];
  const cands = searchCharacters(characters, query).slice(0, 8);
  // 输着字且光标还在框里时才展开候选；一失焦就收，免得挡住长卷
  const searching = focused && query.trim().length > 0;

  const pickCharacter = (c) => {
    // 固化而不是实时求值：这份清单是从当前数据里取的快照，之后数据再变也不跟着动。
    // 它不属于项目，不参与自动保存；显式导出时才随文件写出那一份 id 清单。
    // 无年份的事件也收：它们上不了长卷，但在球上照样是此人相关的一批事件
    const eventIds = (project?.events ?? [])
      .filter((e) => e.characters?.includes(c.id))
      .map((e) => e.id);
    // 同一个人再搜一次就更新他那个标签的快照，不叠出第二个同名标签
    const existing = snapshots.find((s) => s.characterId === c.id);
    const snap = {
      id: existing?.id ?? uid('snap'),
      title: c.name, characterId: c.id, eventIds,
    };
    const nextSnapshots = existing
      ? snapshots.map((s) => (s.id === snap.id ? snap : s))
      : [...snapshots, snap];
    const nextActive = activeSnapshotIds.includes(snap.id)
      ? activeSnapshotIds
      : [...activeSnapshotIds, snap.id];
    setViewFilter({
      characterId: null,
      snapshots: nextSnapshots,
      activeSnapshotIds: nextActive,
    });
    setQuery('');
    setHit(0);
  };

  const onSearchKeyDown = (e) => {
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
      pickCharacter(cands[Math.min(hit, cands.length - 1)]);
    }
  };

  // 选中的集合都在 viewFilter 里，inView 统一取交集；与时间轴、球面用的是同一份结果
  const ticks = timeTicks(project, viewFilter);
  const groups = project?.groups ?? [];
  const filtering = isViewFiltered(viewFilter);
  // 编程接口的实时人物筛（viewFilter.characterId）：界面上没有入口，但若脚本设了它，
  // 得有个看得见、能退出的标签，否则时间轴与球面会莫名其妙地少掉一批事件
  const byCharacter = viewFilter.characterId
    ? characters.find((c) => c.id === viewFilter.characterId) ?? null
    : null;
  const emptyText = filtering
    ? '这些标签的交集里没有事件。取消一两个标签，或点「全部」看整部长卷。'
    : '还没有事件。用顶栏的「事件」在球上落下第一件事，它会带着年份出现在这里。';
  // 亮的是检查器里正在讲的那一条。
  //
  // 不能拿游标去推：游标是一个**纯年份**，同年里挤着好几条时它分不出是哪一条——
  // 按「游标之前最后一条」去算，高亮会永远落在当年最后那一条上，而面板里显示的是
  // 你点的那条，两条线索当场错开（示例世界里 32 条事件有 26 条对不上）。
  // 选中的不是事件（点球面、选路线区域）时一条都不亮，游标那一路只负责让未到的淡着。
  const currentId = selection?.kind === 'event' ? selection.id : null;

  // 标签是可多选的集合：再点一次就退出交集。章节与临时章节走同一套开关
  const toggleGroup = (id) => setViewFilter({
    groupIds: groupIds.includes(id) ? groupIds.filter((x) => x !== id) : [...groupIds, id],
  });
  const toggleSnapshot = (id) => setViewFilter({
    activeSnapshotIds: activeSnapshotIds.includes(id)
      ? activeSnapshotIds.filter((x) => x !== id)
      : [...activeSnapshotIds, id],
  });
  // 叉掉才是真正删掉这个临时章节；「全部」只取消选中，不删
  const removeSnapshot = (id) => setViewFilter({
    snapshots: snapshots.filter((s) => s.id !== id),
    activeSnapshotIds: activeSnapshotIds.filter((x) => x !== id),
  });

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
            : filtering ? '0 条事件（已筛选）' : '还没有事件'}
        </span>
        <div className="chr-search">
          <input
            id="chr-char-search"
            className="inp"
            type="text"
            value={query}
            placeholder={characters.length ? '按姓名搜人物' : '还没有人物'}
            disabled={!characters.length}
            title="选中后把此人当前涉及的事件固化为临时编年史，不随数据更新"
            onChange={(e) => { setQuery(e.target.value); setHit(0); }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onSearchKeyDown}
          />
          {searching && (
            <div className="char-menu">
              {cands.length === 0 ? (
                <p className="char-none">没有匹配的人物</p>
              ) : (
                cands.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`char-opt${i === hit ? ' hit' : ''}`}
                    // 按下时挡掉默认行为：一失焦候选就收，紧接着的 click 会落空
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHit(i)}
                    onClick={() => pickCharacter(c)}
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
        <button className="icon-btn" title="收起长卷" onClick={() => setChronicleOpen(false)}>✕</button>
      </div>

      <div className="chr-tabs">
        {/* 取消所有选中，但标签都留在栏里：筛选出来的临时章节不会因此消失 */}
        <button
          className={`chr-tab${filtering ? '' : ' on'}`}
          title="取消所有选中，看全部事件（标签保留）"
          onClick={showAll}
        >
          全部
        </button>
        {groups.map((g) => {
          const span = spanText(groupSpan(g.id));
          const on = groupIds.includes(g.id);
          return (
            <button
              key={g.id}
              className={`chr-tab${on ? ' on' : ''}`}
              title={on ? '取消选中这一章' : '选中这一章，与其他标签取交集'}
              onClick={() => toggleGroup(g.id)}
            >
              {span ? `${g.name} · ${span}` : g.name}
            </button>
          );
        })}
        {/* 实时人物筛只有编程接口会设；界面上给它一个和旧行为一致的退出标签 */}
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
        {/* 姓名搜索生成的临时章节：和章节标签一样可多选、可取消选中；叉掉才是删除 */}
        {snapshots.map((s) => {
          const on = activeSnapshotIds.includes(s.id);
          return (
            <span
              key={s.id}
              className={`chr-tab person${on ? ' on' : ''}`}
              title={on ? '取消选中这个临时章节' : '选中这个临时章节，与其他标签取交集'}
              onClick={() => toggleSnapshot(s.id)}
            >
              🧝 {s.title}
              <span className="chr-temp">临时</span>
              <button
                className="chr-x"
                title="删除这个临时章节"
                onClick={(e) => { e.stopPropagation(); removeSnapshot(s.id); }}
              >
                ✕
              </button>
            </span>
          );
        })}
      </div>

      <div className="chr-strip">
        {ticks.length === 0 && (
          <div className="chr-empty">
            <p className="insp-hint">{emptyText}</p>
            {/* 多选交集可能为空；给一条一步回到全部的退路，不必逐个取消标签 */}
            {filtering && (
              <div className="chr-empty-actions">
                <button className="btn btn-mini" onClick={showAll}>回到全部</button>
              </div>
            )}
          </div>
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
