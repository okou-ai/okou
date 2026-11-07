import { useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Rss, Webhook } from "lucide-react";
import { triggerExampleConnectors$ } from "../../signals/okou-page/composer-trigger-examples.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";

export const TRIGGER_EXAMPLES = [
  { id: "email", source: "Gmail", connector: "gmail", mode: "event" },
  {
    id: "calendar",
    source: "Google Calendar",
    connector: "google-calendar",
    mode: "event",
  },
  { id: "slack", source: "Slack", connector: "slack", mode: "event" },
  { id: "webhook", source: "Webhook", connector: null, mode: "event" },
  { id: "news", source: "RSS", connector: null, mode: "monitor" },
  { id: "social", source: "X", connector: "x", mode: "monitor" },
] as const;

export function TriggerSuggestionCover({
  example,
}: {
  readonly example: (typeof TRIGGER_EXAMPLES)[number];
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.capabilityHome.workflow.triggers;
    },
    { returnObjects: true },
  );
  const steps = copy.items[example.id];
  const connectors = useLastResolved(triggerExampleConnectors$);
  const connector = connectors?.find((item) => {
    return item.slug === example.connector;
  });
  return (
    <span
      className="flex size-full flex-col justify-center bg-card p-3"
      aria-hidden
    >
      <span className="my-auto grid grid-cols-[3rem_minmax(2.5rem,1fr)_minmax(0,1.8fr)] items-start px-2">
        <span className="flex min-w-0 flex-col items-center gap-2">
          <span className="flex size-12 items-center justify-center rounded-lg border border-surface-border bg-card [&>svg]:size-6">
            {example.connector ? (
              <ConnectorIcon icon={connector?.icon} size={26} />
            ) : example.id === "news" ? (
              <Rss className="text-[#ed8b36]" />
            ) : (
              <Webhook className="text-muted-foreground" />
            )}
          </span>
          <span className="w-max max-w-24 truncate text-center text-xs leading-4 text-muted-foreground">
            {steps.event}
          </span>
        </span>
        <span className="flex h-12 items-center text-muted-foreground/60">
          <span className="h-px flex-1 bg-surface-border" />
          <span className="flex gap-1 px-1.5">
            <span className="size-0.5 rounded-full bg-current" />
            <span className="size-0.5 rounded-full bg-current" />
            <span className="size-0.5 rounded-full bg-current" />
          </span>
          <span className="h-px flex-1 bg-surface-border" />
        </span>
        <span className="flex min-h-12 min-w-0 items-center justify-center rounded-lg border border-surface-border bg-card px-2 py-1 text-center text-sm leading-5 text-foreground">
          <span className="truncate">{steps.result}</span>
        </span>
      </span>
    </span>
  );
}
