import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled, BackToOverview, YearInput, DateTimeInput, CharacterPicker, GroupPicker } from '../common.jsx';

const TITLES = { event: '事件', route: '路线', region: '势力区域' };

/** 有配图的内容 */
const HAS_IMAGE = new Set(['event']);

/** 拿经纬度定位的内容：事件的坐标可以缺省，缺省就是纯叙事事件 */
const HAS_LATLNG = new Set(['event']);

/**
 * 事件 / 路线 / 区域的查看与编辑。
 * 调用方用 key={kind:id} 挂载，切换选中对象即重挂载，各字段自然取到新对象的值。
 */
export function ItemEditor({ kind, id }) {
  const project = useStore((s) => s.project);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const flyToItem = useStore((s) => s.flyToItem);
  const pickImage = useStore((s) => s.pickImage);

  const list = {
    event: project.events, route: project.routes, region: project.regions,
  }[kind];
  const item = list?.find((it) => it.id === id);
  if (!item) return null;

  const patch = (p) => updateItem(kind, id, p);

  return (
    <div className="insp-block">
      <div className="insp-title">{TITLES[kind]}</div>

      {HAS_IMAGE.has(kind) && (
        <>
          <div className="field-label">配图</div>
          {item.image ? (
            <div style={{ display: 'grid', gap: '6px' }}>
              <img className="item-img" src={item.image} alt="" />
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

      {/* 关联只写在这一侧：人物的反向清单由它现算，人物卡上不存副本 */}
      {kind === 'event' && (
        <Labeled label="涉及人物">
          <CharacterPicker
            ids={item.characters ?? []}
            onChange={(ids) => patch({ characters: ids })}
          />
        </Labeled>
      )}

      {kind === 'event' && (
        <Labeled label="所属章节">
          <GroupPicker
            ids={(project.groups ?? [])
              .filter((g) => g.eventIds?.includes(item.id))
              .map((g) => g.id)}
            onChange={(ids) => patch({ groupIds: ids })}
          />
        </Labeled>
      )}

      {HAS_LATLNG.has(kind) && (
        <Labeled label="坐标">
          {item.lat == null || item.lng == null ? (
            <span className="insp-hint">没有坐标：不上球，只进编年史</span>
          ) : (
            <span>
              <span className="insp-hint">{`${item.lat.toFixed(2)}°, ${item.lng.toFixed(2)}° `}</span>
              <button className="btn btn-mini" onClick={() => flyToItem(kind, item)}>飞到</button>
            </span>
          )}
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

      {/* 两端都留空 = 常驻。事件用完整日期时间，路线与区域仍用数值年（负数 = 公元前） */}
      {kind === 'event' ? (
        <>
          <Labeled label="出现于">
            <DateTimeInput value={item.from} onChange={(v) => patch({ from: v })} />
          </Labeled>
          <Labeled label="消失于">
            <DateTimeInput value={item.to} onChange={(v) => patch({ to: v })} placeholder="至今" />
          </Labeled>
          <p className="insp-hint">时间记录到秒；时间轴仍按年划分。</p>
        </>
      ) : (
        <>
          <Labeled label="出现于">
            <YearInput value={item.from} onChange={(v) => patch({ from: v })} />
          </Labeled>
          <Labeled label="消失于">
            <YearInput value={item.to} onChange={(v) => patch({ to: v })} placeholder="至今" />
          </Labeled>
        </>
      )}
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
