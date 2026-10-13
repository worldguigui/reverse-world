import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled, BackToOverview, TimeSelect } from '../common.jsx';

const TITLES = { entry: '📍 条目', route: '🛤 路线', region: '🏳 势力区域' };

/**
 * 条目 / 路线 / 区域的查看与编辑。
 * 调用方用 key={kind:id} 挂载，切换选中对象即重挂载，各字段自然取到新对象的值。
 */
export function ItemEditor({ kind, id }) {
  const project = useStore((s) => s.project);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const flyToItem = useStore((s) => s.flyToItem);
  const pickImage = useStore((s) => s.pickImage);

  const list = { entry: project.entries, route: project.routes, region: project.regions }[kind];
  const item = list?.find((it) => it.id === id);
  if (!item) return null;

  const patch = (p) => updateItem(kind, id, p);

  return (
    <div className="insp-block">
      <div className="insp-title">{TITLES[kind]}</div>

      {kind === 'entry' && (
        <>
          <div className="field-label">配图</div>
          {item.image ? (
            <div style={{ display: 'grid', gap: '6px' }}>
              <img className="entry-img" src={item.image} alt="" />
              <button className="btn" onClick={() => patch({ image: null })}>移除配图</button>
            </div>
          ) : (
            <button
              className="btn"
              onClick={async () => {
                const file = await pickImage();
                if (file) patch({ image: await fileToDataUrl(file, 1024) });
              }}
            >
              ⬆ 上传配图
            </button>
          )}
        </>
      )}

      <Labeled label={kind === 'region' ? '名称' : '标题'}>
        <input
          className="inp"
          defaultValue={item.title ?? item.name ?? ''}
          // 区域在 core 里的名称字段是 name，其余是 title
          onChange={(e) => patch(kind === 'region' ? { name: e.target.value } : { title: e.target.value })}
        />
      </Labeled>

      <Labeled label="描述">
        <textarea
          className="inp"
          rows={4}
          placeholder="补充这个内容的设定…"
          defaultValue={item.description || ''}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Labeled>

      {kind === 'entry' && (
        <Labeled label="坐标">
          <span>
            <span className="insp-hint">{`${item.lat.toFixed(2)}°, ${item.lng.toFixed(2)}° `}</span>
            <button className="btn btn-mini" onClick={() => flyToItem('entry', item)}>飞到</button>
          </span>
        </Labeled>
      )}
      {kind === 'route' && (
        <Labeled label="途经点">
          <span className="insp-hint">{`${item.points.length} 个点`}</span>
        </Labeled>
      )}
      {kind === 'region' && (
        <Labeled label="顶点">
          <span className="insp-hint">{`${item.ring.length} 个点`}</span>
        </Labeled>
      )}

      <Labeled label="出现于">
        <TimeSelect value={item.from} onChange={(v) => patch({ from: v || null })} />
      </Labeled>
      <Labeled label="消失于">
        <TimeSelect value={item.to} onChange={(v) => patch({ to: v || null })} nullLabel="至今" />
      </Labeled>
      <Labeled label="颜色">
        <input type="color" value={item.color} onChange={(e) => patch({ color: e.target.value })} />
      </Labeled>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn" onClick={() => flyToItem(kind, item)}>🎯 定位</button>
        <button
          className="btn btn-danger"
          onClick={() => { if (confirm('确认删除？')) deleteItem(kind, id); }}
        >
          🗑 删除
        </button>
      </div>

      <BackToOverview />
    </div>
  );
}
