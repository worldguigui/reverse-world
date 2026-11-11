import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store/index.js';
import { getWorkshopUser, formatWorkshopTime } from '../../core/workshop.js';
import { fileToDataUrl } from '../../utils/files.js';

/** dataURL 里 base64 段的实际字节数；没有逗号说明不是 dataURL，按 0 算 */
const dataUrlBytes = (dataUrl = '') => {
  const i = dataUrl.indexOf(',');
  return i < 0 ? 0 : Math.floor((dataUrl.length - i - 1) * 0.75);
};

const fmtSize = (bytes) => (
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
);

/**
 * 创意工坊对话框：浏览所有人上传的世界，或把当前世界传上去。
 *
 * 通过 portal 挂到 body：顶栏自身有 z-index 层级，把全屏遮罩留在顶栏内部
 * 会被那层 stacking context 框住。下载的替换确认用卡片内的两步点击完成，
 * 不弹阻塞式 confirm——wallpaper 场景里全局弹窗会卡住交互。
 * 上传与下载的重活都交给全屏加载页，对话框里只留表单校验这类轻量错误。
 */
export function WorkshopDialog({ onClose }) {
  const project = useStore((s) => s.project);
  const toast = useStore((s) => s.toast);
  const pickImage = useStore((s) => s.pickImage);
  const fetchPreviews = useStore((s) => s.fetchWorkshopPreviews);
  const uploadToWorkshop = useStore((s) => s.uploadToWorkshop);
  const downloadFromWorkshop = useStore((s) => s.downloadFromWorkshop);

  const [tab, setTab] = useState('browse');
  const [items, setItems] = useState(null); // null = 清单还在拉取
  const [listError, setListError] = useState('');
  const [confirmId, setConfirmId] = useState(null); // 正在两步确认载入的条目
  const [busy, setBusy] = useState(null); // 'upload' | 'load'
  const [error, setError] = useState('');

  // 上传表单：名称取当前世界，用户名称沿用上次的输入
  const [name, setName] = useState(project?.name ?? '');
  const [user, setUser] = useState(() => getWorkshopUser());
  const [preview, setPreview] = useState(null); // dataURL，可不选
  const [includeRaster, setIncludeRaster] = useState(Boolean(project?.rasterMaps?.length));

  // 底图是体积大头，随勾选状态实时给出估算，让人知道勾上要传多大
  const rasterBytes = useMemo(() => (project?.rasterMaps ?? [])
    .reduce((sum, m) => sum + dataUrlBytes(m.dataUrl), 0), [project]);

  const loadList = async () => {
    setItems(null);
    setListError('');
    try {
      setItems(await fetchPreviews());
    } catch (err) {
      setListError(err.message);
    }
  };

  useEffect(() => { loadList(); }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 对话框在最上层：Esc 归它处理，不能继续传给窗口去退出底下的编辑模式
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (confirmId) { setConfirmId(null); return; }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, confirmId, onClose]);

  const switchTab = (next) => {
    if (busy) return;
    setTab(next);
    setConfirmId(null);
    setError('');
    // 每次回到浏览页都重拉清单：刚上传的那条要能立刻看到
    if (next === 'browse') loadList();
  };

  const choosePreview = async () => {
    const file = await pickImage();
    if (!file) return;
    try {
      setPreview(await fileToDataUrl(file, 256));
      if (error) setError('');
    } catch (err) {
      setError(err.message);
    }
  };

  const runUpload = async () => {
    const title = name.trim();
    if (!title) {
      setError('请先给存档起个名字');
      return;
    }
    setBusy('upload');
    setError('');
    try {
      await uploadToWorkshop({ name: title, user: user.trim(), preview, includeRaster });
      setBusy(null);
      switchTab('browse');
    } catch (err) {
      setBusy(null);
      setError(err.message);
    }
  };

  const runDownload = async (item) => {
    setConfirmId(null);
    setBusy('load');
    setError('');
    try {
      await downloadFromWorkshop(item.id, item.name);
      onClose();
    } catch (err) {
      setBusy(null);
      toast(`载入失败：${err.message}`);
    }
  };

  return createPortal(
    <div
      className="cloud-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="cloud-dialog glass ws-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cloud-head">
          <div>
            <h2 className="cloud-title" id="ws-title">创意工坊</h2>
            <p className="cloud-sub">上传当前世界，或浏览并载入别人分享的世界</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose} disabled={!!busy}>✕</button>
        </div>

        <div className="ws-tabs" role="tablist">
          <button
            className={`ws-tab${tab === 'browse' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'browse'}
            onClick={() => switchTab('browse')}
            disabled={!!busy}
          >
            浏览
          </button>
          <button
            className={`ws-tab${tab === 'upload' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'upload'}
            onClick={() => switchTab('upload')}
            disabled={!!busy}
          >
            上传
          </button>
        </div>

        {tab === 'browse' ? (
          <div className="ws-body">
            {items === null && !listError && <p className="ws-status">正在拉取预览清单…</p>}
            {listError && (
              <div className="ws-status">
                <p className="cloud-error" role="alert">{listError}</p>
                <button className="btn" onClick={loadList}>重试</button>
              </div>
            )}
            {items?.length === 0 && (
              <p className="ws-status">还没有人上传世界——切到「上传」页把你的放上来</p>
            )}
            {items?.length > 0 && (
              <div className="ws-grid">
                {items.map((it) => (
                  <div
                    key={it.id}
                    className={`ws-card${confirmId === it.id ? ' confirming' : ''}`}
                  >
                    {confirmId === it.id ? (
                      <div className="ws-confirm">
                        <p>
                          确认载入「{it.name}」吗？当前世界不可恢复。
                        </p>
                        <div className="ws-confirm-actions">
                          <button className="btn btn-ghost" onClick={() => setConfirmId(null)} disabled={!!busy}>取消</button>
                          <button className="btn btn-primary" onClick={() => runDownload(it)} disabled={!!busy}>确认载入</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          className="ws-thumb"
                          title="载入这个世界"
                          onClick={() => setConfirmId(it.id)}
                          disabled={!!busy}
                        >
                          {it.preview
                            ? <img src={it.preview} alt={it.name} loading="lazy" />
                            : <span className="ws-thumb-empty">无预览图</span>}
                        </button>
                        <div className="ws-meta">
                          <span className="ws-name" title={it.name}>{it.name}</span>
                          <span className="ws-sub">
                            {it.user} · {formatWorkshopTime(it.uploadedAt)}
                            {!it.hasRaster && ' · 不含底图'}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="ws-body">
            {project && (
              <p className="cloud-note">
                当前世界：<strong className="cloud-current">{project.name}</strong>
              </p>
            )}

            <label className="cloud-field">
              <span className="field-label">存档名称</span>
              <input
                className="inp"
                value={name}
                maxLength={60}
                spellCheck={false}
                placeholder="给这份世界起个名字"
                disabled={!!busy}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError('');
                }}
              />
            </label>

            <label className="cloud-field">
              <span className="field-label">用户名称（可选）</span>
              <input
                className="inp"
                value={user}
                maxLength={40}
                spellCheck={false}
                placeholder="匿名"
                disabled={!!busy}
                onChange={(e) => setUser(e.target.value)}
              />
            </label>

            <div className="cloud-field">
              <span className="field-label">预览图（可选）</span>
              {preview ? (
                <div className="ws-preview-row">
                  <img className="ws-preview-img" src={preview} alt="预览图" />
                  <button className="btn btn-ghost" onClick={() => setPreview(null)} disabled={!!busy}>移除</button>
                </div>
              ) : (
                <button className="btn" onClick={choosePreview} disabled={!!busy || !project}>
                  选择图片
                </button>
              )}
            </div>

            {(project?.rasterMaps?.length ?? 0) > 0 && (
              <label className="set-check ws-raster-check">
                <span>
                  包含底图（约 {fmtSize(rasterBytes)}
                </span>
                <input
                  type="checkbox"
                  checked={includeRaster}
                  disabled={!!busy}
                  onChange={(e) => setIncludeRaster(e.target.checked)}
                />
              </label>
            )}

            {error && <p className="cloud-error" role="alert">{error}</p>}

            <div className="cloud-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={!!busy}>取消</button>
              <button className="btn btn-primary" onClick={runUpload} disabled={!!busy || !project}>
                {busy === 'upload' ? '上传中…' : '上传到创意工坊'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
