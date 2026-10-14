import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled } from '../common.jsx';

const STATS = [
  ['timePoints', '时间点'], ['maps', '底图'], ['entries', '条目'],
  ['routes', '路线'], ['regions', '区域'],
];

/** 没有选中任何对象时的世界概览：名称、简介、统计格、当前切面的配图 */
export function OverviewPanel() {
  const project = useStore((s) => s.project);
  const counts = useStore((s) => s.derived.counts);
  const timeIndex = useStore((s) => s.timeIndex);
  const updateProject = useStore((s) => s.updateProject);
  const updateTimePoint = useStore((s) => s.updateTimePoint);
  const pickImage = useStore((s) => s.pickImage);

  const tp = project.timePoints[timeIndex];

  return (
    <div className="insp-block">
      <div className="insp-title">世界概览</div>

      <Labeled label="名称">
        <input
          className="inp"
          defaultValue={project.name}
          onChange={(e) => updateProject({ name: e.target.value })}
        />
      </Labeled>

      <Labeled label="简介">
        <textarea
          className="inp"
          rows={3}
          placeholder="这个世界的简要设定…"
          defaultValue={project.description || ''}
          onChange={(e) => updateProject({ description: e.target.value })}
        />
      </Labeled>

      <div className="stat-grid">
        {STATS.map(([key, label]) => (
          <div className="stat" key={key}>
            <b>{counts?.[key] ?? 0}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* 当前切面的配图，做法与条目配图完全一致（见 panels/ItemEditor.jsx）。
          配图属于时代：换一个时间点就是换一张图 */}
      {tp && (
        <>
          <div className="field-label">{`配图 · ${tp.label}`}</div>
          {tp.image ? (
            <div style={{ display: 'grid', gap: '6px' }}>
              <img className="entry-img" src={tp.image} alt="" />
              <button className="btn" onClick={() => updateTimePoint(tp.id, { image: null })}>移除配图</button>
            </div>
          ) : (
            <button
              className="btn"
              onClick={async () => {
                const file = await pickImage();
                if (file) updateTimePoint(tp.id, { image: await fileToDataUrl(file, 1024) });
              }}
            >
              ⬆ 上传配图
            </button>
          )}
        </>
      )}

      <p className="insp-hint" style={{ marginTop: '10px' }}>
        {tp
          ? `当前切面：${tp.label} —— 单击球面内容查看详情；切换到底部时间轴的其他时间点浏览世界演变。`
          : '还没有时间点：先在底部时间轴点「+」添加第一个时间点并上传底图。'}
      </p>
    </div>
  );
}
