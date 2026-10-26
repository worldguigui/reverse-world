import { useEffect, useRef } from 'react';
import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { Labeled, TimeInput, CoordInput, CharacterPicker, GroupPicker, ItemImage } from '../common.jsx';

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
  const pendingCoords = useStore((s) => s.pendingCoords);
  const saveDraft = useStore((s) => s.saveDraft);
  const commitEvent = useStore((s) => s.commitEvent);
  const setMode = useStore((s) => s.setMode);
  const setPendingCoords = useStore((s) => s.setPendingCoords);
  const pickImage = useStore((s) => s.pickImage);

  // 读图要等文件解码；读到一半切走表单时，结果不能再写回（否则会串到下一条草稿里）
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  return (
    <div className="insp-block">
      <div className="insp-title">放置事件</div>

      <p className="insp-hint" id="event-coords">
        {pendingCoords
          ? `位置：${pendingCoords.lat.toFixed(2)}°, ${pendingCoords.lng.toFixed(2)}°（经纬度可以直接修改，或继续单击球面重新选点）`
          : '单击球面选定具体位置'}
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
            经纬度置为空
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
          if (!file || !alive.current) return;
          const image = await fileToDataUrl(file);
          if (alive.current) saveDraft({ image });
        }}
      >
        {draft.image ? '已选配图（再点可更换）' : '配图（长宽比建议1:1）'}
      </button>
      {draft.image && (
        <div style={{ display: 'grid', gap: '6px' }}>
          <ItemImage src={draft.image} />
          <button className="btn" onClick={() => saveDraft({ image: null })}>移除配图</button>
        </div>
      )}

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

      {/* 两端都留空 = 常驻；只留空出现于 = 自始就存在 */}
      <Labeled label="出现于">
        <TimeInput
          value={draft.from}
          onChange={(v) => saveDraft({ from: v })}
          placeholder="自始"
        />
      </Labeled>
      <Labeled label="消失于">
        <TimeInput value={draft.to} onChange={(v) => saveDraft({ to: v })} placeholder="至今" />
      </Labeled>
      <p className="insp-hint">
        时间格式yyyy-MM-ddThh:mm:ss，时间后可以以空格分隔添加注释
      </p>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn btn-primary" onClick={() => commitEvent()}>✔ 创建</button>
        <button className="btn" onClick={() => setMode('browse')}>取消</button>
      </div>
    </div>
  );
}
