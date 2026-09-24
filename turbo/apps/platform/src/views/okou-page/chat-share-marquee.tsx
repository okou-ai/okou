import { ScrollArea } from "@base-ui/react/scroll-area";
import {
  Component,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from "react";
import { toast } from "@okouai/ui/components/ui/sonner";

import type {
  SetSharedThreadSelectionResult,
  SharedThreadSelectionPhase,
} from "../../signals/chat-page/chat-thread-sharing.ts";

const GROUP_SELECTOR = "[data-chat-share-selectable-group]";
const THREAD_CONTAINER_SELECTOR = "[data-chat-thread-container-id]";
const DRAG_THRESHOLD_PX = 5;
const SCROLL_EDGE_PX = 56;
const MAX_SCROLL_PX_PER_FRAME = 24;

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startEventId: string;
  x: number;
  y: number;
  active: boolean;
  lastEndEventId: string | null;
  selectionApplied: boolean;
  tooLargeShown: boolean;
}

interface MarqueeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface MarqueeViewportProps {
  readonly children: ReactNode;
  readonly phase: SharedThreadSelectionPhase;
  readonly onViewportRef: (element: HTMLDivElement | null) => void;
  readonly onScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  readonly viewportClassName: string;
  readonly tooLargeLabel: string;
  readonly selectRange: (
    startEventId: string,
    endEventId: string,
  ) => SetSharedThreadSelectionResult;
  readonly selectAll: () => SetSharedThreadSelectionResult;
  readonly clearSelection: () => void;
}

interface MarqueeViewportState {
  readonly rect: MarqueeRect | null;
}

export function clickTargetsExistingInteraction(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'a, button, input, textarea, select, [role="button"], [role="checkbox"], [contenteditable="true"]',
    ) !== null
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

function nearestGroupEventId(
  viewport: HTMLElement,
  clientY: number,
): string | null {
  const viewportRect = viewport.getBoundingClientRect();
  let nearest: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const group of viewport.querySelectorAll<HTMLElement>(GROUP_SELECTOR)) {
    const rect = group.getBoundingClientRect();
    if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) {
      continue;
    }
    const distance = Math.max(rect.top - clientY, clientY - rect.bottom, 0);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = group;
    }
  }
  return nearest?.dataset.chatShareGroupEventId ?? null;
}

function scrollStep(clientY: number, top: number, bottom: number): number {
  if (clientY < top + SCROLL_EDGE_PX) {
    return -Math.min(
      MAX_SCROLL_PX_PER_FRAME,
      Math.max(1, (top + SCROLL_EDGE_PX - clientY) / 2),
    );
  }
  if (clientY > bottom - SCROLL_EDGE_PX) {
    return Math.min(
      MAX_SCROLL_PX_PER_FRAME,
      Math.max(1, (clientY - (bottom - SCROLL_EDGE_PX)) / 2),
    );
  }
  return 0;
}

function marqueeRect(viewport: HTMLElement, drag: DragState): MarqueeRect {
  const bounds = viewport.getBoundingClientRect();
  const startX = Math.max(bounds.left, Math.min(bounds.right, drag.startX));
  const endX = Math.max(bounds.left, Math.min(bounds.right, drag.x));
  const startY = Math.max(bounds.top, Math.min(bounds.bottom, drag.startY));
  const endY = Math.max(bounds.top, Math.min(bounds.bottom, drag.y));
  return {
    left: Math.min(startX, endX) - bounds.left,
    top: Math.min(startY, endY) - bounds.top,
    width: Math.max(1, Math.abs(endX - startX)),
    height: Math.max(1, Math.abs(endY - startY)),
  };
}

function crossesMessageColumn(
  viewport: HTMLElement,
  rect: MarqueeRect,
): boolean {
  const left = viewport.getBoundingClientRect().left + rect.left;
  const right = left + rect.width;
  return Array.from(
    viewport.querySelectorAll<HTMLElement>(GROUP_SELECTOR),
  ).some((group) => {
    const groupRect = group.getBoundingClientRect();
    return groupRect.left <= right && groupRect.right >= left;
  });
}

// eslint-disable-next-line ccstate/no-react-class-component -- Pointer capture and animation frames need one stable controller across selection rerenders.
export class ChatShareMarqueeViewport extends Component<
  MarqueeViewportProps,
  MarqueeViewportState
