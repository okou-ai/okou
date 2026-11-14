export interface TextReadingAnchor {
  readonly offset: number;
  readonly contextStart: number;
  readonly contextLength: number;
  readonly contextHash: number;
  readonly viewportOffsetTop: number;
}

const SOURCE_SELECTOR = "[data-chat-selection-source]";
const PROSE_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre";
const EXCLUDED_SELECTOR =
  "[hidden],[inert],button,input,textarea,select,option,optgroup,svg,script,style,noscript,template,iframe,canvas,video,audio,object,embed,summary,details:not([open]),[data-chat-selection-interaction],[role=button],[role=textbox],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=slider],[role=spinbutton],[role=menu],[role=menuitem],[role=toolbar],[role=tooltip]";
const CONTEXT_RADIUS = 64;

interface TextRun {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

interface ProseRun {
  readonly element: Element;
  readonly start: number;
  end: number;
}

interface ReadingText {
  readonly text: string;
  readonly runs: readonly TextRun[];
  readonly blocks: readonly ProseRun[];
}

function isExcluded(element: Element): boolean {
  if (
    element.matches(EXCLUDED_SELECTOR) ||
    element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
    (element.hasAttribute("contenteditable") &&
      element.getAttribute("contenteditable")?.toLowerCase() !== "false")
  ) {
    return true;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.visibility === "collapse" ||
    style?.opacity === "0" ||
    style?.getPropertyValue("content-visibility") === "hidden"
  );
}

function collectReadingText(eventAnchor: HTMLElement): ReadingText {
  const parts: string[] = [];
  const runs: TextRun[] = [];
  const blocks: ProseRun[] = [];
  const sources = eventAnchor.closest(SOURCE_SELECTOR)
    ? [eventAnchor]
    : Array.from(eventAnchor.querySelectorAll(SOURCE_SELECTOR)).filter(
        (source) => {
          const parentSource = source.parentElement?.closest(SOURCE_SELECTOR);
          return !parentSource || !eventAnchor.contains(parentSource);
        },
      );
  // Style reads happen once per traversed element, never once per glyph, and
  // unrelated tool/action subtrees outside selection sources are not traversed.
  const excluded = new Map<Element, boolean>();
  function excludedElement(element: Element): boolean {
    const previous = excluded.get(element);
    if (previous !== undefined) {
      return previous;
    }
    const result = isExcluded(element);
    excluded.set(element, result);
    return result;
  }
  let length = 0;
  for (const root of sources) {
    let hidden = false;
    for (
      let ancestor: Element | null = root;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (excludedElement(ancestor)) {
        hidden = true;
        break;
      }
    }
    if (hidden) {
      continue;
    }
    const walker = eventAnchor.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node instanceof Element) {
            return excludedElement(node)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text) || node.length === 0) {
        continue;
      }
      const source = node.parentElement?.closest(SOURCE_SELECTOR) ?? root;
      const prose = node.parentElement?.closest(PROSE_SELECTOR);
      const element = prose && source.contains(prose) ? prose : source;
      const end = length + node.length;
      runs.push({ node, start: length, end });
      parts.push(node.data);
      // Assign text to its nearest prose block, rather than considering both a
      // blockquote/list item and its nested paragraphs as duplicate candidates.
      const previous = blocks.at(-1);
      if (previous?.element === element) {
        previous.end = end;
      } else {
        blocks.push({ element, start: length, end });
      }
      length = end;
    }
  }
  return { text: parts.join(""), runs, blocks };
}

function codePointEnd(text: string, offset: number): number {
  return offset + ((text.codePointAt(offset) ?? 0) > 0xff_ff ? 2 : 1);
}

function isBoundary(text: string, offset: number): boolean {
  const current = text.charCodeAt(offset);
  const previous = text.charCodeAt(offset - 1);
  return !(
    current >= 0xdc_00 &&
    current <= 0xdf_ff &&
    previous >= 0xd8_00 &&
    previous <= 0xdb_ff
  );
}

function glyphOffsets(text: string, start: number, end: number): number[] {
  const offsets: number[] = [];
  for (let offset = start; offset < end;) {
    const next = codePointEnd(text, offset);
    if (isBoundary(text, offset) && !/^\s+$/u.test(text.slice(offset, next))) {
      offsets.push(offset);
    }
    offset = next;
  }
  return offsets;
}

