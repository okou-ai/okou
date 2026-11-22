import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Bell, Newspaper, SlidersHorizontal, Tag } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  IconButton,
  Switch,
} from "@okouai/ui";
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

export function SourceChoices({
  inMyOkou = false,
}: {
  readonly inMyOkou?: boolean;
}) {
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
  const visibleSources = inMyOkou
    ? CARD_SOURCES
    : (["suggestions", ...CARD_SOURCES] as const);
  const rows = visibleSources.map((source) => {
    const control =
      sources.state === "hasData" ? (
        <Switch
          size={inMyOkou ? "default" : "compact"}
          aria-label={inMyOkou ? labels[source] : undefined}
          checked={sources.data[source]}
          disabled={saving.state === "loading"}
          onCheckedChange={(enabled) => {
            detach(update(source, enabled, signal), Reason.DomCallback);
          }}
        />
      ) : (
        <Skeleton
          className={
            inMyOkou ? "h-6 w-11 rounded-full" : "h-5 w-9 rounded-full"
          }
        />
      );
    if (inMyOkou && source !== "suggestions") {
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
    }
    return (
      <label
        key={source}
        className="flex cursor-default items-center justify-between gap-6 py-4 text-sm"
      >
        <span>{labels[source]}</span>
        {control}
      </label>
    );
  });
  return inMyOkou ? (
    <>{rows}</>
  ) : (
    <div className="divide-y divide-gray-400">{rows}</div>
  );
}

export function ForYouSources() {
  const { t } = useTranslation();
  return (
    <Dialog>
      <DialogTrigger
        render={
          <IconButton
            aria-label={t(($) => {
              return $.chat.agentSuggestions.forYou.sources.title;
            })}
          />
        }
      >
        <SlidersHorizontal className="size-4" />
      </DialogTrigger>
      <DialogContent maxWidth="lg" contentClassName="gap-5 p-6 sm:p-7">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.chat.agentSuggestions.forYou.sources.title;
            })}
          </DialogTitle>
        </DialogHeader>
        <SourceChoices />
        <DialogDescription className="border-t border-gray-400 pt-4 text-xs leading-relaxed">
          {t(($) => {
            return $.chat.agentSuggestions.forYou.sources.description;
          })}
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}
