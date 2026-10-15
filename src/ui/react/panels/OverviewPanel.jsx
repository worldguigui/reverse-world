import { useStore } from '../../../store/index.js';
import { useProjectRevision } from '../hooks.js';
import { Labeled } from '../common.jsx';

const STATS = [
  ['entries', '地点'], ['events', '事件'],
  ['routes', '路线'], ['regions', '区域'],
  ['characters', '人物'],
];

/**
 * 没有选中任何对象时的世界概览：名称、简介、统计格、舞台。
 * 这一页讲的是整个世界，所以没有「配图」——配图属于某一条地点或事件，属于具体的东西。
 */
export function OverviewPanel() {
  const project = useStore((s) => s.project);
  const counts = useStore((s) => s.derived.counts);
  const updateProject = useStore((s) => s.updateProject);
  const uploadMap = useStore((s) => s.uploadMap);
  const clearStage = useStore((s) => s.clearStage);
  const openWorkshop = useStore((s) => s.openWorkshop);
  const generateRealEarth = useStore((s) => s.generateRealEarth);
  const importCities = useStore((s) => s.importCities);
  useProjectRevision(); // 上传底图 / 改地形后这张脸的名字要跟着变

  const baseMap = project.maps.find((m) => m.id === project.baseMapId) ?? null;
  const baseRaster = project.rasterMaps.find((m) => m.id === project.baseRasterId) ?? null;
  const face = baseRaster ? `地形 · ${baseRaster.name}` : baseMap ? `底图 · ${baseMap.name}` : '引擎自带的地球贴图';

  // 单选项由数据决定选中态，故受控：上传新底图后要立刻反映到这一组 radio 上
  const mapRow = (map) => (
    <label className="map-row" key={map.id}>
      <input
        type="radio"
        name="stage-map"
        checked={project.baseMapId === map.id}
        onChange={() => { updateProject({ baseMapId: map.id, baseRasterId: null }); }}
      />
      <img className="map-thumb" src={map.dataUrl} alt={map.name} />
      <span>{map.name}</span>
    </label>
  );

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

      <hr className="sep" />

      {/* 舞台：球自己的那张脸。与时间无关——拖游标不会换脸，换脸也不动游标 */}
      <div className="field-label">舞台 · 球长什么样</div>
      <p className="insp-hint">{`当前：${face}`}</p>

      <div style={{ display: 'grid', gap: '6px' }}>
        <label className="map-row">
          <input
            type="radio"
            name="stage-map"
            checked={!project.baseMapId && !project.baseRasterId}
            onChange={() => clearStage()}
          />
          <span>引擎自带的地球贴图</span>
        </label>
        {project.maps.map(mapRow)}
      </div>

      <button className="btn" onClick={() => uploadMap()}>⬆ 上传底图</button>

      <div className="field-label">地形（真实山川河流，栅格优先于底图）</div>
      <div style={{ display: 'grid', gap: '6px' }}>
        <button className="btn" onClick={() => openWorkshop()}>
          {baseRaster ? '🖌 编辑地形' : '🖌 画一张地形'}
        </button>
        <button className="btn" onClick={() => generateRealEarth()}>🌐 从真实地球生成地形</button>
        <button className="btn" onClick={() => importCities()}>🏙 导入真实城市（243）</button>
      </div>

      <p className="insp-hint" style={{ marginTop: '10px' }}>
        单击球面内容查看详情；拖动底部游标，看地点与事件在时间里依次登场。
      </p>
    </div>
  );
}
