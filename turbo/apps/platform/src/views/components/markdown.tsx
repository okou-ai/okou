import { cn } from "@okouai/ui";
import type { Root } from "hast";
import type { CSSProperties } from "react";

import {
  createPlainMarkdownTree,
  plainTextFromMarkdownTree,
} from "../../lib/markdown/plain-markdown.ts";
import { MarkdownTextWithColorPreviews } from "./markdown-color-preview.tsx";
import { MarkdownFrame } from "./markdown-frame.tsx";
import {
  Markdown as RichMarkdown,
  MarkdownEventBody as RichMarkdownEventBody,
} from "./rich-markdown.tsx";

/**
 * The Markdown treatment a chat bubble asks for: 8px block spacing so the
 * bubble's 15px text does not read cramped, and no horizontal rules.
 *
 * Every declaration is important because its competitors are unlayered rules
 * that a utility in `@layer utilities` cannot outrank — the App's own
 * `.wmde-markdown p` spacing for the paragraphs, and the vendored
 * `.wmde-markdown > *:first-child` / `:last-child` resets, which are themselves
 * important. Stating those two at the same tier is what keeps the frame's own
 * edge paragraphs flush. The card slot carries its own `my-1.5`, which this
 * important declaration outranks from inside the same layer.
 *
 * A quote's own edges are padding, not margin. A blockquote here declares no
 * block padding and no block border, so an inner paragraph's margin collapses
 * straight out through the quote's edges: it never appears inside the quote and
 * instead leaks space at the frame's own top and bottom. The blockquote pair
 * flushes those inner margins and `py-2` puts the bubble's 8px where a quote
 * actually shows it. See vm0-ai/vm0#34278.
 *
 * The card slot keeps the message's block spacing. `data-markdown-ui` marks
 * embedded UI so descendant rules leave its paragraphs, quotes, and rules to
 * the owning component. `:where` keeps those exclusions from outranking the
 * frame's first/last-child spacing resets.
 */
const CHAT_BUBBLE_MARKDOWN_CLASS =
  "[&_:is(p,[data-slot=markdown-card]):not(:where([data-markdown-ui]_*))]:my-2! [&>*:first-child]:mt-0! [&>*:last-child]:mb-0! [&_blockquote:not(:where([data-markdown-ui]_*))]:py-2! [&_blockquote:not(:where([data-markdown-ui]_*))>*:first-child]:mt-0! [&_blockquote:not(:where([data-markdown-ui]_*))>*:last-child]:mb-0! [&_hr:not(:where([data-markdown-ui]_*))]:hidden";

interface MarkdownProps {
  readonly source: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
  readonly escapeHtml?: boolean;
}

function PlainMarkdown({
  text,
  className,
  style,
}: {
  readonly text: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <MarkdownFrame className={className} style={style}>
      {text === "" ? null : (
        <p className="m-0">
          <MarkdownTextWithColorPreviews text={text} />
        </p>
      )}
    </MarkdownFrame>
  );
}

function RichContentLoading({
  className,
  style,
}: {
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <MarkdownFrame className={className} style={style}>
      <span
        aria-hidden="true"
        data-testid="rich-content-loading"
        className="block h-5 w-24 max-w-full animate-pulse rounded bg-muted/60"
      />
    </MarkdownFrame>
  );
}

/** Renders prepared plain trees immediately and rich trees synchronously. */
export function MarkdownEventBody({
  chatBubble = false,
  className,
  tree,
  mediaPreview,
}: {
  /** Opt into the chat bubble treatment described above. */
  readonly chatBubble?: boolean;
  readonly className?: string;
  readonly tree: Root | undefined;
  readonly mediaPreview: boolean | "link";
}) {
  const frameClassName = cn(
    "text-[length:inherit]! leading-[inherit]!",
    chatBubble && CHAT_BUBBLE_MARKDOWN_CLASS,
    className,
  );
  if (tree === undefined) {
    return <RichContentLoading className={frameClassName} />;
  }
  const plainText = plainTextFromMarkdownTree(tree);
  if (plainText !== null) {
    return <PlainMarkdown className={frameClassName} text={plainText} />;
  }
  return (
    <RichMarkdownEventBody
      className={frameClassName}
      tree={tree}
      mediaPreview={mediaPreview}
    />
  );
}

/** One-off Markdown entry point. */
export function Markdown({
  mediaPreview = false,
  escapeHtml = false,
  ...props
}: MarkdownProps) {
  const tree = createPlainMarkdownTree(props.source, { mathEnabled: false });
  if (tree !== null && !escapeHtml) {
    return (
      <PlainMarkdown
        text={plainTextFromMarkdownTree(tree) ?? ""}
        className={props.className}
        style={props.style}
      />
    );
  }
  return (
    <RichMarkdown
      {...props}
      mediaPreview={mediaPreview}
      escapeHtml={escapeHtml}
    />
  );
}
