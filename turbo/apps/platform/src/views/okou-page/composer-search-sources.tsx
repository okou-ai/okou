import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "@okouai/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import { Switch } from "@okouai/ui/components/ui/switch";
import { dataRouterFamilyText } from "@okouai/api-contracts/contracts/data-router-tools";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import {
  composerSearchSources$,
  startComposerSearchSources$,
  type ComposerSearchSourcesSettings,
  type ComposerSearchSource,
  type ComposerSearchDataFamily,
} from "../../signals/okou-page/composer-search-sources.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function SourcesLoadStatus({ failed = false }: { readonly failed?: boolean }) {
  const { t } = useTranslation();
  return (
    <p
      role={failed ? "alert" : "status"}
      className={
        failed
          ? "text-xs leading-4.5 text-destructive"
          : "text-xs leading-4.5 text-muted-foreground"
      }
    >
      {t(($) => {
        return failed
          ? $.settings.paidTools.loadError
          : $.settings.paidTools.loading;
      })}
    </p>
  );
}

function SourceRow({
  tool,
  title,
  description,
}: {
  readonly tool: ComposerSearchSource | ComposerSearchDataFamily;
  readonly title: string;
  readonly description: string;
}) {
  const { t } = useTranslation();
  const enabled = useLastLoadable(tool.enabled$);
  const save = useLoadable(tool.save$);
  const update = useSet(tool.update$);
  const signal = useGet(pageSignal$);
  const pending = save.state === "loading";
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13px] font-normal leading-5 text-foreground">
          {title}
        </p>
        <p className="text-xs leading-4.5 text-muted-foreground">
          {description}
        </p>
        {pending && (
          <p
            role="status"
            className="text-xs leading-4.5 text-muted-foreground"
          >
            {t(($) => {
              return $.settings.paidTools.saving;
            })}
          </p>
        )}
        {save.state === "hasError" && (
          <p role="alert" className="text-xs leading-4.5 text-destructive">
            {t(($) => {
              return $.settings.paidTools.saveError;
            })}
          </p>
        )}
        {enabled.state !== "hasData" && !pending && (
          <SourcesLoadStatus failed={enabled.state === "hasError"} />
        )}
      </div>
      <Switch
        size="compact"
        aria-label={title}
        checked={enabled.state === "hasData" && enabled.data}
        disabled={enabled.state !== "hasData" || pending || signal.aborted}
        onCheckedChange={(checked) => {
          if (
            enabled.state === "hasData" &&
            checked !== enabled.data &&
            !pending &&
            !signal.aborted
          ) {
            detach(update(checked, signal), Reason.DomCallback);
          }
        }}
      />
    </div>
  );
}

function DataFamilyRow({ tool }: { readonly tool: ComposerSearchDataFamily }) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <SourceRow
      tool={tool}
      title={dataRouterFamilyText(tool.family.title, locale, tool.family.id)}
      description={dataRouterFamilyText(
        tool.family.description,
        locale,
        tool.family.id,
      )}
    />
  );
}

function SourceRows({
  sources,
}: {
  readonly sources: ComposerSearchSourcesSettings;
}) {
  const { t } = useTranslation();
  const families = useLoadable(sources.dataFamilies$);
  return (
    <div className="divide-y divide-border">
      <SourceRow
        tool={sources.webSearch}
        title={t(($) => {
          return $.settings.paidTools.tools["web-search"].name;
        })}
        description={t(($) => {
          return $.settings.paidTools.tools["web-search"].description;
        })}
      />
      {families.state === "hasData" ? (
        families.data.map((tool) => {
          return <DataFamilyRow key={tool.toolId} tool={tool} />;
        })
      ) : (
        <div className="py-2.5">
          <SourcesLoadStatus failed={families.state === "hasError"} />
        </div>
      )}
    </div>
  );
}

function SourcesContent() {
  const sources = useLoadable(composerSearchSources$);
  if (sources.state !== "hasData" || !sources.data) {
    return <SourcesLoadStatus failed={sources.state !== "loading"} />;
  }
  return <SourceRows key={sources.data.key} sources={sources.data} />;
}

function SearchSourcesPopover() {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const startDiscovery = useSet(startComposerSearchSources$);
  const trigger = t(($) => {
    return $.chat.homeDiscovery.sources.trigger;
  });
  return (
    <Popover
      onOpenChange={(open) => {
        if (open && !signal.aborted) {
          detach(startDiscovery(signal), Reason.DomCallback);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            className="h-8 w-auto shrink-0 gap-1 border border-transparent bg-transparent px-2 text-xs font-normal hover:text-muted-foreground [&_svg]:size-3"
          />
        }
      >
        <span>{trigger}</span>
        <ChevronDown className="opacity-50" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label={trigger}
        className="max-h-[var(--available-height)] w-88 max-w-[var(--available-width)] overflow-y-auto"
      >
        <SourcesContent />
      </PopoverContent>
    </Popover>
  );
}

/** The homepage owns visibility; an identity change also dismisses this panel. */
export function ComposerSearchSources() {
  const identity = useGet(authenticatedSessionKey$);
  return <SearchSourcesPopover key={identity} />;
}