function textPoint(
  runs: readonly TextRun[],
  offset: number,
  endPoint = false,
): { node: Text; offset: number } | null {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const run = runs[middle];
    if (!run) {
      return null;
    }
    if (endPoint ? run.end < offset : run.end <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const run = runs[low] ?? runs.at(-1);
  return run && offset >= run.start && offset <= run.end
    ? { node: run.node, offset: offset - run.start }
    : null;
}

function glyphRect(reading: ReadingText, offset: number): DOMRect | null {
  const start = textPoint(reading.runs, offset);
  const end = textPoint(reading.runs, codePointEnd(reading.text, offset), true);
  if (!start || !end) {
    return null;
  }
  // A fresh Range also resolves identical text after React replaces its nodes.
  const range = start.node.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return (
    Array.from(range.getClientRects()).find((rect) => {
      return rect.height > 0 && rect.width > 0;
    }) ?? null
  );
}

function readingViewport(container: HTMLElement): DOMRect {
  const rect = container.getBoundingClientRect();
  return new DOMRect(
    rect.left + container.clientLeft,
    rect.top + container.clientTop,
    container.clientWidth,
    container.clientHeight,
  );
}

function fullyVisible(rect: DOMRect, viewport: DOMRect): boolean {
  return (
    rect.top >= viewport.top &&
    rect.bottom <= viewport.bottom &&
    rect.left >= viewport.left &&
    rect.right <= viewport.right
  );
}

function firstVisibleGlyph(
  reading: ReadingText,
  offsets: readonly number[],
  viewport: DOMRect,
): { offset: number; rect: DOMRect } | null {
  // Line tops are monotonic in normal prose flow. Binary search keeps a single
  // enormous paragraph from measuring every offscreen glyph above the reader.
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const offset = offsets[middle];
    const rect = offset === undefined ? null : glyphRect(reading, offset);
    if (!rect) {
      return null;
    }
    if (rect.top < viewport.top) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (let index = low; index < offsets.length; index++) {
    const offset = offsets[index];
    if (offset === undefined) {
      continue;
    }
    const rect = glyphRect(reading, offset);
    if (rect && rect.top >= viewport.bottom) {
      break;
    }
    if (rect && fullyVisible(rect, viewport)) {
      return { offset, rect };
    }
  }
  return null;
}

function contextHash(text: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01_00_01_93);
  }
  return hash >>> 0;
}

function bookmarkForGlyph(
  reading: ReadingText,
  offset: number,
  rect: DOMRect,
  viewport: DOMRect,
): TextReadingAnchor {
  let contextStart = Math.max(0, offset - CONTEXT_RADIUS);
  let contextEnd = Math.min(
    reading.text.length,
    codePointEnd(reading.text, offset) + CONTEXT_RADIUS,
  );
  if (!isBoundary(reading.text, contextStart)) {
    contextStart--;
  }
  if (!isBoundary(reading.text, contextEnd)) {
    contextEnd++;
  }
  return {
    offset,
    contextStart,
    contextLength: contextEnd - contextStart,
    contextHash: contextHash(reading.text.slice(contextStart, contextEnd)),
    viewportOffsetTop: rect.top - viewport.top,
  };
}

/** Captures only offsets and a context fingerprint, never prose or live DOM. */
export function captureTextReadingAnchor(
  container: HTMLElement,
  eventAnchor: HTMLElement,
): TextReadingAnchor | null {
  if (!container.contains(eventAnchor)) {
    return null;
  }
  const viewport = readingViewport(container);
  if (viewport.height <= 0 || viewport.width <= 0) {
    return null;
  }
  const reading = collectReadingText(eventAnchor);
  const visibleBlocks = reading.blocks.filter(({ element }) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  // Prefer a complete paragraph over the clipped tail of the previous one.
  for (const block of visibleBlocks) {
    if (!fullyVisible(block.element.getBoundingClientRect(), viewport)) {
      continue;
    }
    const offset = glyphOffsets(reading.text, block.start, block.end)[0];
    const rect = offset === undefined ? null : glyphRect(reading, offset);
    if (offset !== undefined && rect && fullyVisible(rect, viewport)) {
      return bookmarkForGlyph(reading, offset, rect, viewport);
    }
  }
  for (const block of visibleBlocks) {
    const glyph = firstVisibleGlyph(
      reading,
      glyphOffsets(reading.text, block.start, block.end),
      viewport,
    );
    if (glyph) {
      return bookmarkForGlyph(reading, glyph.offset, glyph.rect, viewport);
    }
  }
  return null;
}

/** Returns the current glyph top relative to the inner scrollport, even offscreen. */
export function measureTextReadingAnchor(
  container: HTMLElement,
  eventAnchor: HTMLElement,
  bookmark: TextReadingAnchor,
): number | null {
  if (!container.contains(eventAnchor)) {
    return null;
  }
  const reading = collectReadingText(eventAnchor);
  const contextEnd = bookmark.contextStart + bookmark.contextLength;
  if (
    !Number.isSafeInteger(bookmark.offset) ||
    !Number.isSafeInteger(bookmark.contextStart) ||
    !Number.isSafeInteger(bookmark.contextLength) ||
    bookmark.offset < 0 ||
    bookmark.offset >= reading.text.length ||
    bookmark.contextStart < 0 ||
    bookmark.contextStart > bookmark.offset ||
    bookmark.contextLength <= 0 ||
    contextEnd > reading.text.length ||
    contextEnd < codePointEnd(reading.text, bookmark.offset) ||
    !isBoundary(reading.text, bookmark.offset) ||
    !isBoundary(reading.text, bookmark.contextStart) ||
    !isBoundary(reading.text, contextEnd) ||
    contextHash(reading.text.slice(bookmark.contextStart, contextEnd)) !==
      bookmark.contextHash
  ) {
    return null;
  }
  const rect = glyphRect(reading, bookmark.offset);
  return rect ? rect.top - readingViewport(container).top : null;
}
