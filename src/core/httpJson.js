/**
 * 带超时与错误翻译的 JSON 请求，云端类接口（/api/**）共用。
 *
 * 服务器或 nginx 返回的 { error } 中文说明优先展示；没有 JSON 说明时按状态码
 * 兜底，fallbackMessage 可让调用方按接口语境替换个别状态码的说法（返回
 * undefined 的状态码继续走默认兜底）。
 */
export async function requestJson(url, {
  method = 'GET',
  body = null, // 已序列化的 JSON 字符串；GET 传 null
  headers = {},
  timeoutMs = 600_000,
  fallbackMessage,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...headers,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ?? undefined,
    });

    let raw = '';
    try {
      raw = await res.text();
    } catch (err) {
      // 超时中断也可能发生在读响应体时，交给外层统一翻译；其余读失败按空响应处理
      if (err.name === 'AbortError') throw err;
    }

    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      // 非 JSON 响应：多半是 nginx 之类的代理错误页，下面按状态码兜底
    }

    if (!res.ok) {
      // API 自己的拒绝都带 JSON 说明，里面是真实的原因或体积上限
      if (data?.error) throw new Error(data.error);
      // 没有 JSON 的 413 来自反向代理：请求还没到 API，不能把 API 的上限当成原因
      if (res.status === 413) {
        throw new Error('上传在到达接口之前被拒绝（HTTP 413）：请检查反向代理的请求体上限');
      }
      throw new Error(fallbackMessage?.(res.status) ?? defaultFallback(res.status));
    }
    if (!data) throw new Error(`服务器返回了无法解析的响应（HTTP ${res.status}）`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时：内容较大或网络较慢时请重试');
    // fetch 自身的网络错误没有可读信息，换成用户能采取行动的说法
    if (err instanceof TypeError) throw new Error('无法连接服务器，请检查网络或服务器状态');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function defaultFallback(status) {
  if (status === 404) return '资源不存在';
  if (status === 413) return '内容过大，被服务器拒收（HTTP 413）';
  if (status === 502 || status === 503 || status === 504) return '服务暂时不可用';
  return `请求失败（HTTP ${status}）`;
}
