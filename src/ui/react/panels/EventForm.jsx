import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled, DateTimeInput, CharacterPicker, GroupPicker } from '../common.jsx';
import { roundYear } from '../../../core/timeline.js';
import { yearToDateTime } from '../../../core/datetime.js';

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
  const setPendingCoords = useStore((s) => s.setPendingCoords);
  const pickImage = useStore((s) => s.pickImage);

  return (
    <div className="insp-block">
      <div className="insp-title">放置事件</div>

      <p className="insp-hint" id="event-coords">
        {pendingCoords
          ? `位置：${pendingCoords.lat.toFixed(2)}°, ${pendingCoords.lng.toFixed(2)}°（可直接改下面的经纬度，或继续单击球面重新选点）`
          : '坐标可选：单击球面给它一个坐标；不点就是纯叙事事件，不上球、只进编年史。'}
      </p>

      <Labeled label="标题">
        <input
          id="event-title"
          className="inp"
          defaultValue={draft.title ?? ''}
          onChange={(e) => saveDraft({ title: e.target.value })}
        />
      </Labeled>

      {pendingCoords && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <Labeled label="纬度">
              <CoordInput
                id="event-lat"
                value={pendingCoords.lat}
                min={-90}
                max={90}
                onChange={(lat) => setPendingCoords({ ...pendingCoords, lat })}
              />
            </Labeled>
            <Labeled label="经度">
              <CoordInput
                id="event-lng"
                value={pendingCoords.lng}
                min={-180}
                max={180}
                onChange={(lng) => setPendingCoords({ ...pendingCoords, lng })}
              />
            </Labeled>
          </div>
          <button
            className="btn btn-mini"
            type="button"
            onClick={() => setPendingCoords(null)}
          >
            清除位置（改为纯叙事）
          </button>
        </>
      )}

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

      {/* 两端都留空 = 常驻。不填出现于时会认下当前游标所在的年份，时间补成 1 月 1 日零点 */}
      <Labeled label="出现于">
        <DateTimeInput
          value={draft.from}
          onChange={(v) => saveDraft({ from: v })}
          placeholder={`默认 ${yearToDateTime(roundYear(cursor))}`}
        />
      </Labeled>
      <Labeled label="消失于">
        <DateTimeInput value={draft.to} onChange={(v) => saveDraft({ to: v })} placeholder="至今" />
      </Labeled>
      <p className="insp-hint">时间记录到秒；时间轴仍按年划分。</p>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn btn-primary" onClick={() => commitEvent()}>✔ 创建</button>
        <button className="btn" onClick={() => setMode('browse')}>取消</button>
      </div>
    </div>
  );
}

/**
 * 经纬度输入：失焦或回车提交，并夹到合法区间。
 * 用 value 做 key 是为了让球面重新选点或提交后的规范值能立刻回显——
 * 输入框在编辑过程中保持非受控，不会每敲一个字符就回写 store。
 */
function CoordInput({ id, value, min, max, onChange }) {
  const shown = typeof value === 'number' ? value.toFixed(4) : '';
  const commit = (raw, input) => {
    const text = raw.trim();
    const n = Number(text);
    if (!text || !Number.isFinite(n)) {
      input.value = shown;
      return;
    }
    onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <input
      id={id}
      key={shown}
      className="inp"
      type="text"
      inputMode="decimal"
      defaultValue={shown}
      onBlur={(e) => commit(e.target.value, e.target)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
    />
  );
}
