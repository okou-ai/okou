import MarkdownIt from "markdown-it";

/** Shared server-side parsing policy; presentation belongs to each consumer. */
export function createSafeMarkdownRenderer(): MarkdownIt {
  return new MarkdownIt({
    html: false,
    breaks: false,
    linkify: false,
    typographer: false,
  });
}
