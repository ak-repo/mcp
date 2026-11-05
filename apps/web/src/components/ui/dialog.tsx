import { Dialog as Primitive } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.js';
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export function DialogContent({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="overlay" />
      <Primitive.Content className={cn('dialog-content', className)} {...props}>
        {children}
        <Primitive.Close
          className="button button-ghost button-icon dialog-close"
          aria-label="Close dialog"
        >
          <X size={18} />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
