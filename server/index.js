/**
 * 存档服务 API，两部分：
 *
 *   /api/project            云端存档：单用户、单存档位；设置 WORLD_TOKEN 才启用，
 *                           启用后读写都受 Bearer 令牌保护，不设置则整体停用
 *   /api/workshop/previews  创意工坊预览清单：全量小索引，公开读取
 *   /api/workshop/saves     创意工坊存档：公开上传，按 id 公开读取
 *
 * 项目结构复用 core/project.js 的 normalizeProject——云端、工坊与本地导入
 * 必须接受同一套格式。所有写入先落临时文件再 rename，断电时不会留下写了一半的档。
 */
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeProject } from '../src/core/project.js';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'project.json');
const SAVES_DIR = path.join(DATA_DIR, 'saves');
const PREVIEWS_FILE = path.join(DATA_DIR, 'previews.json');
// 工坊是公开上传的：不设访问门槛，只靠格式校验与体积上限防滥用
const WS_NAME_MAX = 60;
const WS_USER_MAX = 40;
// 预览图是 256px 级别的 WebP/PNG/JPEG dataURL，96 KiB 对它们绰绰有余
const WS_PREVIEW_MAX = 96 * 1024;
const WS_PREVIEW_RE = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const TOKEN = process.env.WORLD_TOKEN || '';
// 前端项目可能内嵌 2048×1024 的地图 PNG 与多张人物图，200 MiB 足够，又不至于让畸形请求吃光内存
const MAX_BODY = 200 * 1024 * 1024;

// 先各自摘要再比较：两个缓冲区等长，计时相对稳定，也不会因令牌长度不同而提前返回。
// 令牌是可选的：创意工坊不需要它；不设置时云端存档接口停用——公开服务器上
// 无令牌的写入接口等于谁都能覆盖存档，宁可关掉也不裸开
const EXPECTED_DIGEST = TOKEN ? createHash('sha256').update(TOKEN).digest() : null;

function isAuthorized(req) {
  if (!EXPECTED_DIGEST) return false;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const digest = createHash('sha256').update(header.slice(7)).digest();
  return timingSafeEqual(digest, EXPECTED_DIGEST);
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/** 超限时继续把请求读完再回复，避免在请求体还在上传时直接掐断连接 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let tmpSeq = 0;

/** 原子写 JSON 文件，返回写入的字节数 */
async function writeJsonAtomic(file, envelope) {
  await mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(envelope);
  // 同一进程的并发写不能共用一个临时文件名，否则后一次会覆盖前一次还没 rename 的内容
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return Buffer.byteLength(payload);
}

/**
 * 校验 Content-Type 并读出 JSON 请求体；不合法时直接回复并返回 null。
 * 超限时继续把请求读完再回复，避免在请求体还在上传时直接掐断连接。
 */
async function readJsonBody(req, res) {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    send(res, 415, { error: '请求体必须是 application/json' });
    req.resume();
    return null;
  }

  // Content-Length 已经超限就不必再收：nginx 那边也会挡一道，这里只是尽早结束
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
    send(res, 413, { error: '请求体过大，服务器上限为 200 MB' });
    req.resume();
    return null;
  }

  const body = await readBody(req);
  if (body === null) {
    send(res, 413, { error: '请求体过大，服务器上限为 200 MB' });
    return null;
  }

  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    send(res, 400, { error: '请求体不是合法 JSON' });
    return null;
  }
}

async function handleGet(res) {
  let text;
  try {
    text = await readFile(FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      send(res, 404, { error: '云端还没有存档' });
      return;
    }
    throw err;
  }

  let stored;
  try {
    stored = JSON.parse(text);
  } catch {
    send(res, 500, { error: '云端存档已损坏，无法解析' });
    return;
  }

  let project;
  try {
    project = normalizeProject(stored.project);
  } catch (err) {
    send(res, 500, { error: `云端存档格式不合法：${err.message}` });
    return;
  }

  send(res, 200, {
    savedAt: stored.savedAt ?? null,
    size: Buffer.byteLength(text),
    project,
  });
}

async function handlePut(req, res) {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;

  let project;
  try {
    project = normalizeProject(raw);
  } catch (err) {
    send(res, 400, { error: err.message });
    return;
  }

  const savedAt = new Date().toISOString();
  const size = await writeJsonAtomic(FILE, { savedAt, project });
  send(res, 200, { savedAt, size });
}

// ---------------------------------------------------------------- 创意工坊

// previews.json 的读-改-写串行化：并发上传各自读完旧清单再写回会互相覆盖条目
let previewsChain = Promise.resolve();
function queuePreviewsUpdate(update) {
  const run = previewsChain.then(update);
  previewsChain = run.then(() => {}, () => {});
  return run;
}

