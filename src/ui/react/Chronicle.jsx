import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';
import { searchCharacters, searchTags, TagChips } from './common.jsx';
import { timeTicks } from '../../core/timeline.js';
import { formatTime } from '../../core/datetime.js';
import { isViewFiltered } from '../../core/project.js';

/**
 * 编年史长卷：按时间排好的事件，浮在时间轴上方。
 *
 * 数据与时间轴上的刻度是同一份，差在铺得开——轴上的刻度挤成一个小点，装不下标题，
 * 这里才有地方把「哪一年、发生了什么」写成一行行读给人听。
 * 没有地点的事件也在这里：它们不上球，但同属这个世界的叙事。
 *
 * **选中管焦点**：亮起来并自动滚进视野的，是检查器里正在讲的那一条。早年间的
 * 「游标管远近」淡出（游标之后的年份压暗）已移除：事件如今在轴上压成年份堆，
 * 点选是长卷的主要交互，「选不同年份、淡出范围剧变」的反馈只剩困惑。
 *
 * 顶上的标签都是「一批事件」的入口，也就是章节：手动建的、姓名搜索生成的，
 * 都是同一种普通章节，没有类型之分。标签可以选中任意多个，长卷、时间轴与球面
 * 看到的都是它们的交集。
 *
 * 搜索生成的一章，清单是搜索那一刻的一份拷贝；之后再给事件挂上这个人，那一章不会变，
 * 要最新的就再搜一次、再建一章。改名或删除章节都在「章节」面板里。
 *
 * 取消选中只是退出交集，章节留在栏里，之后还能点回来；「全部」清掉的是所有选中，
 * 不是章节本身。
 */
