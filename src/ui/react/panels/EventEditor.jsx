import { useState } from 'react';
import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { useProjectRevision } from '../hooks.js';
import {
  Labeled, BackToOverview, TimeInput, CoordInput, CharacterPicker, GroupPicker, ItemImage,
} from '../common.jsx';

/**
 * 事件的查看与编辑。
 *
 * 所有字段先写进本地草稿，按「保存」才回写到项目：事件的标题、时间、坐标一变，
 * 时间轴、编年史与球面都会跟着重排，边打字边提交会让这些地方每敲一个字抖一次。
 * 「取消」把草稿恢复成项目里的样子，什么都没动过。
 */

/** 从项目里的那条事件取一份草稿；章节归属不在事件上，得反查各章的 eventIds */
function makeDraft(project, item) {
  return {
    title: item.title,
    description: item.description || '',
    image: item.image,
    characters: [...(item.characters ?? [])],
    groupIds: project.groups
      .filter((g) => g.eventIds?.includes(item.id))
      .map((g) => g.id),
    lat: item.lat,
    lng: item.lng,
    from: item.from,
    to: item.to,
  };
}

export function EventEditor({ id }) {
  const project = useStore((s) => s.project);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const flyToItem = useStore((s) => s.flyToItem);
  const pickImage = useStore((s) => s.pickImage);
  const toast = useStore((s) => s.toast);
  const select = useStore((s) => s.select);
  useProjectRevision(); // 别的面板改了人物或章节，这里的候选要跟着更新

  const item = (project?.events ?? []).find((ev) => ev.id === id);
  const [draft, setDraft] = useState(() => (item ? makeDraft(project, item) : null));
  if (!item || !draft) return null;

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  // 保存与取消都回事件清单：这两张卡只是清单里的一条，处理完该回到列表继续翻
  const save = () => {
    updateItem('event', id, { ...draft });
    toast('事件已保存');
    select({ kind: 'events' });
  };

  const reset = () => select({ kind: 'events' });
  const hasCoords = draft.lat != null && draft.lng != null;

  return (
    <div className="insp-block">
      <div className="insp-title">事件</div>

      <div className="field-label">配图（长宽比建议1:1）</div>
      {draft.image ? (
        <div style={{ display: 'grid', gap: '6px' }}>
          <ItemImage src={draft.image} />
          <button className="btn" onClick={() => patch({ image: null })}>移除配图</button>
        </div>
      ) : (
        <button
          className="btn"
          onClick={async () => {
            const file = await pickImage();
            if (file) patch({ image: await fileToDataUrl(file) });
          }}
        >
          ⬆ 上传配图
        </button>
      )}

      <Labeled label="标题">
        <input
          className="inp"
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
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

      {/* 关联只写在这一侧：人物的反向清单由它现算，人物卡上不存副本 */}
      <Labeled label="涉及人物">
        <CharacterPicker
          ids={draft.characters}
          onChange={(ids) => patch({ characters: ids })}
        />
      </Labeled>

      <Labeled label="所属章节">
        <GroupPicker
          ids={draft.groupIds}
          onChange={(ids) => patch({ groupIds: ids })}
        />
      </Labeled>

      <div style={{ display: 'grid', gap: '4px' }}>
        <span className="field-label">坐标</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <CoordInput
            id="event-lat"
            value={draft.lat}
            min={-90}
            max={90}
            placeholder="纬度"
            onChange={(lat) => patch({ lat })}
          />
          <CoordInput
            id="event-lng"
            value={draft.lng}
            min={-180}
            max={180}
            placeholder="经度"
            onChange={(lng) => patch({ lng })}
          />
        </div>
        <span className="insp-hint">
          {hasCoords
            ? '可直接改上面的经纬度。'
            : '两项都填才会落在球上；都留空就是纯叙事事件。'}
        </span>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {hasCoords && (
            <button className="btn btn-mini" onClick={() => flyToItem('event', draft)}>飞到</button>
          )}
          {(draft.lat != null || draft.lng != null) && (
            <button className="btn btn-mini" onClick={() => patch({ lat: null, lng: null })}>
              清除位置（改为纯叙事）
            </button>
          )}
        </div>
      </div>

      <Labeled label="出现于">
        <TimeInput value={draft.from} onChange={(v) => patch({ from: v })} />
      </Labeled>
      <Labeled label="消失于">
        <TimeInput value={draft.to} onChange={(v) => patch({ to: v })} placeholder="至今" />
      </Labeled>
      <p className="insp-hint">
        时间可只写到年、月、日、时、分、秒；日期与小时之间用 T。空格后的内容作为备注，不参与排序。时间轴仍按年划分。
      </p>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn btn-primary" onClick={save}>保存</button>
        <button className="btn" onClick={reset} title="放弃未保存的修改">取消</button>
        <button
          className="btn btn-danger"
          onClick={() => { if (confirm('确认删除？')) deleteItem('event', id); }}
        >
          删除
        </button>
      </div>

      <BackToOverview />
    </div>
  );
}
