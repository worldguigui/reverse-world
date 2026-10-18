/**
 * 时间轴的定义域与刻度。
 *
 * 两者都由内容自己的 from / to 算出来，没有任何需要人维护的槽位：给某条内容填上时间，
 * 轴就长出来一截；把时间清空，轴就缩回去。域内一条带时间的对象都没有时，整根轴不存在——
 * 纯地理的世界不需要叙事轴。
 */
import { getList, inView } from './project.js';

/** 两端各留一点空气，取定义域跨度的一个小比例；跨度为 0 时另有兜底 */
const MARGIN_RATIO = 0.04;
/** 全部内容都挤在同一个时刻时，给一年宽，免得轴上所有刻度叠成一个点 */
const FLAT_SPAN = 1;

const ALL_KINDS = ['event', 'route', 'region'];

/**
 * 时间轴的定义域；没有任何内容带时间时返回 null。
 * `min` / `max` 是内容里真实出现过的年份，`start` / `end` 是两端各让出一点边距之后的
 * 可拖动范围——把游标拖到端点时，最早 / 最晚的那条内容正好在边缘上，不至于贴死。
 *
 * 只看 from / to 两个端点，不看内容本身——所以路线与区域虽然不画刻度，也一定落在域内，
 * 不会出现「录进去了却拖不到」的内容。
 */
export function timeDomain(project) {
  if (!project) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const kind of ALL_KINDS) {
    for (const it of getList(project, kind)) {
      for (const v of [it.from, it.to]) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (min === Infinity) return null;
  const span = max - min;
  const pad = span > 0 ? span * MARGIN_RATIO : FLAT_SPAN;
  return { min, max, start: min - pad, end: max + pad };
}

/**
 * 刻度 = 事件。按时间排好序，供时间轴画刻度、供长卷按时间铺开。
 * 给了视图条件就只收属于它的那些——轴的跨度不动，收窄的是画在上面的刻度。
 *
 * 同一年里不另排序：sort 是稳定的，同年的事件保持它们在数组里的先后，也就是录入的先后。
 * 这份先后是有意义的——它决定箭头一条一条翻时先翻到谁，按 id 之类的随机次序排就把它拆散了。
 */
export function timeTicks(project, view) {
  if (!project) return [];
  return project.events
    .filter((e) => typeof e.from === 'number' && Number.isFinite(e.from) && inView(project, view, e))
    .sort((a, b) => a.from - b.from);
}

/**
 * 项目载入后游标停在哪一年：内容里出现过的最晚的那一年，也就是「世界演进至今的样子」——
 * 与地图取最后一张脸是同一个道理，打开就该先看见完整的当下，往回拖才是读历史。
 * 没有轴时是 0：此时所有内容都常驻，游标取什么值都一样。
 */
export function defaultCursor(project) {
  return timeDomain(project)?.max ?? 0;
}

/** 游标落到整年上。游标本身是浮点（拖动与边距都会带出小数），显示与录入都按年取整 */
export const roundYear = (year) => Math.round(year);

/** 年份的写法：公元前写成「前 9600」，公元后就是裸数字 */
export const formatYear = (year) => (year < 0 ? `前 ${Math.abs(roundYear(year))}` : `${roundYear(year)}`);

/** 游标推到定义域内 */
export function clampCursor(project, year) {
  const d = timeDomain(project);
  if (!d) return year;
  return Math.min(Math.max(year, d.start), d.end);
}

/**
 * 往前后找一条事件。dir > 0 往后、< 0 往前，找不到返回 null。
 *
 * anchorId 是当前选中的那条事件。游标还停在它的年份上时，按它在刻度清单里的位置前后挪一条：
 * 同一年里常常挤着好几条事件，按年份找会把它们一次全跳过，按清单找才是一件事一件事地翻。
 * 游标已经离开那一年（被拖走过）就退回按年份找，否则会从选中事件那里接着跳，与眼前的游标对不上。
 *
 * 收窄视图时找的是**看得见**的那几条：筛出某一章之后，方向键该在章内走。
 */
export function nextTickEvent(project, cursor, dir, view, anchorId = null) {
  const ticks = timeTicks(project, view);
  if (!ticks.length) return null;
  if (anchorId) {
    const i = ticks.findIndex((e) => e.id === anchorId);
    if (i >= 0 && Math.abs(ticks[i].from - cursor) < 1e-6) return ticks[i + dir] ?? null;
  }
  if (dir > 0) return ticks.find((e) => e.from > cursor + 1e-9) ?? null;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (ticks[i].from < cursor - 1e-9) return ticks[i];
  }
  return null;
}

/**
 * 往前后跳一个刻度，只回年份。轴上没有刻度时按定义域的百分之一挪一步，
 * 这样即使只有路线与区域，方向键也仍然能动。
 *
 * 收窄视图时跳的是**看得见**的那几个刻度：筛出某一章之后，方向键该在章内走。
 */
export function nextTickYear(project, cursor, dir, view) {
  const ticks = timeTicks(project, view);
  const years = ticks.map((e) => e.from);
  const target = dir > 0
    ? years.find((y) => y > cursor + 1e-9)
    : [...years].reverse().find((y) => y < cursor - 1e-9);
  if (target != null) return target;
  const d = timeDomain(project);
  if (!d) return cursor;
  return clampCursor(project, cursor + dir * (d.end - d.start) * 0.01);
}
