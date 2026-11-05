import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import {
  Activity,
  Command as CommandIcon,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Sun,
  UserRound,
  UtensilsCrossed,
  Truck,
} from 'lucide-react';
import { authStore } from '../lib/api/auth-store.js';
import { useLive } from '../lib/live/live-context.js';
import { setPreferences, usePreferences } from '../lib/preferences.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog.js';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '../components/ui/sheet.js';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '../components/ui/command.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../components/ui/dropdown-menu.js';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip.js';
import { Separator } from '../components/ui/separator.js';
import { Switch } from '../components/ui/switch.js';
import { Label } from '../components/ui/label.js';

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <UtensilsCrossed size={20} aria-hidden="true" />
      </span>
      FoodOps<span className="brand-tag">OPS</span>
    </div>
  );
}
function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main navigation">
      <p className="nav-label">WORKSPACE</p>
      <NavLink to="/" end className="nav-item" onClick={onNavigate}>
        <Activity size={18} aria-hidden="true" />
        System status
      </NavLink>
      <NavLink to="/overview" className="nav-item" onClick={onNavigate}>
        <Activity size={18} aria-hidden="true" />
        Overview
      </NavLink>
      <NavLink to="/orders" className="nav-item" onClick={onNavigate}>
        <UtensilsCrossed size={18} aria-hidden="true" />
        Orders
      </NavLink>
      <NavLink to="/deliveries" className="nav-item" onClick={onNavigate}>
        <Truck size={18} aria-hidden="true" />
        Deliveries
      </NavLink>
    </nav>
  );
}
export function Shell() {
  const [drawer, setDrawer] = useState(false);
  const [command, setCommand] = useState(false);
  const [commandTooltip, setCommandTooltip] = useState(false);
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  const commandTrigger = useRef<HTMLButtonElement>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const live = useLive();
  const prefs = usePreferences();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!command)
          commandReturnFocus.current =
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body
              ? document.activeElement
              : commandTrigger.current;
        setCommand(!command);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [command]);
  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar">
        <Brand />
        <Navigation />
        <div className="sidebar-footer">
          <span className="sidebar-dot" />
          FoodOps workspace<p>Connected operations. Clear decisions.</p>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <Button
            ref={navigationTrigger}
            variant="ghost"
            size="icon"
            className="mobile-nav"
            aria-label="Open navigation"
            onClick={() => setDrawer(true)}
          >
            <Menu size={20} />
          </Button>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <strong>Workspace</strong>
          </div>
          <div className="topbar-actions">
            <div role="status" aria-live="polite" className="live-indicator" title={live.message}>
              <span className="connection-dot" data-live={live.status === 'live'} />
              <span className="capitalize">{live.status}</span>
            </div>
            <Tooltip open={commandTooltip && !command} onOpenChange={setCommandTooltip}>
              <TooltipTrigger asChild>
                <Button
                  ref={commandTrigger}
                  variant="ghost"
                  size="icon"
                  aria-label="Open command palette"
                  onClick={() => {
                    commandReturnFocus.current =
                      document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    setCommand(true);
                  }}
                >
                  <Search size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Search navigation · Ctrl/Cmd+K</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Choose theme">
                  {prefs.theme === 'system' ? (
                    <Monitor size={18} />
                  ) : prefs.theme === 'dark' ? (
                    <Moon size={18} />
                  ) : (
                    <Sun size={18} />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="menu-label">Theme: {prefs.theme}</DropdownMenuLabel>
                {(['system', 'light', 'dark'] as const).map((theme) => (
                  <DropdownMenuItem key={theme} onSelect={() => setPreferences({ theme })}>
                    {theme === prefs.theme ? '✓ ' : ''}
                    {theme.charAt(0).toUpperCase() + theme.slice(1)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Separator orientation="vertical" className="h-6" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="user-button" aria-label="Open user menu">
                  <span className="avatar">
                    <UserRound size={17} />
                  </span>
                  <span className="user-name">Operator</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="menu-label">Signed in as ops</DropdownMenuLabel>
                <div className="flex items-center justify-between gap-4 p-2">
                  <Label htmlFor="density-switch">Compact density</Label>
                  <Switch
                    id="density-switch"
                    checked={prefs.density === 'compact'}
                    onCheckedChange={(checked) =>
                      setPreferences({ density: checked ? 'compact' : 'comfortable' })
                    }
                  />
                </div>
                <Separator />
                <DropdownMenuItem onSelect={() => authStore.logout('You have signed out.')}>
                  <LogOut size={16} aria-hidden="true" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">
          <Outlet />
        </main>
        <footer className="app-footer">
          FoodOps<span>Operational clarity, in real time.</span>
        </footer>
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setDrawer(false);
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            navigationTrigger.current?.focus();
          }}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Navigate your FoodOps workspace.</SheetDescription>
          <Brand />
          <Navigation onNavigate={() => setDrawer(false)} />
        </SheetContent>
      </Sheet>
      <Dialog open={command} onOpenChange={setCommand}>
        <DialogContent
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setCommand(false);
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (commandReturnFocus.current?.isConnected) commandReturnFocus.current.focus();
            else commandTrigger.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">
            Search pages and press Enter to navigate.
          </DialogDescription>
          <Command label="Search navigation">
            <div className="command-search">
              <CommandIcon size={18} aria-hidden="true" />
              <CommandInput placeholder="Search navigation…" aria-label="Search navigation" />
            </div>
            <CommandList>
              <CommandEmpty>No matching pages.</CommandEmpty>
              <CommandGroup heading="Workspace">
                <CommandItem
                  onSelect={() => {
                    setCommand(false);
                    void navigate('/');
                  }}
                >
                  <Activity size={18} aria-hidden="true" />
                  System status
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    setCommand(false);
                    void navigate('/overview');
                  }}
                >
                  <Activity size={18} aria-hidden="true" />
                  Overview
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    setCommand(false);
                    void navigate('/orders');
                  }}
                >
                  <UtensilsCrossed size={18} aria-hidden="true" />
                  Orders
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}
