import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Bell, Newspaper, Tag } from "lucide-react";
import { Button, Switch } from "@okouai/ui";
import { PreferenceCardRow } from "./components/settings/preference-card-row.tsx";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  forYouSources$,
  reloadForYouSources$,
  updateForYouSource$,
} from "../../signals/okou-page/for-you-sources.ts";

const SOURCE_ICONS = {
  whatsNew: Newspaper,
  offers: Tag,
  systemUpdates: Bell,
} as const;
const CARD_SOURCES = ["whatsNew", "offers", "systemUpdates"] as const;

export function SourceChoices() {
  const { t } = useTranslation();
  const sources = useLastLoadable(forYouSources$);
  const [saving, update] = useLoadableSet(updateForYouSource$);
  const reload = useSet(reloadForYouSources$);
  const signal = useGet(pageSignal$);
  const labels = t(
    ($) => {
      return $.chat.agentSuggestions.forYou.sources;
    },
    {
      returnObjects: true,
    },
  );
  if (sources.state === "hasError") {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-4 py-4"
      >
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.global.errors.requestFailed;
          })}
        </span>
        <Button
          variant="neutral"
          onClick={() => {
            reload();
          }}
        >
          {t(($) => {
            return $.chat.errors.recovery.tryAgain;
          })}
        </Button>
      </div>
    );
  }
  return CARD_SOURCES.map((source) => {
    const control =
      sources.state === "hasData" ? (
        <Switch
          size="default"
          aria-label={labels[source]}
          checked={sources.data[source]}
          disabled={saving.state === "loading"}
          onCheckedChange={(enabled) => {
            detach(update(source, enabled, signal), Reason.DomCallback);
          }}
        />
      ) : (
        <Skeleton className="h-6 w-11 rounded-full" />
      );
    return (
      <div key={source} className="border-t border-t-gray-400">
        <PreferenceCardRow
          inline
          grouped
          icon={SOURCE_ICONS[source]}
          iconContainerClassName="h-10 w-10 rounded-xl bg-primary/10 text-brand-text"
          title={labels[source]}
          description={t(($) => {
            return $.myOkou.proactiveSettings[source];
          })}
        >
          {control}
        </PreferenceCardRow>
      </div>
    );
  });
}
