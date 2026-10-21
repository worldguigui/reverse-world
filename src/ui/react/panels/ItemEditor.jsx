import { useStore } from '../../../store/index.js';
import { Labeled, BackToOverview, YearInput } from '../common.jsx';

const TITLES = { route: '路线', region: '势力区域' };

/**
 * 路线 / 区域的查看与编辑。改动即时写入项目——这两类内容没有事件那样的时间轴联动，
 * 改个名字不必再点一次保存。事件有独立的编辑卡，因为它的每个字段都会牵动编年史。
 *
 * 调用方用 key={kind:id} 挂载，切换选中对象即重挂载，各字段自然取到新对象的值。
 */
export function ItemEditor({ kind, id }) {
  const project = useStore((s) => s.project);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const flyToItem = useStore((s) => s.flyToItem);

  const list = { route: project.routes, region: project.regions }[kind];
  const item = list?.find((it) => it.id === id);
  if (!item) return null;

  const patch = (p) => updateItem(kind, id, p);

  return (
    <div className="insp-block">
      <div className="insp-title">{TITLES[kind]}</div>

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

      {/* 两端都留空 = 常驻；路线与区域用数值年（负数 = 公元前） */}
      <Labeled label="出现于">
        <YearInput value={item.from} onChange={(v) => patch({ from: v })} />
      </Labeled>
      <Labeled label="消失于">
        <YearInput value={item.to} onChange={(v) => patch({ to: v })} placeholder="至今" />
      </Labeled>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn" onClick={() => flyToItem(kind, item)}>定位</button>
        <button
          className="btn btn-danger"
          onClick={() => { if (confirm('确认删除？')) deleteItem(kind, id); }}
        >
          删除
        </button>
      </div>

      <BackToOverview />
    </div>
  );
}
