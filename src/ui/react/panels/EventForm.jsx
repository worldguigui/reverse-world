import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled, YearInput, CharacterPicker, GroupPicker } from '../common.jsx';
import { formatYear } from '../../../core/timeline.js';

/**
 * 放置表单：在球面上点一个坐标，再把它变成一条事件。
 * 草稿存在 store 的 eventDraft 里：在球面上反复单击调整位置时，表单会因坐标变化而
 * 重渲染，但已填的标题/描述/配图不会丢。
 *
 * 坐标是可选的——不点球面也能创建，那样得到的是一条纯叙事事件：不上球，只进编年史。
 * 「涉及人物」写进草稿，创建时一并落到事件上。
 */
export function EventForm() {
  const draft = useStore((s) => s.eventDraft);
  const cursor = useStore((s) => s.cursor);
  const pendingCoords = useStore((s) => s.pendingCoords);
  const saveDraft = useStore((s) => s.saveDraft);
  const commitEvent = useStore((s) => s.commitEvent);
  const setMode = useStore((s) => s.setMode);
  const pickImage = useStore((s) => s.pickImage);

  return (
    <div className="insp-block">
      <div className="insp-title">放置事件</div>

      <p className="insp-hint" id="event-coords">
        {pendingCoords
          ? `位置：${pendingCoords.lat.toFixed(2)}°, ${pendingCoords.lng.toFixed(2)}°（重新单击可调整）`
          : '坐标可选：单击球面给它一个坐标；不点就是纯叙事事件，不上球、只进编年史。'}
      </p>

      <Labeled label="标题">
        <input
          className="inp"
          defaultValue={draft.title ?? ''}
          onChange={(e) => saveDraft({ title: e.target.value })}
        />
      </Labeled>

      <Labeled label="描述">
        <textarea
          className="inp"
          rows={3}
          defaultValue={draft.description || ''}
          onChange={(e) => saveDraft({ description: e.target.value })}
        />
      </Labeled>

      <button
        className="btn"
        id="event-image-btn"
        onClick={async () => {
          const file = await pickImage();
          if (file) saveDraft({ image: await fileToDataUrl(file, 1024) });
        }}
      >
        {draft.image ? '已选配图 ✓（再点可更换）' : '⬆ 配图（可选）'}
      </button>

      {/* 编一条事件时本来就在写「谁参与了」，顺手勾上 */}
      <Labeled label="涉及人物">
        <CharacterPicker
          ids={draft.characters ?? []}
          onChange={(ids) => saveDraft({ characters: ids })}
        />
      </Labeled>

      <Labeled label="所属章节">
        <GroupPicker
          ids={draft.groupIds ?? []}
          onChange={(ids) => saveDraft({ groupIds: ids })}
        />
      </Labeled>

      {/* 两端都留空 = 常驻。不填出现于时会认下当前游标所在的年份 */}
      <Labeled label="出现于">
        <YearInput
          value={draft.from}
          onChange={(v) => saveDraft({ from: v })}
          placeholder={`当前游标（${formatYear(cursor)}）`}
        />
      </Labeled>
      <Labeled label="消失于">
        <YearInput value={draft.to} onChange={(v) => saveDraft({ to: v })} placeholder="至今" />
      </Labeled>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn btn-primary" onClick={() => commitEvent()}>✔ 创建</button>
        <button className="btn" onClick={() => setMode('browse')}>取消</button>
      </div>
    </div>
  );
}
