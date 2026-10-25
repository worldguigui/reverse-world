import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store/index.js';
import { getCloudToken } from '../../core/cloud.js';

/**
 * 云端存档对话框：输入访问令牌，手动上传或取回唯一一份云端项目。
 *
 * 通过 portal 挂到 body：顶栏自身有 z-index 层级，把全屏遮罩留在顶栏内部
 * 会被那层 stacking context 框住。关闭成功由这里负责，错误留在框里显示，
 * 用户不必关掉重开才能改正令牌。
 */
export function CloudDialog({ onClose }) {
  const project = useStore((s) => s.project);
  const saveToCloud = useStore((s) => s.saveToCloud);
  const loadFromCloud = useStore((s) => s.loadFromCloud);

  const [token, setToken] = useState(() => getCloudToken());
  const [busy, setBusy] = useState(null); // 'save' | 'load'
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const saveRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 对话框在最上层：Esc 归它处理，不能继续传给窗口去退出底下的编辑模式
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // 只在打开时决定一次焦点：已有令牌就直接落在保存上，没有就先让人粘令牌
  useEffect(() => {
    if (token.trim()) saveRef.current?.focus();
    else inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (kind) => {
    const value = token.trim();
    if (!value) {
      setError('请输入访问令牌');
      inputRef.current?.focus();
      return;
    }
    setBusy(kind);
    setError('');
    try {
      if (kind === 'save') {
        await saveToCloud(value);
      } else {
        const result = await loadFromCloud(value);
        // 用户在替换确认里点了取消：停在对话框，不要把「没做事」当成成功
        if (!result) return;
      }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
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
        className="cloud-dialog glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cloud-head">
          <div>
            <h2 className="cloud-title" id="cloud-title">云端存档</h2>
            <p className="cloud-sub">单存档位 · 换浏览器或设备后凭令牌取回</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose} disabled={!!busy}>✕</button>
        </div>

        <p className="cloud-note">
          保存会覆盖服务器上的存档，载入会替换当前世界。本机编辑仍然自动保存，
          只有点击这里的按钮才会同步到云端。项目内嵌地图或图片较大时，上传/下载可能需要几分钟。
        </p>
        {project && (
          <p className="cloud-note">
            当前世界：<strong className="cloud-current">{project.name}</strong>
          </p>
        )}

        <label className="cloud-field">
          <span className="field-label">访问令牌</span>
          <input
            ref={inputRef}
            className="inp"
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder="部署时生成的访问令牌"
            disabled={!!busy}
            onChange={(e) => {
              setToken(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={(e) => {
              // 回车直接按「保存」处理；要载入就点旁边的按钮，避免误覆盖当前世界
              if (e.key === 'Enter' && !busy) {
                e.preventDefault();
                run('save');
              }
            }}
          />
        </label>

        {error && <p className="cloud-error" role="alert">{error}</p>}

        <div className="cloud-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={!!busy}>取消</button>
          <button className="btn" onClick={() => run('load')} disabled={!!busy}>
            {busy === 'load' ? '载入中…' : '从云端载入'}
          </button>
          <button ref={saveRef} className="btn btn-primary" onClick={() => run('save')} disabled={!!busy}>
            {busy === 'save' ? '保存中…' : '保存到云端'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
