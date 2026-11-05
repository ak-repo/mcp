import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.js';
export const Table = forwardRef<HTMLTableElement, ComponentPropsWithoutRef<'table'>>(
  ({ className, ...props }, ref) => (
    <div className="table-scroll">
      <table ref={ref} className={cn('table', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';
export function TableHeader(props: ComponentPropsWithoutRef<'thead'>) {
  return <thead {...props} />;
}
export function TableBody(props: ComponentPropsWithoutRef<'tbody'>) {
  return <tbody {...props} />;
}
export function TableRow(props: ComponentPropsWithoutRef<'tr'>) {
  return <tr {...props} />;
}
export function TableHead(props: ComponentPropsWithoutRef<'th'>) {
  return <th scope="col" {...props} />;
}
export function TableCell(props: ComponentPropsWithoutRef<'td'>) {
  return <td {...props} />;
}
export function TableCaption(props: ComponentPropsWithoutRef<'caption'>) {
  return <caption {...props} />;
}