async function handleWorkshopPreviews(res) {
  let text;
  try {
    text = await readFile(PREVIEWS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 200, { updatedAt: null, items: [] });
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return send(res, 500, { error: '预览清单已损坏，无法解析' });
  }
  send(res, 200, {
    updatedAt: data.updatedAt ?? null,
    items: Array.isArray(data.items) ? data.items : [],
  });
}

async function handleWorkshopSaveGet(res, id) {
  let text;
  try {
    text = await readFile(path.join(SAVES_DIR, `${id}.json`), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return send(res, 404, { error: '这条存档不存在，或已被服务器清理' });
    }
    throw err;
  }

  let stored;
  try {
    stored = JSON.parse(text);
  } catch {
    return send(res, 500, { error: '存档已损坏，无法解析' });
  }

  try {
    const project = normalizeProject(stored.project);
    return send(res, 200, { uploadedAt: stored.savedAt ?? null, project });
  } catch (err) {
    return send(res, 500, { error: `存档格式不合法：${err.message}` });
  }
}

async function handleWorkshopSavePut(req, res) {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > WS_NAME_MAX) {
    return send(res, 400, { error: `存档名称需要 1–${WS_NAME_MAX} 个字符` });
  }

  let user = typeof raw.user === 'string' ? raw.user.trim() : '';
  if (user.length > WS_USER_MAX) {
    return send(res, 400, { error: `用户名称不能超过 ${WS_USER_MAX} 个字符` });
  }
  if (!user) user = '匿名';

  if (raw.preview != null
      && (typeof raw.preview !== 'string'
          || raw.preview.length > WS_PREVIEW_MAX
          || !WS_PREVIEW_RE.test(raw.preview))) {
    return send(res, 400, { error: '预览图不合法：需要 256px 级别的 WebP/PNG/JPEG dataURL' });
  }

  let project;
  try {
    project = normalizeProject(raw.project);
  } catch (err) {
    return send(res, 400, { error: `存档格式不合法：${err.message}` });
  }

  const savedAt = new Date().toISOString();
  // id 由时间与随机数拼出，只含 [0-9a-z_-]，拿它直接拼文件名不会有路径注入
  const id = `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // 先落存档再更新清单：清单这步失败时存档已在，只是不再被列出；
  // 反过来则会出现清单里点开却 404 的条目
  const size = await writeJsonAtomic(path.join(SAVES_DIR, `${id}.json`), { savedAt, project });

  const item = {
    id,
    name,
    user,
    preview: raw.preview ?? null,
    hasRaster: project.rasterMaps.length > 0,
    size,
    uploadedAt: savedAt,
  };
  await queuePreviewsUpdate(async () => {
    const list = { updatedAt: savedAt, items: [item] };
    try {
      const parsed = JSON.parse(await readFile(PREVIEWS_FILE, 'utf8'));
      if (Array.isArray(parsed.items)) list.items.push(...parsed.items);
    } catch {
      // 读不到（第一次上传）或解析失败都按空清单重建：原子写排除了写一半的档，
      // 与其让一份坏文件卡死所有上传，不如从当前这条重来
    }
    await writeJsonAtomic(PREVIEWS_FILE, list);
  });

  send(res, 200, { id, uploadedAt: savedAt });
}

function methodNotAllowed(res, allow) {
  send(res, 405, { error: '方法不允许' }, { Allow: allow });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/health') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/project') {
      if (!EXPECTED_DIGEST) {
        return send(res, 404, { error: '云端存档未启用：部署时设置 WORLD_TOKEN 即可开启' });
      }
      if (req.method !== 'GET' && req.method !== 'PUT') {
        return methodNotAllowed(res, 'GET, PUT');
      }
      if (!isAuthorized(req)) {
        return send(res, 401, { error: '访问令牌不正确' });
      }
      return req.method === 'GET' ? await handleGet(res) : await handlePut(req, res);
    }

    // 工坊存档的 id 只允许这套字符：路由本身就把路径注入挡掉了
    const saveMatch = pathname.match(/^\/api\/workshop\/saves\/([A-Za-z0-9_-]{1,64})$/);
    if (saveMatch) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleWorkshopSaveGet(res, saveMatch[1]);
    }

    if (pathname === '/api/workshop/saves') {
      if (req.method !== 'PUT') return methodNotAllowed(res, 'PUT');
      return handleWorkshopSavePut(req, res);
    }

    if (pathname === '/api/workshop/previews') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleWorkshopPreviews(res);
    }

    return send(res, 404, { error: '接口不存在' });
  } catch (err) {
    console.error('[api] 请求处理失败：', err);
    if (!res.headersSent) send(res, 500, { error: '服务器内部错误' });
    else res.destroy();
  }
});

// 20+ MB 的存档走慢速公网上传时，默认的两分钟会在请求还没收完时被掐断
server.requestTimeout = 600_000;

await mkdir(DATA_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] listening on ${PORT}, data dir: ${DATA_DIR}`
    + (EXPECTED_DIGEST ? '' : '，云端存档未启用（未设置 WORLD_TOKEN）'));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
