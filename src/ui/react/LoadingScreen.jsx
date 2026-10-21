import { useStore } from '../../store/index.js';

/**
 * 全屏载入页。状态由 ui.loading 驱动：{ title, detail, progress }，
 * progress 为 0..1，null 表示还没法估算，进度条走不确定态。
 */
export function LoadingScreen() {
  const loading = useStore((s) => s.loading);
  if (!loading) return null;

  const { title = '正在载入…', detail = '', progress = null } = loading;
  const known = Number.isFinite(progress);
  const pct = known ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;

  return (
    <div className="loading-screen" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-card glass">
        <div className="loading-title">{title}</div>
        {/* 空一行也占住高度：阶段文字长短不一，否则卡片会跟着上下跳 */}
        <p className="loading-detail">{detail || ' '}</p>
        <div className={`loading-track${known ? '' : ' indeterminate'}`}>
          <span className="loading-fill" style={known ? { width: `${pct}%` } : undefined} />
        </div>
        <div className="loading-pct">{known ? `${pct}%` : '加载中…'}</div>
      </div>
    </div>
  );
}
