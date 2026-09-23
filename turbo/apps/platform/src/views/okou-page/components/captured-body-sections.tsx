import { ChevronRight } from "lucide-react";
import { cn, CopyButton } from "@okouai/ui";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import { useTranslation } from "react-i18next";
import { formatSize, InlineBadge } from "./network-badge.tsx";
import { i18n } from "../../../i18n/index.ts";
import { formatAppNumber } from "../../../i18n/format.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBodyForDisplay(
  body: string,
  encoding: NetworkLogEntry["request_body_encoding"],
): { text: string; isBinary: boolean } {
  if (encoding === "base64") {
    const sizeEstimate = Math.round((body.length * 3) / 4);
    return {
      text: i18n.t(
        ($) => {
          return $.activity.network.capture.binaryData;
        },
        { size: formatSize(sizeEstimate) },
      ),
      isBinary: true,
    };
  }
  return { text: body, isBinary: false };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function TruncationBadge({ truncated }: { truncated: boolean | undefined }) {
  const { t } = useTranslation();
  if (truncated === undefined) {
    return null;
  }
  return (
    <InlineBadge color={truncated ? "warning" : "muted"}>
      {truncated
        ? t(($) => {
            return $.activity.network.capture.truncated;
          })
        : t(($) => {
            return $.activity.network.capture.complete;
          })}
    </InlineBadge>
  );
}

function CollapsibleSection({
  title,
  badge,
  truncated,
  copyText,
  children,
}: {
  title: string;
  badge?: string;
  truncated?: boolean;
  copyText?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative isolate">
      <details className="group">
        <summary
          className={cn(
            "flex min-h-6 items-center gap-2 cursor-pointer list-none w-full text-left rounded-md hover:bg-state-hover",
            copyText && "pr-8",
          )}
        >
          <ChevronRight
            size={14}
            className="transition-transform group-open:rotate-90 shrink-0"
          />
          <span className="text-xs font-medium text-foreground">{title}</span>
          {badge && <InlineBadge color="muted">{badge}</InlineBadge>}
          <TruncationBadge truncated={truncated} />
        </summary>
        <div className="mt-2 ml-5">{children}</div>
      </details>
      {/* The sibling action paints in the reserved header space, including when closed. */}
      {copyText && (
        <CopyButton text={copyText} className="absolute right-0 top-0 p-1" />
      )}
    </div>
  );
}

function HeadersSection({
  title,
  headers,
  truncated,
}: {
  title: string;
  headers: Record<string, string>;
  truncated: boolean | undefined;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(headers);
  const copyText = entries
    .map(([k, v]) => {
      return `${k}: ${v}`;
    })
    .join("\n");

  return (
    <CollapsibleSection
      title={t(
        ($) => {
          return $.activity.network.capture.headersWithCount;
        },
        { title, formattedCount: formatAppNumber(entries.length) },
      )}
      truncated={truncated}
      copyText={copyText}
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {entries.map(([name, value]) => {
          return (
            <div key={name} className="contents">
              <span className="text-muted-foreground font-medium font-mono">
                {name}
              </span>
              <span className="font-mono break-all">{value}</span>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

function BodyBlock({
  title,
  body,
  encoding,
  truncated,
}: {
  title: string;
  body: string;
  encoding: NetworkLogEntry["request_body_encoding"];
  truncated: boolean | undefined;
}) {
  const { text, isBinary } = formatBodyForDisplay(body, encoding);

  return (
    <CollapsibleSection
      title={title}
      badge={encoding}
      truncated={truncated}
      copyText={isBinary ? undefined : body}
    >
      <pre
        className={`rounded-md border bg-muted/50 p-3 text-xs overflow-auto max-h-60 whitespace-pre-wrap break-words font-mono ${
          isBinary ? "text-muted-foreground italic" : ""
        }`}
      >
        {text}
      </pre>
    </CollapsibleSection>
  );
}

function filterHeaders(
  raw: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!raw) {
    return null;
  }
  const filtered = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => {
      return v !== null && v !== undefined;
    }),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function BodyMetadata({
  title,
  encoding,
  truncated,
}: {
  title: string;
  encoding: NetworkLogEntry["request_body_encoding"];
  truncated: boolean | undefined;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="font-medium">{title}</span>
      {encoding && <InlineBadge color="muted">{encoding}</InlineBadge>}
      <TruncationBadge truncated={truncated} />
    </div>
  );
}

export function CapturedBodySections({ entry }: { entry: NetworkLogEntry }) {
  const { t } = useTranslation();
  const requestHeaders = filterHeaders(entry.request_headers);
  const responseHeaders = filterHeaders(entry.response_headers);
  const requestBody = entry.request_body ?? null;
  const responseBody = entry.response_body ?? null;
  const requestBodyMetadata =
    !requestBody &&
    (entry.request_body_encoding !== undefined ||
      entry.request_body_truncated !== undefined);
  const responseBodyMetadata =
    !responseBody &&
    (entry.response_body_encoding !== undefined ||
      entry.response_body_truncated !== undefined);
  const requestHeaderMetadata = entry.request_headers_truncated !== undefined;
  const responseHeaderMetadata = entry.response_headers_truncated !== undefined;

  const hasCaptureData = [
    requestHeaders,
    responseHeaders,
    requestHeaderMetadata,
    responseHeaderMetadata,
    requestBody,
    responseBody,
    requestBodyMetadata,
    responseBodyMetadata,
  ].some(Boolean);

  if (!hasCaptureData) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {(requestHeaders || requestHeaderMetadata) && (
        <HeadersSection
          title={t(($) => {
            return $.activity.network.capture.requestHeaders;
          })}
          headers={requestHeaders ?? {}}
          truncated={entry.request_headers_truncated}
        />
      )}
      {requestBody && (
        <BodyBlock
          title={t(($) => {
            return $.activity.network.capture.requestBody;
          })}
          body={requestBody}
          encoding={entry.request_body_encoding}
          truncated={entry.request_body_truncated}
        />
      )}
      {requestBodyMetadata && (
        <BodyMetadata
          title={t(($) => {
            return $.activity.network.capture.requestBody;
          })}
          encoding={entry.request_body_encoding}
          truncated={entry.request_body_truncated}
        />
      )}
      {(responseHeaders || responseHeaderMetadata) && (
        <HeadersSection
          title={t(($) => {
            return $.activity.network.capture.responseHeaders;
          })}
          headers={responseHeaders ?? {}}
          truncated={entry.response_headers_truncated}
        />
      )}
      {responseBody && (
        <BodyBlock
          title={t(($) => {
            return $.activity.network.capture.responseBody;
          })}
          body={responseBody}
          encoding={entry.response_body_encoding}
          truncated={entry.response_body_truncated}
        />
      )}
      {responseBodyMetadata && (
        <BodyMetadata
          title={t(($) => {
            return $.activity.network.capture.responseBody;
          })}
          encoding={entry.response_body_encoding}
          truncated={entry.response_body_truncated}
        />
      )}
    </div>
  );
}
