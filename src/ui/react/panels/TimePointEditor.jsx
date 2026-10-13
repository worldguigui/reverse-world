import { useStore } from '../../../store/index.js';
import { useProjectRevision } from '../hooks.js';
import { Labeled, BackToOverview } from '../common.jsx';

/** 时间点编辑：改名、选底图、上传底图、进入地形工坊、删除 */
export function TimePointEditor({ tpId }) {
  const project = useStore((s) => s.project);
  const updateTimePoint = useStore((s) => s.updateTimePoint);
  const uploadMap = useStore((s) => s.uploadMap);
  const openWorkshop = useStore((s) => s.openWorkshop);
  const generateRealEarth = useStore((s) => s.generateRealEarth);
  const importCities = useStore((s) => s.importCities);
  const deleteTimePoint = useStore((s) => s.deleteTimePoint);
  useProjectRevision(); // 上传底图 / 生成地形后底图列表要跟着变

  const tp = project.timePoints.find((t) => t.id === tpId);
  if (!tp) return null;

  // 单选项由数据决定选中态，故受控：上传新底图后要立刻反映到这一组 radio 上
  const mapRow = (mapId, label, thumb) => (
    <label className="map-row" key={mapId ?? 'inherit'}>
      <input
        type="radio"
        name="tp-map"
        checked={(tp.mapId ?? null) === mapId}
        onChange={() => updateTimePoint(tp.id, { mapId })}
      />
      {thumb}
      <span>{label}</span>
    </label>
  );

  return (
    <div className="insp-block">
      <div className="insp-title">⏱ 时间点</div>

      <Labeled label="名称">
        <input
          className="inp"
          defaultValue={tp.label}
          onChange={(e) => updateTimePoint(tp.id, { label: e.target.value })}
        />
      </Labeled>

      <div className="field-label">底图（等距圆柱投影，2:1 为佳）</div>
      <div style={{ display: 'grid', gap: '6px' }}>
        {mapRow(null, '继承上一个时间点的底图')}
        {project.maps.map((m) => mapRow(
          m.id,
          m.name,
          <img className="map-thumb" src={m.dataUrl} alt={m.name} />,
        ))}
      </div>

      <button className="btn" onClick={() => uploadMap(tp.id)}>⬆ 上传新底图</button>

      <div className="field-label">栅格地形（真实山川河流）</div>
      <div style={{ display: 'grid', gap: '6px' }}>
        <button className="btn" onClick={() => openWorkshop(tp.id)}>🖌 用工坊编辑此时代地形</button>
        <button className="btn" onClick={() => generateRealEarth(tp.id)}>🌐 从真实地球生成地形</button>
        <button className="btn" onClick={() => importCities(tp.id)}>🏙 导入真实城市（243）</button>
      </div>

      <hr className="sep" />

      <button
        className="btn btn-danger"
        onClick={() => {
          if (confirm(`删除时间点「${tp.label}」？其上的条目范围会自动顺延，不会丢失。`)) {
            deleteTimePoint(tp.id);
          }
        }}
      >
        🗑 删除此时间点
      </button>

      <BackToOverview />
    </div>
  );
}
