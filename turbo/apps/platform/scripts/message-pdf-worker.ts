/** The optional PDF engine is emitted as one separately budgeted worker. */
export const MESSAGE_PDF_WORKER_FILE_PATTERN =
  /^assets\/message-pdf-worker-[^/]+\.js$/u;

// The production-minified engine measures ~2.61 MB; keep headroom explicit
// without charging user-requested PDF rendering to the eager app budget.
export const MESSAGE_PDF_WORKER_LIMIT_BYTES = 3_000_000;

// These resources must share the app origin, including on protected previews.
export const MESSAGE_PDF_FONT_FILE_PATTERN =
  /^assets\/(?:NotoSansCJKsc-(?:Regular|Bold)-[^/]+\.otf|sarasa-gothic-sc-(?:italic|bolditalic)-[^/]+\.ttf|noto-emoji-emoji-400-normal-[^/]+\.woff)$/u;
