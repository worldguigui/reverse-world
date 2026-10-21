/**
 * 时间：Y / YM / YMD / YMDH / YMDHM / YMDHMS 六种精度，事件与人物共用。
 *
 * 只保存用户写到的精度：写 `1919` 就是 `1919`，不会补成 `1919-01-01T00:00:00`。
 * 排序时才把缺的月、日、时、分、秒补成 1/1/0/0/0；展示与输入回显都只呈现写过的部分。
 *
 * 空格之后是自由备注，例如 `1919-11-11 待定时间`。解析、排序、按年取用都只看空格前的
 * 时间部分，备注原样保留。日期与小时之间用 `T` 连接——空格已经让给备注，不能再兼作分隔符。
 * 不带时区。路线、区域的存续区间仍直接使用数值年，`timeYear()` 对数字原样返回。
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

/** 时间正文与空格后的备注分开；备注允许带内部空格 */
function splitNote(raw) {
  const text = raw.trim();
  const i = text.search(/\s/);
  if (i === -1) return { head: text, note: '' };
  return { head: text.slice(0, i), note: text.slice(i).trim() };
}

/** 时间部分：日期与小时之间只能写 T，空格留给备注 */
const TIME_RE = /^(-?\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2})(?:T(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?)?)?$/;

/**
 * 解析用户输入并规范化到写过的精度。
 * 只写年、年-月、年-月-日、年-月-日Thh、…Thh:mm、…Thh:mm:ss 都接受；
 * 缺的部分不补。空格后的备注原样保留。非法日期或时间返回 null。
 */
export function parseTime(raw) {
  if (typeof raw !== 'string') return null;
  const { head, note } = splitNote(raw);
  const m = TIME_RE.exec(head);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] == null ? null : Number(m[2]);
  const day = m[3] == null ? null : Number(m[3]);
  const hour = m[4] == null ? null : Number(m[4]);
  const minute = m[5] == null ? null : Number(m[5]);
  const second = m[6] == null ? null : Number(m[6]);
  if (month != null && (month < 1 || month > 12)) return null;
  if (day != null && (day < 1 || day > daysInMonth(year, month))) return null;
  if (hour != null && hour > 23) return null;
  if (minute != null && minute > 59) return null;
  if (second != null && second > 59) return null;

  let out = formatYearPart(year);
  if (month != null) out += `-${pad2(month)}`;
  if (day != null) out += `-${pad2(day)}`;
  if (hour != null) out += `T${pad2(hour)}`;
  if (minute != null) out += `:${pad2(minute)}`;
  if (second != null) out += `:${pad2(second)}`;
  return note ? `${out} ${note}` : out;
}

/** 新建事件默认只落到游标所在的年份，不补月日时分秒 */
export function yearToTime(year) {
  if (!Number.isFinite(year)) return null;
  return formatYearPart(Math.floor(year));
}

/** 把用户输入统一成规范串；非法输入或非字符串返回 null */
export function normalizeTime(value) {
  return typeof value === 'string' ? parseTime(value) : null;
}

/**
 * 规范时间串的各段与备注；非法输入返回 null。
 * 没写的部分保持 null——比较时再补默认值，展示时据此决定要不要写月日时分秒。
 */
const PARTS_RE = /^(-?\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2})(?:T(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?)?)?$/;
function timeParts(value) {
  if (typeof value !== 'string') return null;
  const { head, note } = splitNote(value);
  const m = PARTS_RE.exec(head);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] == null ? null : Number(m[2]);
  const day = m[3] == null ? null : Number(m[3]);
  const hour = m[4] == null ? null : Number(m[4]);
  const minute = m[5] == null ? null : Number(m[5]);
  const second = m[6] == null ? null : Number(m[6]);
  if (month != null && (month < 1 || month > 12)) return null;
  if (day != null && (day < 1 || day > daysInMonth(year, month))) return null;
  if (hour != null && hour > 23) return null;
  if (minute != null && minute > 59) return null;
  if (second != null && second > 59) return null;
  return { year, month, day, hour, minute, second, note };
}

/**
 * 时间所在的年份。事件、人物传时间串，路线、区域传数值年。
 * 备注不参与判断；非法输入返回 null——时间轴上就不会出现这一端。
 */
export function timeYear(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return timeParts(value)?.year ?? null;
}

/**
 * 按完整时间比较两条内容。缺的月、日、时、分、秒在这里补成 1/1/0/0/0，
 * 只用于算出先后，不会写回数据。年份不能直接比字符串：负年份按字典序会把
 * 「前 1914」排到「前 44」后面。没有时间的一端排在最后；两端都没有就是相等。
 */
export function compareDateTime(a, b) {
  const A = timeParts(a);
  const B = timeParts(b);
  if (!A && !B) return 0;
  if (!A) return 1;
  if (!B) return -1;
  return A.year - B.year
    || (A.month ?? 1) - (B.month ?? 1)
    || (A.day ?? 1) - (B.day ?? 1)
    || (A.hour ?? 0) - (B.hour ?? 0)
    || (A.minute ?? 0) - (B.minute ?? 0)
    || (A.second ?? 0) - (B.second ?? 0);
}

/**
 * 展示写法：1914；1914.6；1914.6.28；1914.6.28 08时；1914.6.28 08:30；
 * 1914.6.28 08:30:15。只写用户填过的部分，空格后附备注。
 */
export function formatTime(value) {
  const t = timeParts(value);
  if (!t) return '';
  const year = t.year < 0 ? `前 ${Math.abs(t.year)}` : `${t.year}`;
  let out = year;
  if (t.month != null) out += `.${t.month}`;
  if (t.day != null) out += `.${t.day}`;
  if (t.hour != null) {
    let clock = pad2(t.hour);
    if (t.minute != null) clock += `:${pad2(t.minute)}`;
    if (t.second != null) clock += `:${pad2(t.second)}`;
    // 只有小时时加「时」，免得 08 看起来像日期的一部分
    out += ` ${clock}${t.minute == null ? '时' : ''}`;
  }
  if (t.note) out += ` ${t.note}`;
  return out;
}
