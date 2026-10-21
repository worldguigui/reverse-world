import { useState } from 'react';
import { useStore } from '../../../store/index.js';
import { Labeled, BackToOverview, YearInput } from '../common.jsx';

const TITLES = { route: '路线', region: '势力区域' };

/** 从项目里那条路线 / 区域取一份草稿；区域的名称字段是 name，路线是 title */
function makeDraft(kind, item) {
  return {
    name: kind === 'region' ? item.name : item.title,
    description: item.description || '',
    from: item.from,
    to: item.to,
  };
}

/**
 * 路线 / 区域的查看与编辑。
 *
 * 与事件、人物一样先写本地草稿，按「保存」才回写项目；「取消」直接回概览，
 * 草稿随面板卸载一起丢掉。保存与取消之后都回概览——这两类内容没有自己的清单页，
 * 概览就是它们的上一级。
 *
 * 调用方用 key={kind:id} 挂载，切换选中对象即重挂载，草稿自然取到新对象的值。
 */
export function ItemEditor({ kind, id }) {
  const project = useStore((s) => s.project);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const flyToItem = useStore((s) => s.flyToItem);
  const select = useStore((s) => s.select);
  const toast = useStore((s) => s.toast);

  const list = { route: project.routes, region: project.regions }[kind];
  const item = list?.find((it) => it.id === id);
  const [draft, setDraft] = useState(() => (item ? makeDraft(kind, item) : null));
  if (!item || !draft) return null;

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  const save = () => {
    const nameField = kind === 'region' ? { name: draft.name } : { title: draft.name };
    updateItem(kind, id, {
      ...nameField,
      description: draft.description,
      from: draft.from,
      to: draft.to,
    });
    toast(`${TITLES[kind]}已保存`);
    select(null);
  };

  return (
    <div className="insp-block">
      <div className="insp-title">{TITLES[kind]}</div>

      <Labeled label={kind === 'region' ? '名称' : '标题'}>
        <input
          className="inp"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Labeled>

      <Labeled label="描述">
        <textarea
          className="inp"
          rows={4}
          placeholder="补充这个内容的设定…"
          value={draft.description}
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
        <YearInput value={draft.from} onChange={(v) => patch({ from: v })} />
      </Labeled>
      <Labeled label="消失于">
        <YearInput value={draft.to} onChange={(v) => patch({ to: v })} placeholder="至今" />
      </Labeled>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn" onClick={() => flyToItem(kind, item)}>定位</button>
        <button className="btn btn-primary" onClick={save}>保存</button>
        <button className="btn" onClick={() => select(null)} title="放弃未保存的修改">取消</button>
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
