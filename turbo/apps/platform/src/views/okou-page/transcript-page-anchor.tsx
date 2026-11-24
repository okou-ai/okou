import { Component, type ReactNode } from "react";

interface Props {
  readonly viewport: HTMLElement | null;
  readonly pages: readonly { readonly key: string }[];
  readonly before: number;
  readonly children: ReactNode;
}

interface Snapshot {
  readonly anchor: HTMLElement;
  readonly offset: number;
}

/** Preserve the reading position as a spacer gives way to measured rows. */
export class TranscriptPageAnchor extends Component<
  Props,
  Record<string, never>,
  Snapshot | null
> {
  public getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { viewport, pages, before } = this.props;
    if (
      !viewport ||
      previous.viewport !== viewport ||
      (previous.before === before && previous.pages[0]?.key === pages[0]?.key)
    ) {
      return null;
    }

    const bounds = viewport.getBoundingClientRect();
    for (const page of viewport.querySelectorAll<HTMLElement>(
      "[data-transcript-page]",
    )) {
      const retained = pages.some(({ key }) => {
        return key === page.dataset.transcriptPage;
      });
      if (!retained) {
        continue;
      }
      for (const anchor of page.querySelectorAll<HTMLElement>(
        "[data-chat-scroll-anchor-event-id]",
      )) {
        const rect = anchor.getBoundingClientRect();
        if (
          rect.height > 0 &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom
        ) {
          return { anchor, offset: rect.top - bounds.top };
        }
      }
    }
    return null;
  }

  public componentDidUpdate(
    _previous: Props,
    _state: Record<string, never>,
    snapshot: Snapshot | null,
  ) {
    const { viewport } = this.props;
    if (!snapshot || !viewport?.contains(snapshot.anchor)) {
      return;
    }
    const delta =
      snapshot.anchor.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      snapshot.offset;
    // Native anchoring may already have covered the entire adjustment.
    if (Math.abs(delta) >= 1) {
      viewport.scrollTop += delta;
    }
  }

  public render() {
    return this.props.children;
  }
}
