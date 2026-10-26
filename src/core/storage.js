/**
 * 持久化：IndexedDB 单条记录存整个项目（图片 data URL 体积大，不适合 localStorage），
 * 500ms 防抖自动保存；导出/导入为单个 .world.json 文件。
 * IndexedDB 不可用（隐私模式等）时退化为内存保存，并在导出功能里提醒。
 */

import { normalizeProject } from './project.js';

const DB_NAME = 'worldbuilding-tool';
const STORE = 'kv';
const KEY = 'current-project';

let _dbPromise = null;
function openDb() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    });
  }
  return _dbPromise;
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

const CORRUPT_PREFIX = `${KEY}-corrupt-`;

/**
 * 坏档备份失败时置位：本次会话禁止任何写入。
 * 此时唯一副本还躺在 KEY 上，一次自动保存就会把它覆盖，而这个副本已经复制不出来了。
 */
let writesBlocked = false;

/**
 * 读取本机存档。结果必须区分「读不到库」「没有档」「有档但校验不过」：
 * 三者混成同一个 null 时，坏档会被当成空世界，第一次自动保存就把唯一副本覆盖掉。
 * @returns {Promise<{
 *   status: 'ok'|'empty'|'unavailable'|'corrupt',
 *   project: object|null,
 *   error?: Error,
 *   backupKey?: string|null,
 * }>}
 */
export async function loadStoredProject() {
  let raw;
  try {
    raw = await idbGet(KEY);
  } catch (err) {
    console.warn('[storage] IndexedDB 不可用，本次会话不会自动保存：', err);
    return { status: 'unavailable', project: null, error: err };
  }
  if (raw == null) return { status: 'empty', project: null };

  try {
    return { status: 'ok', project: normalizeProject(raw) };
  } catch (err) {
    // 坏档隔离：先原样备份到独立键，再清掉当前键。
    // 不做这一步，用户随手「新建世界」就会用空白项目覆盖掉唯一副本。
    const backupKey = `${CORRUPT_PREFIX}${new Date().toISOString()}`;
    let savedKey = null;
    try {
      await idbPut(backupKey, raw);
      savedKey = backupKey;
    } catch (backupErr) {
      // 备份不成功时原记录仍在 KEY 上：此时必须锁写。
      // 触发条件不多（配额不足、磁盘写满类），但一旦发生就是不可逆的数据丢失。
      writesBlocked = true;
      console.error('[storage] 坏档备份失败，本次会话停止保存：', backupErr);
    }
    if (savedKey) {
      try {
        await idbDelete(KEY);
      } catch (delErr) {
        console.error('[storage] 坏记录清理失败：', delErr);
      }
    }
    console.error('[storage] 上次的世界校验失败，已隔离：', savedKey ?? '（未备份）', err);
    return { status: 'corrupt', project: null, error: err, backupKey: savedKey };
  }
}

/** 直接保存（导入、退出前 flush 用） */
export async function saveNow(project) {
  // 坏档还没复制出去：宁可不存新档，也不能覆盖唯一副本
  if (writesBlocked) return false;
  try {
    await idbPut(KEY, project);
    return true;
  } catch (err) {
    console.warn('[storage] 保存失败：', err);
    return false;
  }
}

/** 防抖自动保存器 */
export function createAutoSaver(delay = 500) {
  let timer = null;
  let pending = null;
  const saver = {
    save(project) {
      pending = project;
      clearTimeout(timer);
      timer = setTimeout(() => saver.flush(), delay);
    },
    flush() {
      clearTimeout(timer);
      if (pending) saveNow(pending);
      pending = null;
    },
  };
  return saver;
}

// ---------------------------------------------------------------- 导出 / 导入

/**
 * 导出 .world.json。章节就在项目里，姓名搜索生成的也只是普通章节，
 * 所以这里只写 project 本身，不再附一份单独的视图字段。
 */
export function downloadProject(project) {
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${project.name || '未命名世界'}.world.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 读入 .world.json：结构检查交给 normalizeProject，不对就抛错 */
export async function importProjectFile(file) {
  const text = await file.text();
  return normalizeProject(JSON.parse(text));
}
