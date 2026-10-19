/**
 * 云端存档 API：单用户、单存档位。
 *
 * 前端只通过两个接口使用它：
 *   GET /api/project  取回云端项目
 *   PUT /api/project  用当前项目覆盖云端存档
 *
 * 读写都需要 Bearer 令牌。写入先落临时文件再 rename，断电时不会留下写了一半的档。
 * 项目结构复用 core/project.js 的 normalizeProject——云端存档和本地导入必须接受同一套格式。
 */
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeProject } from '../src/core/project.js';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'project.json');
const TOKEN = process.env.WORLD_TOKEN || '';
// 前端项目可能内嵌 2048×1024 的地图 PNG 与多张人物图，25 MiB 足够，又不至于让畸形请求吃光内存
const MAX_BODY = 25 * 1024 * 1024;

if (!TOKEN) {
  console.error('[api] 缺少 WORLD_TOKEN 环境变量，拒绝启动');
  process.exit(1);
}

// 先各自摘要再比较：两个缓冲区等长，计时相对稳定，也不会因令牌长度不同而提前返回
const EXPECTED_DIGEST = createHash('sha256').update(TOKEN).digest();

function isAuthorized(req) {
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

/** 返回写入的字节数 */
async function writeProject(envelope) {
  await mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(envelope);
  // 同一进程的并发 PUT 不能共用一个临时文件名，否则后一次会覆盖前一次还没 rename 的内容
  const tmp = `${FILE}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, FILE);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return Buffer.byteLength(payload);
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
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    send(res, 415, { error: '请求体必须是 application/json' });
    req.resume();
    return;
  }

  // Content-Length 已经超限就不必再收：nginx 那边也会挡一道，这里只是尽早结束
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
    send(res, 413, { error: '项目文件过大，服务器上限为 25 MB' });
    req.resume();
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    send(res, 413, { error: '项目文件过大，服务器上限为 25 MB' });
    return;
  }

  let raw;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    send(res, 400, { error: '请求体不是合法 JSON' });
    return;
  }

  let project;
  try {
    project = normalizeProject(raw);
  } catch (err) {
    send(res, 400, { error: err.message });
    return;
  }

  const savedAt = new Date().toISOString();
  const size = await writeProject({ savedAt, project });
  send(res, 200, { savedAt, size });
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
      if (req.method !== 'GET' && req.method !== 'PUT') {
        return methodNotAllowed(res, 'GET, PUT');
      }
      if (!isAuthorized(req)) {
        return send(res, 401, { error: '访问令牌不正确' });
      }
      return req.method === 'GET' ? await handleGet(res) : await handlePut(req, res);
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
  console.log(`[api] listening on ${PORT}, data file: ${FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
