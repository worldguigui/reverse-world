/**
 * 持久化：IndexedDB 单条记录存整个项目（图片 data URL 体积大，不适合 localStorage），
 * 500ms 防抖自动保存；导出/导入为单个 .world.json 文件。
 * IndexedDB 不可用（隐私模式等）时退化为内存保存，并在导出功能里提醒。
 */

import { normalizeProject, uid } from './project.js';

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

export async function loadStoredProject() {
  try {
    const raw = await idbGet(KEY);
    return raw ? normalizeProject(raw) : null;
  } catch (err) {
    console.warn('[storage] IndexedDB 不可用，本次会话不会自动保存：', err);
    return null;
  }
}

/** 直接保存（导入、退出前 flush 用） */
export async function saveNow(project) {
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

/**
 * 读入 .world.json。旧版本把姓名搜索的结果写在项目之外（`viewSnapshots` 或更早的
 * `tempChronicle`），现在它们就是普通章节：导入时补进 groups，
 * 事件 id 按当前项目校验一遍。新文件不会有这两个字段。
 */
export async function importProjectFile(file) {
  const text = await file.text();
  const raw = JSON.parse(text);
  const project = normalizeProject(raw);
  const legacy = Array.isArray(raw.viewSnapshots)
    ? raw.viewSnapshots
    : raw.tempChronicle ? [raw.tempChronicle] : [];
  if (legacy.length) {
    const known = new Set(project.events.map((e) => e.id));
    for (const s of legacy) {
      if (!s || typeof s !== 'object' || !Array.isArray(s.eventIds)) continue;
      const eventIds = [...new Set(s.eventIds)].filter((id) => known.has(id));
      if (!eventIds.length) continue;
      const title = typeof s.title === 'string' ? s.title.trim() : '';
      project.groups.push({
        id: typeof s.id === 'string' && s.id ? s.id : uid('g'),
        name: title || '未命名章节',
        eventIds,
      });
    }
  }
  return project;
}
