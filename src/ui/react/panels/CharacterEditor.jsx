import { useState } from 'react';
import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { formatTime } from '../../../core/datetime.js';
import { useProjectRevision } from '../hooks.js';
import { Labeled, BackToOverview, TimeInput, ItemImage, searchCharacters } from '../common.jsx';

/**
 * 人物的两张面板：清单与卡片。
 *
 * 人物不上球——球上演的是「哪一年发生了什么」，而人是事件的参与者，不是地点上的东西。
 * 所以这里没有坐标、没有存续区间，录入整张卡都在面板里完成。
 */

/** 生卒的紧凑写法：只呈现写过的精度，缺一端写问号；两端都没有就整个不写 */
function lifeDates(c) {
  if (c.born == null && c.died == null) return '';
  const b = c.born == null ? '?' : formatTime(c.born);
  const d = c.died == null ? '?' : formatTime(c.died);
  return `${b}–${d}`;
}

/** 别名随手用顿号、逗号或空格分开都认，存的时候统一成数组 */
const parseAliases = (raw) => raw.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);

/** 人物没设颜色时，取色器先停在这个默认暗金上；与标签的默认配色一致 */
const DEFAULT_COLOR = '#d0a15b';

/**
 * 人物卡的草稿。别名在草稿里仍是输入框里的那串原文，保存时才拆成数组——
 * 边打边拆会把「、」后面的半截字也当成一个别名。
 */
function makeDraft(item) {
  return {
    name: item.name,
    aliases: item.aliases.join('、'),
    born: item.born,
    died: item.died,
    description: item.description || '',
    image: item.image,
    color: item.color,
  };
}

/**
 * 人物清单：顶栏「人物」入口落到这里。
 * 数组顺序就是录入先后，不另排序——先录的人排在前面，添人是往后接。
 */
