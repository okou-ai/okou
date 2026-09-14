import { withChatScrollLayout } from "./chat-scroll-layout.tsx";
import { CopyButton } from "@okouai/ui";
import { useLoadable, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MermaidDiagramSignals } from "../../signals/mermaid-diagram.ts";
import { openImageLightbox$ } from "../../signals/okou-page/attachment-chips.ts";
import { IconTooltipButton } from "./icon-tooltip.tsx";

function MermaidCodeBlock({ signals }: { signals: MermaidDiagramSignals }) {
  return (
    <pre>
      <code className="language-mermaid">{signals.code}</code>
      <CopyButton
        type="button"
        text={signals.code}
        showTooltip={false}
        className="copied"
        data-code={signals.code}
      />
    </pre>
  );
}

/**
 * Renders a ```mermaid fenced block as a diagram from its signals.
 *
 * A fence has exactly two presentations: a diagram when the mermaid parser
 * accepts the source, and an ordinary code block when it does not — the same
 * markup any other fence renders as, copy button included. While the diagram
 * is rendering, a box whose size is reserved up front holds its place, so the
 * render cannot move the thread under a reader. The SVG is letterboxed inside
 * that box and opens at full size in the lightbox.
 */
export function MermaidDiagramView({
  signals,
}: {
  signals: MermaidDiagramSignals;
}) {
  const { t } = useTranslation();
  const openImageLightbox = useSet(openImageLightbox$);
  const loadable = useLoadable(signals.diagram$);
  const image = loadable.state === "hasData" ? loadable.data : null;

  if (loadable.state !== "loading" && image === null) {
    return withChatScrollLayout(<MermaidCodeBlock signals={signals} />);
  }

  return withChatScrollLayout(
    <div
      className="mb-4"
      data-mermaid-status={image ? "rendered" : "rendering"}
    >
      <IconTooltipButton
        type="button"
        // The box is reserved at this size before the render starts, so every
        // diagram in a thread is the same height and none of them changes the
        // height of the message it sits in once it appears. Below the max width
        // the box keeps its ratio, so diagrams stay equally tall as the column
        // narrows — hence the same three utilities on the tooltip trigger,
        // which wraps this button while the diagram is still rendering.
        //
        // `border-[1px]` names the width on purpose: the retired rule drew a
        // 1px edge, and the shared `border` hairline token is 0.5px.
        className="relative block w-full max-w-[420px] aspect-4/3 my-1 p-2 border-[1px] border-[hsl(var(--foreground)/0.1)] rounded-lg bg-[hsl(var(--muted)/0.3)] overflow-hidden cursor-zoom-in disabled:cursor-default"
        wrapperClassName="block w-full max-w-[420px]"
        disabled={image === null}
        aria-label={t(($) => {
          return $.shared.mermaid.expand;
        })}
        onClick={() => {
          if (image === null) {
            return;
          }
          // File metadata lets each preview surface present the diagram as
          // diagram.svg with download support.
          openImageLightbox({
            url: image.url,
            file: image.file,
            shareAvailable: false,
          });
        }}
      >
        {image ? (
          <img
            src={image.url}
            alt={t(($) => {
              return $.shared.mermaid.diagramLabel;
            })}
            // An absolutely positioned <img> whose width and height are `auto`
            // is laid out at its own intrinsic size, so the inset alone leaves
            // the diagram at lightbox scale and `object-fit` has nothing to fit
            // into. The size is therefore stated: `calc` rather than `100%`,
            // since a percentage resolves against the padding box, which the
            // box's own padding would not clear.
            //
            // github-markdown-css paints every image on an opaque canvas
            // colour from an unlayered rule, which a utility cannot outrank, so
            // the transparent fill is important the way the retired rule's
            // source order was.
            className="absolute inset-2 w-[calc(100%-16px)] h-[calc(100%-16px)] object-contain bg-transparent!"
          />
        ) : (
          <span
            className="absolute inset-2 flex items-center justify-center text-muted-foreground"
            aria-hidden="true"
          >
            <Loader2 size={18} className="animate-spin" />
          </span>
        )}
      </IconTooltipButton>
      <details data-slot="mermaid-diagram-source">
        <summary className="cursor-pointer text-muted-foreground text-[0.8125rem]">
          {t(($) => {
            return $.shared.mermaid.viewSource;
          })}
        </summary>
        {/* The Markdown adapter gives every `pre` a 14px block margin from an
            unlayered rule, so the tighter gap under the summary has to be
            important rather than merely more specific. */}
        <pre className="mt-2!">
          <code>{signals.code}</code>
        </pre>
      </details>
    </div>,
  );
}
