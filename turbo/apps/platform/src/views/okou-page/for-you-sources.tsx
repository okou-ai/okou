import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
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
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  forYouSources$,
  reloadForYouSources$,
  updateForYouSource$,
} from "../../signals/okou-page/for-you-sources.ts";

function SourceChoices() {
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
  return (
    <div className="divide-y divide-gray-400">
      {(["suggestions", "whatsNew", "offers", "systemUpdates"] as const).map(
        (source) => {
          return (
            <label
              key={source}
              className="flex cursor-default items-center justify-between gap-6 py-4 text-sm"
            >
              <span>{labels[source]}</span>
              {sources.state === "hasData" ? (
                <Switch
                  size="compact"
                  checked={sources.data[source]}
                  disabled={saving.state === "loading"}
                  onCheckedChange={(enabled) => {
                    detach(update(source, enabled, signal), Reason.DomCallback);
                  }}
                />
              ) : (
                <Skeleton className="h-5 w-9 rounded-full" />
              )}
            </label>
          );
        },
      )}
    </div>
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
