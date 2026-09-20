import { useLastResolved } from "ccstate-react";
import type { ReactNode } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { splitPlainTextUrls } from "../../lib/plain-text-urls.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

/**
 * User-authored text with its plain http(s) URLs made clickable.
 *
 * Text around a URL is emitted unchanged, so literal Markdown, HTML and
 * whitespace keep reading exactly as the author typed them. Links follow the
 * treatment the App stylesheet gives Markdown links, and carry the same
 * `target`/`rel` pair.
 */
export function PlainTextWithLinks({ text }: { text: string }): ReactNode {
  const features = useLastResolved(featureSwitch$);
  if (features?.[FeatureSwitchKey.UserMessageLinks] !== true) {
    return <span>{text}</span>;
  }
  return (
    <>
      {splitPlainTextUrls(text).map((segment, index) => {
        const key = `${String(index)}:${segment.value}`;
        return segment.type === "url" ? (
          <a
            key={key}
            href={segment.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link underline-offset-2 hover:text-link-hover hover:underline"
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
