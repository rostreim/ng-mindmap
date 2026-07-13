import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  ViewChild,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { MenuEntry } from './mindmap.model';
import type { MindmapTheme } from './mindmap';

export type ContextMenuCloseReason = 'escape' | 'outside-click' | 'item-selected';

@Component({
  selector: 'mm-context-menu',
  standalone: true,
  templateUrl: './context-menu.html',
  styleUrl: './context-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-theme]': 'theme()',
  },
})
export class ContextMenuComponent {
  readonly entries = input.required<MenuEntry[]>();
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly theme = input<MindmapTheme>('dark');
  readonly closed = output<ContextMenuCloseReason>();

  readonly menuFocusIndex = signal(0);
  readonly submenuOpenIndex = signal<number | null>(null);

  @ViewChild('menuRoot') menuRootRef?: ElementRef<HTMLDivElement>;

  /**
   * runOutsideAngular()/run() here are no-ops in practice — this app has no zone.js
   * installed (zoneless by default in Angular 21; see CLAUDE.md's "Performance contract"),
   * and `closed.emit()` schedules change detection on its own regardless. Kept for
   * correctness if zone.js is ever reintroduced. This component only exists while the menu
   * is open, so — unlike a persistent document-level listener — there's no need for an
   * internal open/closed guard.
   */
  constructor(private zone: NgZone, private destroyRef: DestroyRef) {
    const onDocumentClick = (): void => this.zone.run(() => this.closed.emit('outside-click'));
    const onDocumentKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') this.zone.run(() => this.closed.emit('escape'));
    };
    this.zone.runOutsideAngular(() => {
      document.addEventListener('click', onDocumentClick);
      document.addEventListener('keydown', onDocumentKeydown);
    });
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onDocumentKeydown);
    });

    // Re-derives focus state whenever entries change — covers both first open and
    // reopening this same (already-mounted) menu for a different node/entry set.
    effect(() => {
      const entries = this.entries();
      this.submenuOpenIndex.set(null);
      this.menuFocusIndex.set(this.firstMenuIndex(entries));
      this.focusActiveMenuItem();
    });
  }

  onMenuItemClick(event: MouseEvent, entry: MenuEntry & { type: 'item' }): void {
    event.stopPropagation();
    if (entry.disabled || entry.children?.length) return;
    entry.action();
    this.closed.emit('item-selected');
  }

  isMenuItemActive(index: number, isSubmenu: boolean, parentIndex?: number): boolean {
    if (isSubmenu) {
      return this.submenuOpenIndex() === parentIndex && this.menuFocusIndex() === index;
    }
    return this.submenuOpenIndex() === null && this.menuFocusIndex() === index;
  }

  // ── Keyboard navigation ──────────────────────────────────────────────────

  private isFocusableMenuEntry(entry: MenuEntry): boolean {
    return entry.type === 'item' && !entry.disabled;
  }

  private nextMenuIndex(entries: MenuEntry[], from: number, direction: 1 | -1): number {
    const n = entries.length;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + direction + n) % n;
      if (this.isFocusableMenuEntry(entries[i])) return i;
    }
    return from;
  }

  private firstMenuIndex(entries: MenuEntry[]): number {
    const i = entries.findIndex((e) => this.isFocusableMenuEntry(e));
    return i === -1 ? 0 : i;
  }

  private lastMenuIndex(entries: MenuEntry[]): number {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (this.isFocusableMenuEntry(entries[i])) return i;
    }
    return 0;
  }

  private focusActiveMenuItem(): void {
    // setTimeout (a macrotask), not queueMicrotask: Angular's zone-triggered change detection
    // runs on the microtask queue, so a microtask here can race ahead of the DOM update that
    // creates/moves the tabindex="0" item. A macrotask is guaranteed to run after CD settles.
    setTimeout(() => {
      this.menuRootRef?.nativeElement.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    });
  }

  onMenuKeydown(event: KeyboardEvent): void {
    const inSubmenu = this.submenuOpenIndex() !== null;
    const entries = inSubmenu
      ? (this.entries()[this.submenuOpenIndex()!] as MenuEntry & { type: 'item' }).children!
      : this.entries();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.menuFocusIndex.set(this.nextMenuIndex(entries, this.menuFocusIndex(), 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.menuFocusIndex.set(this.nextMenuIndex(entries, this.menuFocusIndex(), -1));
        break;
      case 'Home':
        event.preventDefault();
        this.menuFocusIndex.set(this.firstMenuIndex(entries));
        break;
      case 'End':
        event.preventDefault();
        this.menuFocusIndex.set(this.lastMenuIndex(entries));
        break;
      case 'ArrowRight': {
        if (inSubmenu) break;
        const current = entries[this.menuFocusIndex()];
        if (current?.type === 'item' && current.children?.length) {
          event.preventDefault();
          this.submenuOpenIndex.set(this.menuFocusIndex());
          this.menuFocusIndex.set(this.firstMenuIndex(current.children));
        }
        break;
      }
      case 'ArrowLeft': {
        if (inSubmenu) {
          event.preventDefault();
          this.menuFocusIndex.set(this.submenuOpenIndex()!);
          this.submenuOpenIndex.set(null);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const active = entries[this.menuFocusIndex()];
        if (active?.type === 'item' && !active.disabled) {
          if (active.children?.length) {
            this.submenuOpenIndex.set(this.menuFocusIndex());
            this.menuFocusIndex.set(this.firstMenuIndex(active.children));
          } else {
            active.action();
            this.closed.emit('item-selected');
          }
        }
        break;
      }
    }

    this.focusActiveMenuItem();
  }
}
