import { useState } from 'react';
import { useStore } from '../../store/index.js';

/**
 * 启动提示：恢复本机存档失败时，告诉用户原数据被放在了哪里。
 *
 * 用页内浮层而不是 alert()：原生对话框是同步的，弹出来时整个启动流程停在这一行；
 * 壁纸这类展示环境默认让鼠标穿透，按钮根本点不到，页面就永远卡在对话框上。
 * 这里只占一块可以关掉的浮层，启动照常继续。
 */
export function StartupNotice() {
  const notice = useStore((s) => s.startupNotice);
  const dismiss = useStore((s) => s.dismissStartupNotice);
  const [copyState, setCopyState] = useState('idle');

  if (!notice) return null;

  const key = notice.backupKey ?? 'current-project';

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(key);
      setCopyState('ok');
    } catch {
      // 嵌入式浏览器常不给剪贴板权限：退回临时文本框 + execCommand 的老办法
      const box = document.createElement('textarea');
      box.value = key;
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      box.remove();
      setCopyState(ok ? 'ok' : 'fail');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <div className="notice glass" role="status">
      <div className="notice-title">上次的世界没有读取成功</div>
      <p className="notice-text">{notice.reason}</p>
      {notice.backupKey ? (
        <p className="notice-text">
          原数据已原样备份到 IndexedDB 键
          <code className="notice-key">{notice.backupKey}</code>
          ，可复制后通过「导入」重新打开。本次已从空白世界开始。
        </p>
      ) : (
        <p className="notice-text">
          备份失败，原记录仍留在 IndexedDB 键
          <code className="notice-key">current-project</code>
          。本次会话已停止自动保存，新建或导入都不会覆盖它；请先复制这条记录，再刷新页面。
        </p>
      )}
      <p className="notice-path">路径：开发者工具 → Application → IndexedDB → worldbuilding-tool → kv</p>
      <div className="notice-actions">
        <button className="btn btn-mini" onClick={copyKey}>
          {copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败，请手动选中' : '复制键名'}
        </button>
        <button className="btn btn-mini btn-ghost" onClick={dismiss}>知道了</button>
      </div>
    </div>
  );
}
