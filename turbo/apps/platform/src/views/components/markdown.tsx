import { cn } from "@okouai/ui";
import type { Root } from "hast";
import type { CSSProperties } from "react";

import { i18n } from "../../i18n/index.ts";
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
 * important and which the retired rule therefore lost to. Reproducing those two
 * at the same tier is what keeps the frame's own edge paragraphs flush. The
 * card slot now carries its own `my-1.5`, which this important declaration
 * outranks from inside the same layer.
 *
 * A quote's own edges are padding, not margin. The blockquote pair keeps the
 * inner paragraphs' margins from collapsing out through a quote that declares
 * no block padding and no block border: before #34076 the retired rule's 8px
 * escaped that way and pushed the whole quote off the frame's own
 * `> *:first-child` reset, while never once appearing inside the quote —
 * measured 0px of inset on both sides of that change. `py-2` puts the bubble's
 * 8px where a quote actually shows it. See vm0-ai/vm0#34278.
 *
 * The card slot is addressed through `data-slot` rather than its class. That
 * started as the shrink-only rule against naming a legacy class inside an
 * arbitrary variant; the class has since been drained, so the slot is the only
 * handle the element has.
 */
const CHAT_BUBBLE_MARKDOWN_CLASS =
  "[&_:is(p,[data-slot=markdown-card])]:my-2! [&>*:first-child]:mt-0! [&>*:last-child]:mb-0! [&_blockquote]:py-2! [&_blockquote>*:first-child]:mt-0! [&_blockquote>*:last-child]:mb-0! [&_hr]:hidden";

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

function RichContentError({
  className,
  onRetry,
  style,
}: {
  readonly className?: string;
  readonly onRetry: () => void;
  readonly style?: CSSProperties;
}) {
  return (
    <MarkdownFrame className={className} style={style}>
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        onClick={onRetry}
      >
        {i18n.t(($) => {
          return $.chat.errors.recovery.tryAgain;
        })}
      </button>
    </MarkdownFrame>
  );
}

/** Renders prepared plain trees immediately and rich trees synchronously. */
export function MarkdownEventBody({
  chatBubble = false,
  className,
  onRetry,
  tree,
  mediaPreview,
}: {
  /** Opt into the chat bubble treatment described above. */
  readonly chatBubble?: boolean;
  readonly className?: string;
  readonly onRetry?: () => void;
  readonly tree: Root | undefined;
  readonly mediaPreview: boolean | "link";
}) {
  const frameClassName = chatBubble
    ? cn(CHAT_BUBBLE_MARKDOWN_CLASS, className)
    : className;
  if (tree === undefined) {
    if (onRetry !== undefined) {
      return (
        <RichContentError
          className={frameClassName}
          onRetry={onRetry}
          style={{ fontSize: "inherit", lineHeight: "inherit" }}
        />
      );
    }
    return (
      <RichContentLoading
        className={frameClassName}
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    );
  }
  const plainText = plainTextFromMarkdownTree(tree);
  if (plainText !== null) {
    return (
      <PlainMarkdown
        className={frameClassName}
        text={plainText}
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    );
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
