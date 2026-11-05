import type { ComponentPropsWithoutRef } from 'react';
import {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogTitle,
  DialogDescription,
  DialogContent,
} from './dialog.js';
import { cn } from '../../lib/cn.js';
export const Sheet = Dialog;
export const SheetTrigger = DialogTrigger;
export const SheetClose = DialogClose;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;
export function SheetContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogContent>) {
  return <DialogContent className={cn('sheet-content', className)} {...props} />;
}
