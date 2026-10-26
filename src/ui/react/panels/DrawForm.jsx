import { useStore } from '../../../store/index.js';
import { Labeled, YearInput } from '../common.jsx';

/**
 * 绘制路线 / 区域时的表单。
 * 表单值存 store 的 drawForm：球面点击闭合、按 Enter 都不再需要回到 DOM 里点按钮取闭包变量。
 * 由调用方用 key={mode} 挂载，切换绘制类型即重挂载，取到 setMode 重置后的空表单。
 */
export function DrawForm({ kind }) {
  const drawCount = useStore((s) => s.drawCoords.length);
  const form = useStore((s) => s.drawForm);
  const saveDrawForm = useStore((s) => s.saveDrawForm);
  const commitDraw = useStore((s) => s.commitDraw);
  const setMode = useStore((s) => s.setMode);

  const isRoute = kind === 'route';
  const minPoints = isRoute ? 2 : 3;

  return (
    <div className="insp-block">
      <div className="insp-title">{isRoute ? '绘制路线' : '勾画区域'}</div>
      <p className="insp-hint">
        {isRoute
          ? '在球面上依次单击途经点，设置路线'
          : '在球面上依次单击顶点勾出边界（至少 3 点），点「完成」自动闭合。'}
      </p>
      <span className="insp-hint">{`已放置 ${drawCount} 个点`}</span>

      <Labeled label="名称">
        <input
          className="inp"
          defaultValue={form.title}
          onChange={(e) => saveDrawForm({ title: e.target.value })}
        />
      </Labeled>

      <Labeled label="描述">
        <textarea
          className="inp"
          rows={3}
          defaultValue={form.description}
          onChange={(e) => saveDrawForm({ description: e.target.value })}
        />
      </Labeled>

      <Labeled label="出现于">
        <YearInput value={form.from} onChange={(v) => saveDrawForm({ from: v })} />
      </Labeled>
      <Labeled label="消失于">
        <YearInput value={form.to} onChange={(v) => saveDrawForm({ to: v })} placeholder="至今" />
      </Labeled>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button
          className="btn btn-primary"
          disabled={drawCount < minPoints}
          onClick={() => commitDraw(kind)}
        >
          ✔ 完成
        </button>
        <button className="btn" onClick={() => setMode('browse')}>取消</button>
      </div>
    </div>
  );
}
