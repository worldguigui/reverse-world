/**
 * 云端存档客户端：一个单用户、单存档位的 HTTP 接口。
 *
 * 与 IndexedDB 的自动保存互不影响：这里的函数只在用户点击「保存到云端 / 从云端载入」时调用。
 * 令牌存在 localStorage，第一次输入后由用户决定是否继续使用；载入结果仍交给
 * normalizeProject 检查，服务器和本地文件走同一套严格格式。
 */
import { normalizeProject } from './project.js';

const ENDPOINT = '/api/project';
const TOKEN_KEY = 'worldbuilding:cloud-token';
// 项目可能内嵌十几 MB 的地图与图片；这台服务器的公网带宽有限，慢网络下留足十分钟
const TIMEOUT_MS = 600_000;

export function getCloudToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberCloudToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch { /* 隐私模式写不进去也不影响本次使用 */ }
}

/** 服务器或 nginx 已经给出中文错误时直接用，否则按状态码兜底 */
function fallbackMessage(status) {
  switch (status) {
    case 401: return '访问令牌不正确';
    case 404: return '云端还没有存档';
    case 413: return '项目文件过大，服务器上限为 25 MB';
    case 502:
    case 503:
    case 504: return '云端服务暂时不可用';
    default: return `云端请求失败（HTTP ${status}）`;
  }
}

async function request(method, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });

    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      // 超时中断也可能发生在读响应体时，交给外层统一翻译；其余非 JSON 响应交给状态码
      if (err.name === 'AbortError') throw err;
    }

    if (!res.ok) throw new Error(data?.error || fallbackMessage(res.status));
    if (!data) throw new Error(`云端返回了无法解析的响应（HTTP ${res.status}）`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('云端请求超时；项目较大或网络较慢时请重试');
    // fetch 自身的网络错误没有可读信息，换成用户能采取行动的说法
    if (err instanceof TypeError) throw new Error('无法连接云端服务，请检查网络或服务器状态');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 返回 { savedAt, size } */
export async function saveProjectToCloud(project, token) {
  const data = await request('PUT', token, JSON.stringify(project));
  return { savedAt: data.savedAt ?? null, size: data.size ?? 0 };
}

/** 返回 { project, savedAt, size }；云端数据不合格时在覆盖本地之前就失败 */
export async function loadProjectFromCloud(token) {
  const data = await request('GET', token);
  let project;
  try {
    project = normalizeProject(data.project);
  } catch (err) {
    throw new Error(`云端存档无法载入：${err.message}`);
  }
  return { project, savedAt: data.savedAt ?? null, size: data.size ?? 0 };
}

/** 把服务端的 ISO 时间显示成本地时间；解析失败就原样显示，不隐藏问题 */
export function formatCloudTime(iso) {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}
