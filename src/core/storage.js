/**
 * 持久化：IndexedDB 单条记录存整个项目（图片 data URL 体积大，不适合 localStorage），
 * 500ms 防抖自动保存；导出/导入为单个 .world.json 文件。
 * IndexedDB 不可用（隐私模式等）时退化为内存保存，并在导出功能里提醒。
 */

import { normalizeProject, normalizeTempChronicle } from './project.js';

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
 * 导出 .world.json。项目数据与姓名快照共用一个文件，但放在各自的字段里：
 * 前者是持久数据；后者是搜索当时固化的事件 id 集合（界面上表现为临时章节），
 * 连同当时选中哪几个一起写出，导入时据此恢复那一次视图。
 */
export function downloadProject(project, snapshots = [], activeSnapshotIds = []) {
  const payload = { ...project, viewSnapshots: snapshots, activeSnapshotIds };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${project.name || '未命名世界'}.world.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * 读入 .world.json：项目先校验，姓名快照再按校验后的项目 id 过滤。
 * 兼容旧文件里的单个 `tempChronicle` 字段——它相当于只有一个快照的列表。
 */
export async function importProjectFile(file) {
  const text = await file.text();
  const raw = JSON.parse(text);
  const project = normalizeProject(raw);
  const rawSnapshots = Array.isArray(raw.viewSnapshots)
    ? raw.viewSnapshots
    : raw.tempChronicle ? [raw.tempChronicle] : [];
  const snapshots = rawSnapshots
    .map((s) => normalizeTempChronicle(s, project))
    .filter(Boolean);
  const known = new Set(snapshots.map((s) => s.id));
  // 旧文件没有选中记录，按原来的行为把它那一个快照直接选中
  const activeSnapshotIds = Array.isArray(raw.activeSnapshotIds)
    ? raw.activeSnapshotIds.filter((id) => known.has(id))
    : snapshots.map((s) => s.id);
  return { project, snapshots, activeSnapshotIds };
}