> {
  private static readonly mounted = new Set<ChatShareMarqueeViewport>();

  state: MarqueeViewportState = { rect: null };
  private drag: DragState | null = null;
  private frame: number | null = null;
  private viewport: HTMLElement | null = null;
  private marqueeElement: HTMLDivElement | null = null;
  private suppressClick = false;

  componentDidMount(): void {
    ChatShareMarqueeViewport.mounted.add(this);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  componentDidUpdate(previousProps: MarqueeViewportProps): void {
    if (
      previousProps.phase !== this.props.phase &&
      this.props.phase !== "selecting"
    ) {
      this.stopDrag();
    }
  }

  componentWillUnmount(): void {
    ChatShareMarqueeViewport.mounted.delete(this);
    window.removeEventListener("keydown", this.handleKeyDown);
    this.cancelScrollFrame();
  }

  private ownsShortcutEvent(event: KeyboardEvent): boolean {
    const threadContainer = this.viewport?.closest<HTMLElement>(
      THREAD_CONTAINER_SELECTOR,
    );
    if (!threadContainer) {
      return false;
    }
    const targetContainer =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(THREAD_CONTAINER_SELECTOR)
        : null;
    if (targetContainer) {
      return targetContainer === threadContainer;
    }
    const selecting = [...ChatShareMarqueeViewport.mounted].filter(
      (viewport) => {
        return viewport.props.phase === "selecting";
      },
    );
    return selecting.length === 1 && selecting[0] === this;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (
      this.props.phase !== "selecting" ||
      event.key.toLowerCase() !== "a" ||
      (!event.metaKey && !event.ctrlKey) ||
      event.altKey ||
      isEditableTarget(event.target) ||
      !this.ownsShortcutEvent(event)
    ) {
      return;
    }
    event.preventDefault();
    if (this.props.selectAll() === "too-large") {
      toast.error(this.props.tooLargeLabel);
    }
  };

  private cancelScrollFrame(): void {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  private stopDrag(): void {
    this.cancelScrollFrame();
    this.drag = null;
    if (this.state.rect !== null) {
      this.setState({ rect: null });
    }
  }

  private readonly handleViewportRef = (
    element: HTMLDivElement | null,
  ): void => {
    this.viewport = element;
    this.props.onViewportRef(element);
  };

  private updateSelection(viewport: HTMLElement, drag: DragState): void {
    const rect = marqueeRect(viewport, drag);
    if (this.state.rect === null) {
      this.setState({ rect });
    } else if (this.marqueeElement) {
      // Moving the rectangle every frame must not commit React layout: the
      // transcript restores its held scroll anchor on each React commit.
      this.marqueeElement.style.left = `${rect.left}px`;
      this.marqueeElement.style.top = `${rect.top}px`;
      this.marqueeElement.style.width = `${rect.width}px`;
      this.marqueeElement.style.height = `${rect.height}px`;
    }
    if (!crossesMessageColumn(viewport, rect)) {
      if (!drag.selectionApplied || drag.lastEndEventId !== null) {
        this.props.clearSelection();
        drag.selectionApplied = true;
        drag.lastEndEventId = null;
      }
      return;
    }

    const endEventId = nearestGroupEventId(viewport, drag.y);
    if (!endEventId || endEventId === drag.lastEndEventId) {
      return;
    }
    drag.lastEndEventId = endEventId;
    drag.selectionApplied = true;
    if (this.props.selectRange(drag.startEventId, endEventId) === "too-large") {
      if (!drag.tooLargeShown) {
        toast.error(this.props.tooLargeLabel);
        drag.tooLargeShown = true;
      }
    } else {
      drag.tooLargeShown = false;
    }
  }

  private readonly scrollWhileDragging = (): void => {
    this.frame = null;
    const drag = this.drag;
    const viewport = this.viewport;
    if (!drag?.active || !viewport) {
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    const step = scrollStep(drag.y, bounds.top, bounds.bottom);
    if (step === 0) {
      return;
    }
    viewport.scrollTop += step;
    // The scroll listener captures the new transcript anchor before updating
    // selection. Updating here would commit a selected row before that capture
    // and restore the old scroll offset on every frame at a group boundary.
    this.frame = window.requestAnimationFrame(this.scrollWhileDragging);
  };

  private readonly handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (
      this.props.phase !== "selecting" ||
      (event.pointerType !== "mouse" && event.pointerType !== "pen") ||
      event.button !== 0 ||
      clickTargetsExistingInteraction(event.target)
    ) {
      return;
    }
    const startEventId = nearestGroupEventId(
      event.currentTarget,
      event.clientY,
    );
    if (!startEventId) {
      return;
    }
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startEventId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      lastEndEventId: null,
      selectionApplied: false,
      tooLargeShown: false,
    };
  };

  private readonly handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (
      !drag.active &&
      Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.active = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (this.frame === null) {
      this.frame = window.requestAnimationFrame(this.scrollWhileDragging);
    }
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    this.updateSelection(event.currentTarget, drag);
  };

  private readonly handlePointerEnd = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.active && event.type === "pointerup") {
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.updateSelection(event.currentTarget, drag);
      this.suppressClick = true;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    this.stopDrag();
  };

  private readonly handleScroll = (
    event: ReactUIEvent<HTMLDivElement>,
  ): void => {
    if (this.drag?.active) {
      this.updateSelection(event.currentTarget, this.drag);
    }
    this.props.onScroll(event);
  };

  private readonly handleClickCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  render(): ReactNode {
    return (
      <>
        <ScrollArea.Viewport
          ref={this.handleViewportRef}
          data-slot="scroll-area-viewport"
          data-scroll-container
          tabIndex={-1}
          onScroll={this.handleScroll}
          onPointerDown={this.handlePointerDown}
          onPointerMove={this.handlePointerMove}
          onPointerUp={this.handlePointerEnd}
          onPointerCancel={this.handlePointerEnd}
          onClickCapture={this.handleClickCapture}
          className={this.props.viewportClassName}
        >
          {this.props.children}
        </ScrollArea.Viewport>
        {this.state.rect ? (
          <div
            ref={(element) => {
              this.marqueeElement = element;
            }}
            data-chat-share-marquee
            aria-hidden
            className="pointer-events-none absolute z-20 border border-foreground/40 bg-state-selected/30"
            style={this.state.rect}
          />
        ) : null}
      </>
    );
  }
}
