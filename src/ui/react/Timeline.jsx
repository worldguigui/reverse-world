import { useEffect, useRef } from 'react';
import { useStore } from '../../store/index.js';
import { useProjectRevision } from './hooks.js';

/**
 * 底部时间轴：时间点 chips + 前后切换 + 新增。
 * 单击切换切面，双击进入时间点编辑（右侧检查器）。
 */
export function Timeline() {
  const project = useStore((s) => s.project);
  const timeIndex = useStore((s) => s.timeIndex);
  const setTime = useStore((s) => s.setTime);
  const step = useStore((s) => s.step);
  const addTimePoint = useStore((s) => s.addTimePoint);
  const editTimePoint = useStore((s) => s.editTimePoint);
  useProjectRevision(); // 时间点被增删或改名后要重画

  const currentRef = useRef(null);
  const timePoints = project?.timePoints ?? [];

  // 当前 chip 始终留在可视区内（切面可以来自键盘、双击或其他面板）
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [timeIndex, timePoints.length]);

  return (
    <div className="tl-inner">
      <button className="tl-arrow" title="上一个时间点 (←)" onClick={() => step(-1)}>◀</button>
      <div className="tl-chips">
        {timePoints.map((tp, i) => (
          <button
            key={tp.id}
            ref={i === timeIndex ? currentRef : null}
            className={`tl-chip${i === timeIndex ? ' current' : ''}`}
            title="单击切换切面，双击编辑"
            onClick={() => setTime(i)}
            onDoubleClick={() => editTimePoint(tp.id)}
          >
            {tp.label}
          </button>
        ))}
      </div>
      <button className="tl-arrow tl-add" title="添加时间点" onClick={() => addTimePoint()}>+</button>
      <button className="tl-arrow" title="下一个时间点 (→)" onClick={() => step(1)}>▶</button>
    </div>
  );
}
