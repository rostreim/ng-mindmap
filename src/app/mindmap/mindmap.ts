import {
  Component,
  ElementRef,
  InjectionToken,
  OnDestroy,
  OnInit,
  ViewChild,
  ChangeDetectionStrategy,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { MindmapGraph, MenuEntry, ContextMenuFn, NodeClickFn } from './mindmap.model';
import { MindmapCore, MindmapCoreOptions, MindmapTheme, MindmapLayout } from './mindmap-core';
import { ContextMenuCloseReason, ContextMenuComponent } from './context-menu';

export type { MindmapTheme, MindmapLayout };

export type MindmapCoreFactory = (
  svg: SVGSVGElement,
  data: MindmapGraph,
  options: MindmapCoreOptions,
) => MindmapCore;

/**
 * DI seam so tests can substitute MindmapCore via TestBed.overrideProvider instead of
 * vi.mock()-ing the module -- this repo's Angular vitest builder (@angular/build:unit-test)
 * unconditionally forbids vi.mock() for relative-path imports, so module-level mocking of
 * './mindmap-core' isn't an option here.
 */
export const MINDMAP_CORE_FACTORY = new InjectionToken<MindmapCoreFactory>('MINDMAP_CORE_FACTORY', {
  providedIn: 'root',
  factory: () => (svg: SVGSVGElement, data: MindmapGraph, options: MindmapCoreOptions) =>
    new MindmapCore(svg, data, options),
});

@Component({
  selector: 'app-mindmap',
  standalone: true,
  imports: [ContextMenuComponent],
  templateUrl: './mindmap.html',
  styleUrl: './mindmap.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-theme]': 'theme()',
  },
})
export class MindmapComponent implements OnInit, OnDestroy {
  readonly data = input.required<MindmapGraph>();
  readonly width = input(900);
  readonly height = input(650);
  readonly theme = input<MindmapTheme>('dark');
  readonly contextMenuFn = input<ContextMenuFn>();
  readonly nodeClickFn = input<NodeClickFn>();
  readonly ariaLabel = input('Mind map');
  readonly layoutMode = input<MindmapLayout>('force');
  readonly collapseMode = input<'global' | 'per-edge'>('global');
  readonly edgeDirection = input<'arrow' | 'plain' | undefined>(undefined);

  @ViewChild('svgContainer', { static: true }) svgRef!: ElementRef<SVGSVGElement>;

  readonly menuOpen = signal(false);
  readonly menuX = signal(0);
  readonly menuY = signal(0);
  readonly menuEntries = signal<MenuEntry[]>([]);

  readonly liveMessage = signal('');

  private readonly coreFactory = inject(MINDMAP_CORE_FACTORY);
  private core!: MindmapCore;

  onContextMenuClosed(reason: ContextMenuCloseReason): void {
    this.menuOpen.set(false);
    this.core.notifyMenuClosed(reason);
  }

  constructor() {
    let widthHeightFirstRun = true;
    effect(() => {
      const width = this.width();
      const height = this.height();
      if (widthHeightFirstRun) { widthHeightFirstRun = false; return; }
      this.core.setSize(width, height);
    });

    let themeFirstRun = true;
    effect(() => {
      const theme = this.theme();
      if (themeFirstRun) { themeFirstRun = false; return; }
      this.core.setTheme(theme);
    });

    let layoutModeFirstRun = true;
    effect(() => {
      const layoutMode = this.layoutMode();
      if (layoutModeFirstRun) { layoutModeFirstRun = false; return; }
      this.core.setLayoutMode(layoutMode);
    });

    let dataFirstRun = true;
    effect(() => {
      const data = this.data();
      if (dataFirstRun) { dataFirstRun = false; return; }
      this.core.setData(data);
    });
  }

  ngOnInit(): void {
    const options: MindmapCoreOptions = {
      width: this.width(),
      height: this.height(),
      theme: this.theme(),
      layoutMode: this.layoutMode(),
      ariaLabel: this.ariaLabel(),
      getCollapseMode: () => this.collapseMode(),
      getEdgeDirection: () => this.edgeDirection(),
      getContextMenuFn: () => this.contextMenuFn(),
      getNodeClickFn: () => this.nodeClickFn(),
      onOpenContextMenu: (entries, x, y) => {
        this.menuEntries.set(entries);
        this.menuX.set(x);
        this.menuY.set(y);
        this.menuOpen.set(true);
      },
      onLiveMessage: (message) => this.liveMessage.set(message),
    };
    this.core = this.coreFactory(this.svgRef.nativeElement, this.data(), options);
  }

  ngOnDestroy(): void {
    this.core?.destroy();
  }

  resetView(): void {
    this.core.resetView();
  }

  zoomToFit(): void {
    this.core.zoomToFit();
  }
}
