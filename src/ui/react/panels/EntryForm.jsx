import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled, TimeSelect } from '../common.jsx';

/**
 * 放置条目的表单。草稿存在 store 的 entryDraft 里：在球面上反复单击调整位置时，
 * 表单会因坐标变化而重渲染，但已填的标题/描述/配图不会丢。
 */
export function EntryForm() {
  const project = useStore((s) => s.project);
  const draft = useStore((s) => s.entryDraft);
  const pendingCoords = useStore((s) => s.pendingCoords);
  const saveDraft = useStore((s) => s.saveDraft);
  const commitEntry = useStore((s) => s.commitEntry);
  const setMode = useStore((s) => s.setMode);
  const pickImage = useStore((s) => s.pickImage);

  const hasTp = project.timePoints.length > 0;

  return (
    <div className="insp-block">
      <div className="insp-title">📍 放置条目</div>

      {hasTp ? (
        <p className="insp-hint" id="entry-coords">
          {`位置：${pendingCoords
            ? `${pendingCoords.lat.toFixed(2)}°, ${pendingCoords.lng.toFixed(2)}°`
            : '单击球面选择位置'}（重新单击可调整）`}
        </p>
      ) : (
        <p className="insp-hint">请先在底部时间轴添加一个时间点。</p>
      )}

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

      {hasTp && (
        <Labeled label="出现于">
          <TimeSelect value={draft.from} onChange={(v) => saveDraft({ from: v })} nullLabel="当前时间点" />
        </Labeled>
      )}
      {hasTp && (
        <Labeled label="消失于">
          <TimeSelect value={draft.to} onChange={(v) => saveDraft({ to: v })} nullLabel="至今" />
        </Labeled>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button
          className="btn btn-primary"
          disabled={!hasTp || !pendingCoords}
          onClick={() => commitEntry()}
        >
          ✔ 创建
        </button>
        <button className="btn" onClick={() => setMode('browse')}>取消</button>
      </div>
    </div>
  );
}
