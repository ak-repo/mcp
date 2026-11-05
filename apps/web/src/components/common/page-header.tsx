import type { ReactNode } from 'react';
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <p className="eyebrow">OPERATIONS WORKSPACE</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {actions}
    </div>
  );
}
