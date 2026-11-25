// A real layout is required for this measurement. The event can stay mounted
// outside the viewport while the Mermaid card appears in a different page.
export function measureMermaidAtReadingPosition(pane, reading) {
  return pane.evaluate((container, reference) => {
    const diagram = container.querySelector(
      '[data-slot="mermaid-diagram-trigger"]',
    );
    if (!diagram) {
      throw new Error("The transcript has no mounted Mermaid diagram");
    }
    const frame = diagram.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    const event = container.querySelector(
      '[data-chat-scroll-anchor-event-id="' +
        globalThis.CSS.escape(reference.event) +
        '"]',
    );
    let textTop = null;
    let textVisible = false;
    if (event) {
      const walker = globalThis.document.createTreeWalker(
        event,
        globalThis.NodeFilter.SHOW_TEXT,
      );
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (text.textContent === reference.text) {
          const selection = new globalThis.Range();
          selection.selectNodeContents(text);
          const bounds = selection.getBoundingClientRect();
          textTop = bounds.top;
          textVisible =
            bounds.height > 0 &&
            bounds.top >= viewport.top &&
            bounds.bottom <= viewport.bottom;
          break;
        }
      }
    }
    return {
      frame: {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
      },
      state: diagram.closest("[data-mermaid-status]")?.dataset.mermaidStatus,
      event: reference.event,
      textTop,
      textVisible,
      relativeToAnchor: textTop === null ? null : frame.top - textTop,
    };
  }, reading);
}
