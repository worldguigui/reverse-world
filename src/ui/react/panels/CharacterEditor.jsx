import { useStore } from '../../../store/index.js';
import { fileToDataUrl } from '../../../utils/files.js';
import { formatYear } from '../../../core/timeline.js';
import { useProjectRevision } from '../hooks.js';
import { Labeled, BackToOverview, YearInput } from '../common.jsx';

/**
 * 人物的两张面板：清单与卡片。
 *
 * 人物不上球——球上演的是「哪一年发生了什么」，而人是事件的参与者，不是地点上的东西。
 * 所以这里没有坐标、没有存续区间，录入整张卡都在面板里完成。
 */

/** 生卒的紧凑写法：两端都有是「1451–1506」，缺一端写问号；两端都没有就整个不写 */
function lifeYears(c) {
  if (c.born == null && c.died == null) return '';
  const b = c.born == null ? '?' : formatYear(c.born);
  const d = c.died == null ? '?' : formatYear(c.died);
  return `${b}–${d}`;
}

/** 别名随手用顿号、逗号或空格分开都认，存的时候统一成数组 */
const parseAliases = (raw) => raw.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);

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

  return (
    <div className="insp-block">
      <div className="insp-title">🧝 人物</div>

      {characters.length === 0 ? (
        <p className="insp-hint">
          还没有人物。录进来之后，事件的详情里就能勾上「谁参与了这件事」。
        </p>
      ) : (
        <div className="char-list">
          {characters.map((c) => (
            <button
              key={c.id}
              className="char-row"
              onClick={() => select({ kind: 'character', id: c.id })}
            >
              <b>{c.name}</b>
              <span>{lifeYears(c) || '生平不详'}</span>
            </button>
          ))}
        </div>
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
  useProjectRevision(); // 事件改了标题或年份，下面那张清单要跟着变

  const item = (project?.characters ?? []).find((c) => c.id === id);
  if (!item) return null;

  const patch = (p) => updateItem('character', id, p);
  const events = eventsOfCharacter(id);

  return (
    <div className="insp-block">
      <div className="insp-title">🧝 人物</div>

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

      <Labeled label="姓名">
        <input
          className="inp"
          defaultValue={item.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Labeled>

      {/* 别名要认「海军上将」这种称号——搜索时输入的可能不是正名 */}
      <Labeled label="别名 / 称号">
        <input
          className="inp"
          placeholder="用顿号或逗号分开"
          defaultValue={item.aliases.join('、')}
          // 失焦才提交：边打边拆会把「、」后面的半截字当成一个别名存进去
          onBlur={(e) => patch({ aliases: parseAliases(e.target.value) })}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        />
      </Labeled>

      <Labeled label="生年">
        <YearInput value={item.born} onChange={(v) => patch({ born: v })} placeholder="不详" />
      </Labeled>
      <Labeled label="卒年">
        <YearInput value={item.died} onChange={(v) => patch({ died: v })} placeholder="不详" />
      </Labeled>

      <Labeled label="小传">
        <textarea
          className="inp"
          rows={4}
          placeholder="这个人是谁…"
          defaultValue={item.description || ''}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Labeled>

      <Labeled label="颜色">
        <input type="color" value={item.color} onChange={(e) => patch({ color: e.target.value })} />
      </Labeled>

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
                <b>{ev.from == null ? '未定年' : formatYear(ev.from)}</b>
                <span>{ev.title}</span>
              </button>
            ))}
          </div>
        )}
      </Labeled>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button
          className="btn btn-danger"
          onClick={() => { if (confirm('确认删除？事件里对他的引用会一并摘掉。')) deleteItem('character', id); }}
        >
          🗑 删除
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
