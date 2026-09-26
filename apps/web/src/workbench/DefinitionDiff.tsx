import { definitionChanges } from '@fantasy/domain/spatial';

export function DefinitionDiff({ before, text }: { before: unknown; text: string }) {
  let diff: ReturnType<typeof definitionChanges>;
  try {
    if (text.length > 1000000) throw new Error('Definition too large');
    diff = definitionChanges(before, JSON.parse(text) as unknown);
  } catch {
    return <p role="status">JSONを修正するとフィールド単位の差分を表示します。</p>;
  }
  return (
    <div aria-label="定義の差分">
      <p>{diff.changes.length === 0 ? '変更なし' : `${diff.changes.length}件の変更`}</p>
      {diff.truncated && <p>差分が多いため一部のみ表示しています。</p>}
      <ul>
        {diff.changes.map((change) => (
          <li key={change.path}>
            <code>{change.path}</code> · {change.kind}
            {change.before !== undefined && <pre>変更前: {change.before}</pre>}
            {change.after !== undefined && <pre>変更後: {change.after}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}
