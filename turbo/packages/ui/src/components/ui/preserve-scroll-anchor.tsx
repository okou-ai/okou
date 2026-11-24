import { Component, createRef, type ReactNode } from "react";
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  type ScrollAnchorOptions,
  type ScrollAnchorSnapshot,
} from "../../lib/scroll-anchor";

interface PreserveScrollAnchorProps {
  readonly children: ReactNode;
  readonly layoutKey: boolean;
  readonly anchor?: ScrollAnchorOptions;
}

/** Read before React changes document geometry, restore before the next paint. */
export class PreserveScrollAnchor extends Component<
  PreserveScrollAnchorProps,
  Record<string, never>,
  ScrollAnchorSnapshot | null
> {
  private readonly container = createRef<HTMLDivElement>();

  public getSnapshotBeforeUpdate(previous: PreserveScrollAnchorProps) {
    const { anchor, layoutKey } = this.props;
    return anchor && previous.layoutKey !== layoutKey && this.container.current
      ? captureScrollAnchor(this.container.current, anchor)
      : null;
  }

  public componentDidUpdate(
    _previous: PreserveScrollAnchorProps,
    _state: Record<string, never>,
    snapshot: ScrollAnchorSnapshot | null,
  ) {
    if (!snapshot) {
      return;
    }
    try {
      restoreScrollAnchor(snapshot);
    } finally {
      if (!snapshot.anchoringAlreadyDisabled) {
        snapshot.viewport.classList.remove("[overflow-anchor:none]");
      }
    }
  }

  public render() {
    return (
      <div ref={this.container} className="contents">
        {this.props.children}
      </div>
    );
  }
}
