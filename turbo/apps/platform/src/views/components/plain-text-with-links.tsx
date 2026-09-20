import type { ReactNode } from "react";

import { splitPlainTextUrls } from "../../lib/plain-text-urls.ts";

/**
 * User-authored text with its plain http(s) URLs made clickable.
 *
 * Text around a URL is emitted unchanged, so literal Markdown, HTML and
 * whitespace keep reading exactly as the author typed them. Links carry the
 * same `target`/`rel` pair as the ones rendered from Agent Markdown.
 */
export function PlainTextWithLinks({ text }: { text: string }): ReactNode {
  const segments = splitPlainTextUrls(text);
  return (
    <>
      {segments.map((segment, index) => {
        const key = `${String(index)}:${segment.value}`;
        return segment.type === "url" ? (
          <a
            key={key}
            href={segment.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link underline underline-offset-2 hover:decoration-2"
          >
            {segment.value}
          </a>
        ) : (
          <span key={key}>{segment.value}</span>
        );
      })}
    </>
  );
}
