import { Tabs as Primitive } from 'radix-ui';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/cn.js';
export const Tabs = Primitive.Root;
export const TabsList = forwardRef<
  ElementRef<typeof Primitive.List>,
  ComponentPropsWithoutRef<typeof Primitive.List>
>(({ className, ...props }, ref) => (
  <Primitive.List ref={ref} className={cn('tabs-list', className)} {...props} />
));
TabsList.displayName = 'TabsList';
export const TabsTrigger = forwardRef<
  ElementRef<typeof Primitive.Trigger>,
  ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(({ className, ...props }, ref) => (
  <Primitive.Trigger ref={ref} className={cn('tabs-trigger', className)} {...props} />
));
TabsTrigger.displayName = 'TabsTrigger';
export const TabsContent = forwardRef<
  ElementRef<typeof Primitive.Content>,
  ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, ...props }, ref) => (
  <Primitive.Content ref={ref} className={cn('tabs-content', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';
