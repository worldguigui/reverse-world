/**
 * 创意工坊客户端：公开的浏览 / 上传接口，不需要访问令牌。
 *
 * 预览清单是一份全量的小索引（图片压缩后整份远小于 1 MB），进入工坊时整份
 * 拉取；存档本体按 id 单独拉取，点开哪条才下哪条。上传时是否带底图由用户
 * 决定——底图是独立设计的，缺它不影响事件、路线、区域与人物的展示。
 * 载入结果仍交给 normalizeProject 检查，服务器和本地文件走同一套严格格式。
 */
import { requestJson } from './httpJson.js';
import { normalizeProject } from './project.js';

const PREVIEWS_URL = '/api/workshop/previews';
const SAVES_URL = '/api/workshop/saves';
const USER_KEY = 'worldbuilding:workshop-user';

// 预览清单是小体积 JSON，超时按小请求对待
const PREVIEW_TIMEOUT_MS = 30_000;
// 存档可能内嵌十几 MB 的地图与图片；公网带宽有限，慢网络下留足十分钟
const SAVE_TIMEOUT_MS = 600_000;

export function getWorkshopUser() {
  try {
    return localStorage.getItem(USER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberWorkshopUser(name) {
  try {
    localStorage.setItem(USER_KEY, name);
  } catch { /* 隐私模式写不进去也不影响本次使用 */ }
}

/** 返回预览条目数组（新→旧）；服务器上还没有清单时是空数组 */
export async function fetchWorkshopPreviews() {
  const data = await requestJson(PREVIEWS_URL, { timeoutMs: PREVIEW_TIMEOUT_MS });
  return Array.isArray(data.items) ? data.items : [];
}

/** 返回 { project, uploadedAt }；存档不合格时在替换本地世界之前就失败 */
export async function fetchWorkshopSave(id) {
  const data = await requestJson(`${SAVES_URL}/${encodeURIComponent(id)}`, {
    timeoutMs: SAVE_TIMEOUT_MS,
    fallbackMessage: (status) => (status === 404 ? '这条存档不存在，或已被服务器清理' : undefined),
  });
  let project;
  try {
    project = normalizeProject(data.project);
  } catch (err) {
    throw new Error(`存档无法载入：${err.message}`);
  }
  return { project, uploadedAt: data.uploadedAt ?? null };
}

/** 返回 { id, uploadedAt }；id 由服务器生成 */
export async function uploadWorkshopSave({ name, user, preview, project }) {
  const data = await requestJson(SAVES_URL, {
    method: 'PUT',
    body: JSON.stringify({ name, user, preview, project }),
    timeoutMs: SAVE_TIMEOUT_MS,
  });
  return { id: data.id, uploadedAt: data.uploadedAt ?? null };
}

/** 把服务端的 ISO 时间显示成本地时间；解析失败就原样显示，不隐藏问题 */
export function formatWorkshopTime(iso) {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}
