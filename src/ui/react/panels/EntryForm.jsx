import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled, YearInput, CharacterPicker, GroupSelect } from '../common.jsx';
import { formatYear } from '../../../core/timeline.js';

/**
 * 放置表单：在球面上点一个位置，再把它变成一个地点或一个事件。
 * 草稿存在 store 的 entryDraft 里：在球面上反复单击调整位置时，表单会因坐标变化而
 * 重渲染，但已填的标题/描述/配图不会丢。
 *
 * 事件比地点多出一种可能——它本来就可以没有地点。所以不点球面也能创建，
 * 那样得到的是一条纯叙事事件：不上球，只进编年史。
 *
 * 事件还多一项「涉及人物」：勾选写进草稿，创建时一并落到事件上。
 */
export function EntryForm({ kind = 'entry' }) {
  const draft = useStore((s) => s.entryDraft);
  const cursor = useStore((s) => s.cursor);
  const pendingCoords = useStore((s) => s.pendingCoords);
  const saveDraft = useStore((s) => s.saveDraft);
  const commitEntry = useStore((s) => s.commitEntry);
  const commitEvent = useStore((s) => s.commitEvent);
  const setMode = useStore((s) => s.setMode);
  const pickImage = useStore((s) => s.pickImage);

  const isEvent = kind === 'event';
  // 地点必须有坐标；事件可以不点球面，那就落成一条纯叙事事件
  const canCommit = isEvent || !!pendingCoords;

  return (
    <div className="insp-block">
      <div className="insp-title">{isEvent ? '⚡ 放置事件' : '📍 放置地点'}</div>

      <p className="insp-hint" id="entry-coords">
        {pendingCoords
          ? `位置：${pendingCoords.lat.toFixed(2)}°, ${pendingCoords.lng.toFixed(2)}°（重新单击可调整）`
          : isEvent
            ? '地点可选：单击球面给它一个坐标；不点就是纯叙事事件，不上球、只进编年史。'
            : '单击球面选择位置（重新单击可调整）'}
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
        id="entry-image-btn"
        onClick={async () => {
          const file = await pickImage();
          if (file) saveDraft({ image: await fileToDataUrl(file, 1024) });
        }}
      >
        {draft.image ? '已选配图 ✓（再点可更换）' : '⬆ 配图（可选）'}
      </button>

      {/* 编一条事件时本来就在写「谁参与了」，顺手勾上；地点没有这个字段 */}
      {isEvent && (
        <Labeled label="涉及人物">
          <CharacterPicker
            ids={draft.characters ?? []}
            onChange={(ids) => saveDraft({ characters: ids })}
          />
        </Labeled>
      )}

      {isEvent && (
        <Labeled label="所属章节">
          <GroupSelect value={draft.groupId ?? null} onChange={(id) => saveDraft({ groupId: id })} />
        </Labeled>
      )}

      {/* 两端都留空 = 常驻。事件不填出现于时会认下当前游标所在的年份 */}
      <Labeled label="出现于">
        <YearInput
          value={draft.from}
          onChange={(v) => saveDraft({ from: v })}
          placeholder={isEvent ? `当前游标（${formatYear(cursor)}）` : '自始'}
        />
      </Labeled>
      <Labeled label="消失于">
        <YearInput value={draft.to} onChange={(v) => saveDraft({ to: v })} placeholder="至今" />
      </Labeled>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button
          className="btn btn-primary"
          disabled={!canCommit}
          onClick={() => (isEvent ? commitEvent() : commitEntry())}
        >
          ✔ 创建
        </button>
        <button className="btn" onClick={() => setMode('browse')}>取消</button>
      </div>
    </div>
  );
}
