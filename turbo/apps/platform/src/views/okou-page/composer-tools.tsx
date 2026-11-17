import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from "@okouai/ui";
import { dataRouterFamilyText } from "@okouai/api-contracts/contracts/data-router-tools";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  composerTools$,
  startComposerToolsDiscovery$,
  type ComposerToolsSettings,
  type ComposerTool,
  type ComposerDataFamily,
} from "../../signals/okou-page/composer-tools.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { getToolCapabilityIcon } from "../components/tool-capability-icons.ts";

function ToolsLoadStatus({ failed = false }: { readonly failed?: boolean }) {
  const { t } = useTranslation();
  return (
    <p
      role={failed ? "alert" : "status"}
      className={
        failed
          ? "py-2 text-xs text-destructive"
          : "py-2 text-xs text-muted-foreground"
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

function ToolRow({
  tool,
  title,
  description,
}: {
  readonly tool: ComposerTool | ComposerDataFamily;
  readonly title: string;
  readonly description: string;
}) {
  const { t } = useTranslation();
  const enabled = useLastLoadable(tool.enabled$);
  const save = useLoadable(tool.save$);
  const update = useSet(tool.update$);
  const signal = useGet(pageSignal$);
  const pending = save.state === "loading";
  const Icon = getToolCapabilityIcon(tool.toolId);
  return (
    <div className="flex items-start gap-3 py-3">
      <Icon
        size={16}
        className="mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        {pending && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(($) => {
              return $.settings.paidTools.saving;
            })}
          </p>
        )}
        {save.state === "hasError" && (
          <p role="alert" className="text-xs text-destructive">
            {t(($) => {
              return $.settings.paidTools.saveError;
            })}
          </p>
        )}
      </div>
      <Switch
        size="sm"
        aria-label={title}
        checked={enabled.state === "hasData" && enabled.data}
        disabled={enabled.state !== "hasData" || pending || signal.aborted}
        onCheckedChange={(checked) => {
          if (enabled.state === "hasData" && !pending) {
            detach(update(checked, signal), Reason.DomCallback);
          }
        }}
      />
    </div>
  );
}

function DataFamilyRow({ tool }: { readonly tool: ComposerDataFamily }) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <ToolRow
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

function ToolsPanel({ children }: { readonly children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      collisionAvoidance={{
        side: "none",
        align: "shift",
        fallbackAxisSide: "none",
      }}
      aria-label={t(($) => {
        return $.settings.paidTools.title;
      })}
      className="max-h-[min(22.5rem,var(--available-height))] w-88 max-w-[var(--available-width)] overflow-y-auto overscroll-contain px-4 py-1"
    >
      {children}
    </PopoverContent>
  );
}

function ToolRows({ tools }: { readonly tools: ComposerToolsSettings }) {
  const { t } = useTranslation();
  // Stay subscribed outside the portal so reopening can retain known rows.
  const families = useLastLoadable(tools.dataFamilies$);
  const disabled = useLastLoadable(tools.webSearch.enabled$);
  return (
    <ToolsPanel>
      {disabled.state !== "hasData" ? (
        <ToolsLoadStatus failed={disabled.state === "hasError"} />
      ) : (
        <div className="divide-y divide-border">
          <ToolRow
            tool={tools.webSearch}
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
            <ToolsLoadStatus failed={families.state === "hasError"} />
          )}
        </div>
      )}
    </ToolsPanel>
  );
}

function ToolsContent() {
  const tools = useLoadable(composerTools$);
  if (tools.state !== "hasData" || !tools.data) {
    return (
      <ToolsPanel>
        <ToolsLoadStatus failed={tools.state === "hasError"} />
      </ToolsPanel>
    );
  }
  return <ToolRows key={tools.data.key} tools={tools.data} />;
}

function ToolsPopover() {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const startDiscovery = useSet(startComposerToolsDiscovery$);
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          detach(startDiscovery(signal), Reason.DomCallback);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="shrink-0 gap-1.5 px-2 text-muted-foreground data-popup-open:bg-state-hover data-popup-open:text-foreground"
          />
        }
      >
        <SlidersHorizontal size={16} aria-hidden />
        {t(($) => {
          return $.settings.dialog.sections.tools.title;
        })}
        <ChevronDown size={12} aria-hidden />
      </PopoverTrigger>
      <ToolsContent />
    </Popover>
  );
}

/** Changing accounts also dismisses the previous member's open tool popup. */
export function ComposerTools({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const identity = useGet(authenticatedSessionKey$);
  const task = useGet(signals.taskChips.home.task$);
  return task === "search" || task === "research" ? (
    <ToolsPopover key={identity} />
  ) : null;
}
