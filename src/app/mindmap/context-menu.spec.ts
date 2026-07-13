import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ContextMenuComponent } from './context-menu';
import { MenuEntry } from './mindmap.model';

describe('ContextMenuComponent', () => {
  let fixture: ComponentFixture<ContextMenuComponent>;
  let component: ContextMenuComponent;

  const entries: MenuEntry[] = [
    { type: 'topic', label: 'Actions' },
    { type: 'item', label: 'Expand all', action: () => {} },
    { type: 'separator' },
    { type: 'item', label: 'Disabled item', action: () => {}, disabled: true },
    { type: 'item', label: 'Delete', action: () => {} },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ContextMenuComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ContextMenuComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entries', entries);
    fixture.componentRef.setInput('x', 0);
    fixture.componentRef.setInput('y', 0);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  describe('initial focus (set reactively from entries)', () => {
    it('focuses the first focusable entry, skipping topics/separators', () => {
      expect(component.menuFocusIndex()).toBe(1);
      expect(component.submenuOpenIndex()).toBeNull();
    });

    it('re-derives focus when entries change while already mounted (reopened for a different node)', () => {
      const otherEntries: MenuEntry[] = [
        { type: 'item', label: 'Only item', action: () => {} },
      ];
      fixture.componentRef.setInput('entries', otherEntries);
      fixture.detectChanges();

      expect(component.menuFocusIndex()).toBe(0);
      expect(component.submenuOpenIndex()).toBeNull();
    });
  });

  describe('isFocusableMenuEntry / nextMenuIndex / firstMenuIndex / lastMenuIndex', () => {
    it('isFocusableMenuEntry is true only for enabled items', () => {
      expect((component as any).isFocusableMenuEntry(entries[0])).toBe(false); // topic
      expect((component as any).isFocusableMenuEntry(entries[1])).toBe(true); // item
      expect((component as any).isFocusableMenuEntry(entries[2])).toBe(false); // separator
      expect((component as any).isFocusableMenuEntry(entries[3])).toBe(false); // disabled item
      expect((component as any).isFocusableMenuEntry(entries[4])).toBe(true); // item
    });

    it('nextMenuIndex skips non-focusable entries and wraps around', () => {
      expect((component as any).nextMenuIndex(entries, 1, 1)).toBe(4); // skips separator + disabled
      expect((component as any).nextMenuIndex(entries, 4, 1)).toBe(1); // wraps to start, skips topic
      expect((component as any).nextMenuIndex(entries, 4, -1)).toBe(1); // skips disabled + separator
      expect((component as any).nextMenuIndex(entries, 1, -1)).toBe(4); // wraps to end
    });

    it('firstMenuIndex / lastMenuIndex find the first and last focusable entries', () => {
      expect((component as any).firstMenuIndex(entries)).toBe(1);
      expect((component as any).lastMenuIndex(entries)).toBe(4);
    });

    it('falls back to index 0 when no entry is focusable', () => {
      const allDisabled: MenuEntry[] = [
        { type: 'topic', label: 'Actions' },
        { type: 'separator' },
      ];
      expect((component as any).firstMenuIndex(allDisabled)).toBe(0);
      expect((component as any).lastMenuIndex(allDisabled)).toBe(0);
    });
  });

  describe('onMenuItemClick', () => {
    it('invokes the action and emits "item-selected" for an enabled leaf item', () => {
      const closed = vi.fn();
      component.closed.subscribe(closed);
      const item = entries[1] as MenuEntry & { type: 'item' };
      const actionSpy = vi.spyOn(item, 'action');

      component.onMenuItemClick(new MouseEvent('click'), item);

      expect(actionSpy).toHaveBeenCalled();
      expect(closed).toHaveBeenCalledWith('item-selected');
    });

    it('does nothing for a disabled item', () => {
      const closed = vi.fn();
      component.closed.subscribe(closed);
      const item = entries[3] as MenuEntry & { type: 'item' };
      const actionSpy = vi.spyOn(item, 'action');

      component.onMenuItemClick(new MouseEvent('click'), item);

      expect(actionSpy).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    });
  });
});
