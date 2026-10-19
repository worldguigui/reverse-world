/**
 * 事件时间：`yyyy-MM-ddThh:mm:ss`，人物生卒：`yyyy-MM-dd`，都不带时区。
 *
 * 事件完整时间用于排序、记录、编辑与展示；时间轴与在场判定仍按年取整，
 * 所以这里另外提供 `timeYear()` 把日期时间折回年份。
 * 路线、区域的存续区间仍直接使用数值年，`timeYear()` 对数字原样返回。
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** 年份至少四位；公元前用负号，写成 -0044 这样的形式 */
const formatYearPart = (year) => {
  const abs = String(Math.abs(year)).padStart(4, '0');
  return year < 0 ? `-${abs}` : abs;
};

function isLeapYear(year) {
  const y = Math.abs(year);
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * 解析用户输入并补成完整时间串。
 * 只写年、年-月-日、年-月-日Thh:mm 都接受：缺的月日按 1 月 1 日，缺的时分秒按 0。
 * 非法日期或时间返回 null。
 */
export function parseDateTime(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const m = /^(-?\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?)?)?$/.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] == null ? 1 : Number(m[2]);
  const day = m[3] == null ? 1 : Number(m[3]);
  const hh = m[4] == null ? 0 : Number(m[4]);
  const mm = m[5] == null ? 0 : Number(m[5]);
  const ss = m[6] == null ? 0 : Number(m[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return `${formatYearPart(year)}-${pad2(month)}-${pad2(day)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

/** 年份 → 该年 1 月 1 日零点。新建事件默认落在游标所在的年份 */
export function yearToDateTime(year) {
  if (!Number.isFinite(year)) return null;
  return `${formatYearPart(Math.floor(year))}-01-01T00:00:00`;
}

/** 把用户输入统一成规范串；非法输入或非字符串返回 null */
export function normalizeDateTime(value) {
  return typeof value === 'string' ? parseDateTime(value) : null;
}

/** 解析成 `yyyy-MM-dd`：只写年也补成 1 月 1 日；非法输入返回 null */
export function parseDate(raw) {
  const normalized = parseDateTime(raw);
  return normalized ? normalized.slice(0, 10) : null;
}

/** 人物生卒的规范形式：`yyyy-MM-dd` 或 null */
export function normalizeDate(value) {
  return typeof value === 'string' ? parseDate(value) : null;
}

/** 规范日期串或日期时间串的各段；非法输入返回 null */
const TIME_RE = /^(-?\d{1,6})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;
function timeParts(value) {
  if (typeof value !== 'string') return null;
  const m = TIME_RE.exec(value);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] == null ? 0 : Number(m[4]),
    minute: m[5] == null ? 0 : Number(m[5]),
    second: m[6] == null ? 0 : Number(m[6]),
  };
}

/**
 * 时间所在的年份。事件传规范日期时间串，路线、区域与人物传数值年。
 * 非法输入返回 null——时间轴上就不会出现这一端。
 */
export function timeYear(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return timeParts(value)?.year ?? null;
}

/**
 * 按完整时间比较两条事件。年份先比较，再比月、日、时、分、秒——
 * 不能直接比字符串：负年份按字典序会把「前 1914」排到「前 44」后面。
 * 没有时间的一端排在最后；两端都没有就是相等。
 */
export function compareDateTime(a, b) {
  const A = timeParts(a);
  const B = timeParts(b);
  if (!A && !B) return 0;
  if (!A) return 1;
  if (!B) return -1;
  return A.year - B.year
    || A.month - B.month
    || A.day - B.day
    || A.hour - B.hour
    || A.minute - B.minute
    || A.second - B.second;
}

/** 日期的写法：1914.6.28；公元前写成「前 1914.6.28」 */
export function formatDate(value) {
  const t = timeParts(value);
  if (!t) return '';
  const year = t.year < 0 ? `前 ${Math.abs(t.year)}` : `${t.year}`;
  return `${year}.${t.month}.${t.day}`;
}
