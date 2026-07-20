import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MindmapComponent, MindmapCoreFactory, MINDMAP_CORE_FACTORY } from './mindmap';
import { MindmapGraph } from './mindmap.model';
import { MindmapCoreOptions } from './mindmap-core';

describe('MindmapComponent (wiring)', () => {
  let fixture: ComponentFixture<MindmapComponent>;
  let component: MindmapComponent;
  let coreStub: {
    setSize: ReturnType<typeof vi.fn>;
    setTheme: ReturnType<typeof vi.fn>;
    setLayoutMode: ReturnType<typeof vi.fn>;
    setData: ReturnType<typeof vi.fn>;
    resetView: ReturnType<typeof vi.fn>;
    zoomToFit: ReturnType<typeof vi.fn>;
    notifyMenuClosed: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  let capturedOptions!: MindmapCoreOptions;

  const sampleGraph: MindmapGraph = {
    nodes: [{ id: 'root', label: 'Root' }],
    edges: [],
  };

  beforeEach(async () => {
    coreStub = {
      setSize: vi.fn(),
      setTheme: vi.fn(),
      setLayoutMode: vi.fn(),
      setData: vi.fn(),
      resetView: vi.fn(),
      zoomToFit: vi.fn(),
      notifyMenuClosed: vi.fn(),
      destroy: vi.fn(),
    };

    const stubFactory: MindmapCoreFactory = (_svg, _data, options) => {
      capturedOptions = options;
      return coreStub as any;
    };

    await TestBed.configureTestingModule({
      imports: [MindmapComponent],
      providers: [{ provide: MINDMAP_CORE_FACTORY, useValue: stubFactory }],
    }).compileComponents();

    fixture = TestBed.createComponent(MindmapComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('data', sampleGraph);
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  it('constructs MindmapCore (via the injected factory) with the initial input values', () => {
    expect(capturedOptions).toEqual(
      expect.objectContaining({ width: 900, height: 650, theme: 'dark' }),
    );
  });

  it('forwards a width/height change to core.setSize', () => {
    fixture.componentRef.setInput('width', 1000);
    fixture.componentRef.setInput('height', 700);
    fixture.detectChanges();
    expect(coreStub.setSize).toHaveBeenCalledWith(1000, 700);
  });

  it('forwards a theme change to core.setTheme', () => {
    fixture.componentRef.setInput('theme', 'light');
    fixture.detectChanges();
    expect(coreStub.setTheme).toHaveBeenCalledWith('light');
  });

  it('forwards a layoutMode change to core.setLayoutMode', () => {
    fixture.componentRef.setInput('layoutMode', 'radial');
    fixture.detectChanges();
    expect(coreStub.setLayoutMode).toHaveBeenCalledWith('radial');
  });

  it('forwards a data change to core.setData', () => {
    const updated: MindmapGraph = { nodes: [{ id: 'x', label: 'X' }], edges: [] };
    fixture.componentRef.setInput('data', updated);
    fixture.detectChanges();
    expect(coreStub.setData).toHaveBeenCalledWith(updated);
  });

  it('resetView()/zoomToFit() delegate to the core', () => {
    component.resetView();
    component.zoomToFit();
    expect(coreStub.resetView).toHaveBeenCalled();
    expect(coreStub.zoomToFit).toHaveBeenCalled();
  });

  it('onOpenContextMenu populates the menu signals', () => {
    capturedOptions.onOpenContextMenu?.([{ type: 'topic', label: 'X' }], 10, 20);
    expect(component.menuOpen()).toBe(true);
    expect(component.menuX()).toBe(10);
    expect(component.menuY()).toBe(20);
    expect(component.menuEntries()).toEqual([{ type: 'topic', label: 'X' }]);
  });

  it('onLiveMessage forwards to the liveMessage signal', () => {
    capturedOptions.onLiveMessage?.('A collapsed');
    expect(component.liveMessage()).toBe('A collapsed');
  });

  it('onContextMenuClosed closes the menu and delegates to core.notifyMenuClosed', () => {
    component.onContextMenuClosed('escape');
    expect(component.menuOpen()).toBe(false);
    expect(coreStub.notifyMenuClosed).toHaveBeenCalledWith('escape');
  });

  it('ngOnDestroy calls core.destroy', () => {
    (component as any).ngOnDestroy();
    expect(coreStub.destroy).toHaveBeenCalled();
  });
});
