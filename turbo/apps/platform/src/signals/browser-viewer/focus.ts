/** Local toolbar policy and DOM work belong to one viewer, never its input wire. */
export class ToolbarFocus {
  private createOrigin: Element | null = null;
  private closingTarget: string | null = null;
  private restoreClosed = false;
  private toolbarFocus: HTMLElement | null = null;

  constructor(
    private readonly toolbar: HTMLDivElement,
    private readonly tabs: HTMLDivElement,
    private readonly address: HTMLInputElement,
  ) {}

  reset(): void {
    this.createOrigin = null;
    this.closingTarget = null;
    this.restoreClosed = false;
    this.toolbarFocus = null;
  }

  beginCreate(): void {
    this.createOrigin = document.activeElement;
  }

  created(): void {
    // A disabled initiating button may leave body focused. Later controls win.
    if (
      document.activeElement === this.createOrigin ||
      document.activeElement === document.body
    ) {
      this.address?.focus({ preventScroll: true });
    }
    this.createOrigin = null;
  }

  beginClose(targetId: string): void {
    this.closingTarget =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.closeTarget === targetId
        ? targetId
        : null;
  }

  closed(targetId: string): void {
    this.restoreClosed =
      this.closingTarget === targetId &&
      (document.activeElement === document.body ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.dataset.closeTarget === targetId));
    this.closingTarget = null;
  }

  restoreAfterClose(): void {
    if (!this.restoreClosed) {
      return;
    }
    this.restoreClosed = false;
    this.release();
  }

  release(): void {
    const list = this.tabs;
    (
      this.selected() ??
      list?.querySelector<HTMLElement>('[role="tab"]') ??
      this.toolbar?.querySelector<HTMLElement>("[data-browser-tab-picker]") ??
      this.toolbar?.querySelector<HTMLElement>("[data-browser-new-tab]")
    )?.focus({ preventScroll: true });
  }

  listen(): () => void {
    const row = this.toolbar;
    const focused = (event: FocusEvent) => {
      this.toolbarFocus =
        event.target instanceof HTMLElement && row?.contains(event.target)
          ? event.target
          : null;
    };
    const pointed = (event: PointerEvent) => {
      if (event.target instanceof Node && !row?.contains(event.target)) {
        this.toolbarFocus = null;
      }
    };
    document.addEventListener("focusin", focused);
    document.addEventListener("pointerdown", pointed);
    return () => {
      document.removeEventListener("focusin", focused);
      document.removeEventListener("pointerdown", pointed);
    };
  }

  restoreLayout(): void {
    const origin = this.toolbarFocus;
    if (
      origin &&
      (!origin.isConnected || !origin.getClientRects().length) &&
      (document.activeElement === document.body ||
        document.activeElement === origin)
    ) {
      this.release();
    }
  }

  private selected(): HTMLElement | null | undefined {
    return this.tabs?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
  }
}