export function CharacterList() {
  const project = useStore((s) => s.project);
  const select = useStore((s) => s.select);
  const addCharacter = useStore((s) => s.addCharacter);
  useProjectRevision(); // 改了名字或生卒，这一排要跟着重排

  const characters = project?.characters ?? [];
  // 清单页的搜索框：空的就照原顺序列全部；敲了字走与人名下拉同一套名字/别名检索
  const [query, setQuery] = useState('');
  const shown = query.trim() ? searchCharacters(characters, query) : characters;

  return (
    <div className="insp-block insp-list-page">
      <div className="insp-title">人物</div>

      {characters.length === 0 ? (
        <p className="insp-hint">
          还没有人物。录进来之后，事件的详情里就能勾上「谁参与了这件事」。
        </p>
      ) : (
        <>
          <input
            className="inp"
            type="text"
            value={query}
            placeholder="搜索人物（名字或别名）"
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className="insp-hint">没有匹配的人物。</p>
          ) : (
            <div className="char-list">
              {shown.map((c) => (
                <button
                  key={c.id}
                  className="char-row"
                  onClick={() => select({ kind: 'character', id: c.id })}
                >
                  <b>{c.name}</b>
                  <span>{lifeDates(c) || '生平不详'}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <button className="btn btn-primary" id="char-new" onClick={() => addCharacter()}>
        ＋ 新建人物
      </button>
      <BackToOverview />
    </div>
  );
}

/**
 * 人物卡：名字 / 别名 / 生卒 / 小传 / 配图，加上它涉及的事件。
 *
 * 那张事件清单是**算出来的**——人物的关联只存在事件那一侧，这里线性扫一遍取反。
 * 所以卡片上不提供「添加事件」，要挂就去那条事件的详情里勾；一条事件只在一个地方写。
 */
export function CharacterEditor({ id }) {
  const project = useStore((s) => s.project);
  const updateItem = useStore((s) => s.updateItem);
  const deleteItem = useStore((s) => s.deleteItem);
  const select = useStore((s) => s.select);
  const pickImage = useStore((s) => s.pickImage);
  const eventsOfCharacter = useStore((s) => s.eventsOfCharacter);
  const toast = useStore((s) => s.toast);
  useProjectRevision(); // 事件改了标题或年份，下面那张清单要跟着变

  const item = (project?.characters ?? []).find((c) => c.id === id);
  const [draft, setDraft] = useState(() => (item ? makeDraft(item) : null));
  if (!item || !draft) return null;

  // 名字、生卒、配图都先落在草稿里，按「保存」才回写项目
  const patch = (p) => setDraft((d) => ({ ...d, ...p }));
  // 保存与取消都回人物清单：这张卡只是清单里的一条，处理完该回到列表继续翻
  const save = () => {
    updateItem('character', id, { ...draft, aliases: parseAliases(draft.aliases) });
    toast('人物已保存');
    select({ kind: 'characters' });
  };
  const reset = () => select({ kind: 'characters' });

  const events = eventsOfCharacter(id);

  return (
    <div className="insp-block">
      <div className="insp-title">人物</div>

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

      <Labeled label="姓名">
        <input
          className="inp"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Labeled>

      {/* 别名要认「海军上将」这种称号——搜索时输入的可能不是正名 */}
      <Labeled label="别名 / 称号">
        <input
          className="inp"
          placeholder="用顿号或逗号分开"
          value={draft.aliases}
          onChange={(e) => patch({ aliases: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        />
      </Labeled>

      <Labeled label="出生日期">
        <TimeInput value={draft.born} onChange={(v) => patch({ born: v })} placeholder="不详" />
      </Labeled>
      <Labeled label="逝世日期">
        <TimeInput value={draft.died} onChange={(v) => patch({ died: v })} placeholder="不详" />
      </Labeled>
      <p className="insp-hint">
        时间可只写到年、月、日、时、分、秒；空格后的内容作为备注，例如「1919-11-11 待定时间」。
      </p>

      <Labeled label="小传">
        <textarea
          className="inp"
          rows={4}
          placeholder="这个人是谁…"
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Labeled>

      {/* 不能包在 <label> 里：点标签或标签留白会再次激活取色器，
          原生选色框刚关就被重新打开，看起来像关不掉。这里只让色块本身打开它。 */}
      <div style={{ display: 'grid', gap: '4px' }}>
        <span className="field-label">颜色</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="color"
            value={draft.color ?? DEFAULT_COLOR}
            title={draft.color ? '选择人物颜色' : '未设颜色，点开可指定'}
            onChange={(e) => patch({ color: e.target.value })}
          />
          {draft.color ? (
            <button className="btn btn-mini" onClick={() => patch({ color: null })}>
              使用默认配色
            </button>
          ) : (
            <span className="insp-hint" style={{ margin: 0 }}>未设置，跟随默认配色</span>
          )}
        </div>
      </div>

      <Labeled label="涉及的事件">
        {events.length === 0 ? (
          <span className="insp-hint">还没有事件提到他。在事件详情里勾一下「涉及人物」。</span>
        ) : (
          <div className="char-list">
            {events.map((ev) => (
              <button
                key={ev.id}
                className="char-row"
                title="跳到这条事件"
                onClick={() => select({ kind: 'event', id: ev.id })}
              >
                <b>{ev.from == null ? '未定年' : formatTime(ev.from)}</b>
                <span>{ev.title}</span>
              </button>
            ))}
          </div>
        )}
      </Labeled>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button className="btn btn-primary" onClick={save}>保存</button>
        <button className="btn" onClick={reset} title="放弃未保存的修改">取消</button>
        <button
          className="btn btn-danger"
          onClick={() => { if (confirm('确认删除？事件里对他的引用会一并摘掉。')) deleteItem('character', id); }}
        >
          删除
        </button>
      </div>

      <button
        className="btn btn-ghost"
        style={{ marginTop: '10px' }}
        onClick={() => select({ kind: 'characters' })}
      >
        ← 人物
      </button>
    </div>
  );
}
