export interface BlockReadingAnchor {
  readonly index: number;
  readonly tagName: string;
  readonly viewportOffsetTop: number;
}

const SOURCE_SELECTOR = "[data-chat-selection-source]";
const EVENT_SELECTOR = "[data-chat-scroll-anchor-event-id]";
const BLOCK_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table";
const EXCLUDED_SELECTOR =
  "[hidden],[inert],a[href],area[href],button,input,textarea,select,option,optgroup,svg,script,style,noscript,template,iframe,canvas,video,audio,object,embed,summary,details:not([open]),[data-chat-selection-interaction],[data-markdown-ui],[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=slider],[role=spinbutton],[role=menu],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=listbox],[role=option],[role=tree],[role=treeitem],[role=grid],[role=gridcell],[role=toolbar],[role=tooltip]";

function readingBlocks(eventAnchor: HTMLElement): HTMLElement[] {
  const ownerSource = eventAnchor.closest(SOURCE_SELECTOR);
  const ownerEvent = eventAnchor.closest(EVENT_SELECTOR);
  const blocks = Array.from(
    eventAnchor.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  );
  if (eventAnchor.matches(BLOCK_SELECTOR)) {
    blocks.unshift(eventAnchor);
  }
  // Keep structural ordinals independent of visibility and geometry. They are
  // limited reflow locators, not semantic identities for rewritten content.
  return blocks.filter((block) => {
    const source = block.closest(SOURCE_SELECTOR);
    return (
      source !== null &&
      (ownerSource
        ? source === ownerSource
        : !source.parentElement?.closest(SOURCE_SELECTOR)) &&
      block.closest(EVENT_SELECTOR) === ownerEvent &&
      !block.querySelector(BLOCK_SELECTOR)
    );
  });
}

function validRect(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    [
      rect.top,
      rect.bottom,
      rect.left,
      rect.right,
      rect.width,
      rect.height,
    ].every(Number.isFinite)
  );
}

function readingViewport(container: HTMLElement): DOMRect | null {
  const rect = container.getBoundingClientRect();
  const viewport = new DOMRect(
    rect.left + container.clientLeft,
    rect.top + container.clientTop,
    container.clientWidth,
    container.clientHeight,
  );
  return validRect(viewport) ? viewport : null;
}

function blockRect(block: HTMLElement): DOMRect | null {
  for (
    let element: Element | null = block;
    element;
    element = element.parentElement
  ) {
    if (
      element.matches(EXCLUDED_SELECTOR) ||
      element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
      (element.hasAttribute("contenteditable") &&
        element.getAttribute("contenteditable")?.toLowerCase() !== "false")
    ) {
      return null;
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse" ||
      style?.opacity === "0" ||
      style?.getPropertyValue("content-visibility") === "hidden"
    ) {
      return null;
    }
  }
  const rect = block.getBoundingClientRect();
  return validRect(rect) ? rect : null;
}

export function captureBlockReadingAnchor(
  container: HTMLElement,
  eventAnchor: HTMLElement,
): BlockReadingAnchor | null {
  const viewport = readingViewport(container);
  if (!viewport || !container.contains(eventAnchor)) {
    return null;
  }
  let partial: BlockReadingAnchor | null = null;
  for (const [index, block] of readingBlocks(eventAnchor).entries()) {
    const rect = blockRect(block);
    if (
      !rect ||
      rect.bottom <= viewport.top ||
      rect.top >= viewport.bottom ||
      rect.right <= viewport.left ||
      rect.left >= viewport.right
    ) {
      continue;
    }
    const anchor = {
      index,
      tagName: block.tagName,
      viewportOffsetTop: rect.top - viewport.top,
    };
    if (rect.top >= viewport.top) {
      return anchor;
    }
    partial ??= anchor;
  }
  return partial;
}

export function measureBlockReadingAnchor(
  container: HTMLElement,
  eventAnchor: HTMLElement,
  anchor: BlockReadingAnchor,
): number | null {
  const viewport = readingViewport(container);
  if (!viewport || !container.contains(eventAnchor)) {
    return null;
  }
  const block = readingBlocks(eventAnchor)[anchor.index];
  if (!block || block.tagName !== anchor.tagName) {
    return null;
  }
  const rect = blockRect(block);
  return rect ? rect.top - viewport.top : null;
}
