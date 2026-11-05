import { Fragment } from 'react';

function label(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function PreviewFields({ preview }: { preview: Record<string, unknown> }) {
  return (
    <dl className="preview-grid">
      {Object.entries(preview)
        .filter(([name]) => !['confirmation_token', 'expires_at'].includes(name))
        .map(([name, value]) => (
          <Fragment key={name}>
            <dt>{label(name)}</dt>
            <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

export function PreviewRenderer({ preview }: { preview: Record<string, unknown> }) {
  return <PreviewFields preview={preview} />;
}