export function Chronicle() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const open = useStore((s) => s.chronicleOpen);
  const jumpToEvent = useStore((s) => s.jumpToEvent);
  const setChronicleOpen = useStore((s) => s.setChronicleOpen);
  const viewFilter = useStore((s) => s.viewFilter);
  const setViewFilter = useStore((s) => s.setViewFilter);
  const chapterFromCharacter = useStore((s) => s.chapterFromCharacter);
  const chapterFromTag = useStore((s) => s.chapterFromTag);
  const { groupIds } = viewFilter;

  // 「全部」只取消所有选中，不删章节——取消选中不等于把章节删掉
  const showAll = () => setViewFilter({ groupIds: [], characterId: null });
  useProjectRevision(); // 事件改了名字或年份、或换了章节，长卷要跟着重排

  // 按姓名搜人：输入即列候选，选中某位就用「此刻他涉及的事件」新建一章
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [hit, setHit] = useState(0);

  const characters = project?.characters ?? [];
  // 候选是「人物 + 标签」的混合清单：人物在前、标签在后，各自内部按命中率排序。
  // 不按条数截断：候选菜单限高并可滚动，截断会让第 9 个以后的人永远选不到
  const charCands = searchCharacters(characters, query).map((c) => ({ type: 'char', item: c }));
  const tagCands = searchTags(project?.events ?? [], query).map((t) => ({ type: 'tag', item: t }));
  const cands = [...charCands, ...tagCands];
  // 输着字且光标还在框里时才展开候选；一失焦就收，免得挡住长卷
  const searching = focused && query.trim().length > 0;

  // 长卷打开时 Esc 先收起它；光标还在输入框里时不抢，留给「清空搜索」
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      setChronicleOpen(false);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, setChronicleOpen]);

  // 候选可能比菜单高；键盘移到看不见的那条时把它滚进视野
  const hitRef = useRef(null);
  useEffect(() => {
    hitRef.current?.scrollIntoView({ block: 'nearest' });
  }, [hit, query]);

  const pickCandidate = (cand) => {
    // 搜索即建章节：人物按「此刻涉及的事件」、标签按「此刻带这个标签的事件」
    // 各取成清单，新建一个普通章节并选中。无年份的事件也收——它们上不了长卷，
    // 但在球上照样是此人相关/带此标签的一批事件
    if (cand.type === 'char') chapterFromCharacter(cand.item);
    else chapterFromTag(cand.item.label);
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
      pickCandidate(cands[Math.min(hit, cands.length - 1)]);
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

  // 标签是可多选的集合：再点一次就退出交集。所有章节走同一套开关
  const toggleGroup = (id) => setViewFilter({
    groupIds: groupIds.includes(id) ? groupIds.filter((x) => x !== id) : [...groupIds, id],
  });

  const activeRef = useRef(null);
  // 只在焦点真的换了、或长卷刚摊开时滚一次；
  // 逐帧调 scrollIntoView 会把长卷抖成一团
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [currentId, open]);

  // 长卷横向溢出时提供左右翻页按钮：壁纸环境不转发滚轮事件，
  // 只看得到露在外面的那几张卡片。按钮在 web 里也照样可用。
  const stripRef = useRef(null);
  const [nav, setNav] = useState({ left: false, right: false });
  useEffect(() => {
    if (!open) return undefined;
    const sync = () => {
      const el = stripRef.current;
      if (!el) return;
      const max = el.scrollWidth - el.clientWidth;
      setNav({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
    };
    sync();
    const el = stripRef.current;
    el?.addEventListener('scroll', sync, { passive: true });
    // 窗口尺寸或卡片数量变化都会改变可滚范围，一起重算
    const ro = new ResizeObserver(sync);
    if (el) ro.observe(el);
    return () => {
      el?.removeEventListener('scroll', sync);
      ro.disconnect();
    };
  }, [open, ticks.length]);

  const scrollStrip = (dir) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: 'smooth' });
  };

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
        <div className="chr-nav">
          <button
            className="icon-btn"
            disabled={!nav.left}
            title="向前翻"
            onClick={() => scrollStrip(-1)}
          >
            ‹
          </button>
          <button
            className="icon-btn"
            disabled={!nav.right}
            title="向后翻"
            onClick={() => scrollStrip(1)}
          >
            ›
          </button>
        </div>
        <div className="chr-search">
          <input
            id="chr-char-search"
            className="inp"
            type="text"
            value={query}
            placeholder={characters.length || project?.events.length ? '搜索人物或标签' : '还没有人物或标签'}
            disabled={!characters.length}
            title="选中后把此人当前涉及的事件建成一个新章节，清单不随数据更新"
            onChange={(e) => { setQuery(e.target.value); setHit(0); }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onSearchKeyDown}
          />
          {searching && (
            <div className="char-menu">
              {cands.length === 0 ? (
                <p className="char-none">没有匹配的人物或标签</p>
              ) : (
                cands.map((cand, i) => (
                  <button
                    key={cand.type === 'tag' ? `#${cand.item.label}` : cand.item.id}
                    ref={i === hit ? hitRef : null}
                    type="button"
                    className={`char-opt${i === hit ? ' hit' : ''}`}
                    // 按下时挡掉默认行为：一失焦候选就收，紧接着的 click 会落空
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHit(i)}
                    onClick={() => pickCandidate(cand)}
                  >
                    {cand.type === 'tag'
                      ? <i className="char-dot tag-dot" />
                      : <i className="char-dot" style={{ background: cand.item.color }} />}
                    <span className="char-name">
                      {cand.type === 'tag' ? `#${cand.item.label}` : cand.item.name}
                    </span>
                    <span className="char-alias">
                      {cand.type === 'tag' ? `${cand.item.count} 条事件` : cand.item.aliases?.join('、')}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button className="icon-btn" title="收起长卷" onClick={() => setChronicleOpen(false)}>✕</button>
      </div>

      <div className="chr-tabs">
        {/* 取消所有选中，但章节都留在栏里 */}
        <button
          className={`chr-tab${filtering ? '' : ' on'}`}
          title="取消所有选中，看全部事件（标签保留）"
          onClick={showAll}
        >
          全部
        </button>
        {groups.map((g) => {
          const on = groupIds.includes(g.id);
          return (
            <button
              key={g.id}
              className={`chr-tab${on ? ' on' : ''}`}
              title={on ? '取消选中这一章' : '选中这一章，与其他标签取交集'}
              onClick={() => toggleGroup(g.id)}
            >
              {g.name}
            </button>
          );
        })}
        {/* 实时人物筛只有编程接口会设；界面上给它一个能直接退出的标签 */}
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

      <div className="chr-strip" ref={stripRef}>
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
          // 时间戳与备注分开渲染：备注降档、限两行，长备注不许把整排卡片撑高。
          // from 是规范时间串（datetime.js 只在空格后放备注），首个空白前是时间正文
          const raw = typeof t.from === 'string' ? t.from : '';
          const sp = /\s/.exec(raw);
          const timeHead = sp ? raw.slice(0, sp.index) : raw;
          const timeNote = sp ? raw.slice(sp.index).trim() : '';
          // 分级高度：有无时间备注决定等级（t2 由备注区自然增高），tags 不参与分级
          const cls = [
            'chr-item',
            timeNote ? 'chr-t2' : 'chr-t1',
            t.id === currentId && 'at-cursor',
          ].filter(Boolean).join(' ');
          return (
            <button
              key={t.id}
              ref={t.id === currentId ? activeRef : null}
              className={cls}
              onClick={() => jumpToEvent(t.id)}
            >
              <span className="chr-year">
                <span className="chr-time">{formatTime(timeHead || raw)}</span>
                {timeNote && <span className="chr-time-note">{timeNote}</span>}
              </span>
              <span className="chr-name">{t.title}</span>
              {/* 注记行只在有内容时渲染：没有标签/备注就不占任何高度 */}
              {((t.tags?.length ?? 0) > 0 || t.lat == null) && (
                <span className="chr-tags">
                  <TagChips tags={t.tags} max={2} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
