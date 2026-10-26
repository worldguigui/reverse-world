import { useStore } from '../../../store/index.js';
import { useProjectRevision } from '../hooks.js';
import { Labeled } from '../common.jsx';

// 数列得出来的东西：事件在长卷与刻度上、路线与区域在球上、人物在顶栏，每一格背后都有地方看。
// 地点曾经也占一格，可它三处都没有入口——报一个数却无处可看，于是连同这一等实体一起拿掉。
const STATS = [
  ['events', '事件'],
  ['routes', '路线'], ['regions', '区域'],
  ['characters', '人物'],
];

/**
 * 没有选中任何对象时的世界概览：名称、简介、统计格、舞台。
 * 这一页讲的是整个世界，所以没有「配图」——配图属于某一条事件或某一个人物，属于具体的东西。
 */
export function OverviewPanel() {
  const project = useStore((s) => s.project);
  const counts = useStore((s) => s.derived.counts);
  const updateProject = useStore((s) => s.updateProject);
  const openWorkshop = useStore((s) => s.openWorkshop);
  const generateRealEarth = useStore((s) => s.generateRealEarth);
  const setOverviewOpen = useStore((s) => s.setOverviewOpen);
  useProjectRevision(); // 新建 / 生成地图后，这张脸的名字要跟着变

  const baseRaster = project.rasterMaps.find((m) => m.id === project.baseRasterId) ?? null;
  const face = baseRaster ? `地图 · ${baseRaster.name}` : '空世界';

  return (
    <div className="insp-block">
      <div
        className="set-row-top"
        style={{ paddingBottom: 8, borderBottom: '1px solid var(--border)' }}
      >
        <div className="insp-title">世界概览</div>
        <button
          className="icon-btn"
          title="收起世界概览；从左上角世界名或项目菜单可以再打开"
          onClick={() => setOverviewOpen(false)}
        >
          ✕
        </button>
      </div>

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

      <hr className="sep" />

      <p className="insp-hint">{`当前：${face}`}</p>

      <div style={{ display: 'grid', gap: '6px' }}>
        <button className="btn" onClick={() => openWorkshop()}>
          {baseRaster ? '编辑地图' : '自己画一个地图'}
        </button>
        <button className="btn" onClick={() => generateRealEarth()}>从真实地球生成地图</button>
      </div>

      <p className="insp-hint" style={{ marginTop: '10px' }}>
        单击球面上的路线与区域查看详情；拖动底部游标，查看事件
      </p>
    </div>
  );
}
