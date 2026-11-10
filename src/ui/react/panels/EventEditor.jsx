import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { useProjectRevision } from '../hooks.js';
import {
  Labeled, AutoTextarea, BackToOverview, TimeInput, CoordInput, CharacterPicker, GroupPicker, ItemImage,
} from '../common.jsx';

/**
 * 事件的查看与编辑。
 *
 * 所有字段先写进本地草稿，按「保存」才回写到项目：事件的标题、时间、坐标一变，
 * 时间轴、编年史与球面都会跟着重排，边打字边提交会让这些地方每敲一个字抖一次。
 * 「取消」把草稿恢复成项目里的样子，什么都没动过。
 *
 * 描述写得长的详情页，右栏要滚很久才看得到人物与时间。所以「涉及人物」往后的
 * 尾部字段同时投到左侧固定栏（#inspector-left）：左右是同一份草稿的两处入口，
 * 内容允许重合，在哪边改都同步。草稿是本组件的 state，两栏必须同属一棵 React
 * 树才能共享它，因此用 portal 投过去，而不是给左边单独挂一个面板根。
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

/**
 * 涉及人物 + 所属章节。右栏与左侧固定栏各渲染一份，绑的是同一份草稿。
 * 必须留在模块层：定义进 EventEditor 的话每次输入都会换新函数类型，
 * CharacterPicker 里的搜索词会被连着重置。
 */
function RelationFields({ draft, patch }) {
  return (
    <>
      {/* 关联只写在这一侧：人物的反向清单由它现算，人物卡上不存副本。
          picker 里有一排 tag button，不能包在 <label> 里（见 Labeled 注释） */}
      <Labeled as="div" label="涉及人物">
        <CharacterPicker
          ids={draft.characters}
          onChange={(ids) => patch({ characters: ids })}
        />
      </Labeled>

      <Labeled as="div" label="所属章节">
        <GroupPicker
          ids={draft.groupIds}
          onChange={(ids) => patch({ groupIds: ids })}
        />
      </Labeled>
    </>
  );
}

/**
 * 坐标 + 存续区间：与 RelationFields 同样在两栏各渲染一份。
 * latId/lngId 是留给外部脚本的输入框钩子，只有右栏传——两个栏各渲染一份时
 * 不能带出重复的 DOM id。
 */
function SpaceTimeFields({ draft, patch, flyToItem, latId, lngId }) {
  const hasCoords = draft.lat != null && draft.lng != null;
  return (
    <>
      <div style={{ display: 'grid', gap: '4px' }}>
        <span className="field-label">坐标</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <CoordInput
            id={latId}
            value={draft.lat}
            min={-90}
            max={90}
            placeholder="纬度"
            onChange={(lat) => patch({ lat })}
          />
          <CoordInput
            id={lngId}
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
            <button className="btn btn-mini" onClick={() => flyToItem('event', draft)}>Go</button>
          )}
          {(draft.lat != null || draft.lng != null) && (
            <button className="btn btn-mini" onClick={() => patch({ lat: null, lng: null })}>
              经纬度置为空
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
        时间格式yyyy-MM-ddThh:mm:ss，时间后可以以空格分隔添加注释
      </p>
    </>
  );
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
  // 图片解码结束前可能已经切到另一条事件；迟到的结果只属于打开它的那一张卡
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  if (!item || !draft) return null;

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  // 保存与取消都回事件清单：这两张卡只是清单里的一条，处理完该回到列表继续翻
  const save = () => {
    updateItem('event', id, { ...draft });
    toast('事件已保存');
    select({ kind: 'events' });
  };

  const reset = () => select({ kind: 'events' });

  // 左侧固定栏的容器是 index.html 里的常驻空壳；portal 卸载后它空了，CSS 的
  // :empty 规则会把整块隐掉。文件加载后容器就在，查不到只可能是改了页面结构。
  const leftEl = document.getElementById('inspector-left');

  return (
    <>
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
            if (!file || !alive.current) return;
            const image = await fileToDataUrl(file);
            if (alive.current) patch({ image });
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
        <AutoTextarea
          rows={4}
          placeholder="补充这个内容的设定…"
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Labeled>

      {/* 关联与时空两段同时出现在左栏（见文件头注释），字段组抽成组件复用 */}
      <RelationFields draft={draft} patch={patch} />

      <SpaceTimeFields draft={draft} patch={patch} flyToItem={flyToItem} latId="event-lat" lngId="event-lng" />

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn btn-primary" onClick={save}>✔ 保存</button>
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

    {/* 左侧固定栏：固定展示尾部字段（人物/章节/坐标/时间），不做任何动态判断——
        事件详情开着它就在。与右栏允许重合，改哪边都写进同一份草稿 */}
    {leftEl && createPortal(
      <div className="insp-block">
        <div className="insp-title">内容关联</div>
        <RelationFields draft={draft} patch={patch} />
        <SpaceTimeFields draft={draft} patch={patch} flyToItem={flyToItem} />
      </div>,
      leftEl,
    )}
    </>
  );
}
