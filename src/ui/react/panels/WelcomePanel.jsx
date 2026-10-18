import { useStore } from '../../../store/index.js';

/** 还没有世界时的落地页 */
export function WelcomePanel() {
  const loadSample = useStore((s) => s.loadSample);
  const newProject = useStore((s) => s.newProject);

  return (
    <div className="insp-block">
      <div className="insp-title">🌍 世界观时间轴工具</div>
      <p className="insp-hint">
        画一张平面地图（等距圆柱投影）铺在球体上，用一根游标串起世界的演变，在球面上放置事件、路线与势力区域。
      </p>
      <div style={{ display: 'grid', gap: '8px', marginTop: '14px' }}>
        <button className="btn btn-primary" onClick={() => loadSample()}>载入示例世界（地球）</button>
        <button className="btn" onClick={() => newProject()}>新建空白世界</button>
      </div>
    </div>
  );
}
