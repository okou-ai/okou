// Noto Sans CJK does not cover the Unicode superscript/subscript block.
// Keep those characters intact and use the complete Noto Sans font for them.
export const PDF_SCRIPT_CHAR = /[\u00B2\u00B3\u00B9\u2070-\u209F]/u;
