import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import { findWorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  WORKFLOW_RECOMMENDATIONS,
  type WorkflowRecommendation,
} from "../../signals/okou-page/composer-workflow-recommendations.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  ComposerRail,
  RAIL_TILE,
  RAIL_TILE_CAPTION,
} from "./composer-rail.tsx";
import { WorkflowCover } from "./workflow-cover.tsx";
import { localizedWorkflowTemplate } from "./workflow-template-copy.ts";
import { WorkflowResultPreview } from "./workflow-result-preview.tsx";

const DETAIL_ORDER = ["one", "two", "three"] as const;

function WorkflowConnectors({
  item,
}: {
  readonly item: WorkflowRecommendation;
}) {
  const connectors = useLastResolved(connectorCatalogStatus$)?.connectors;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
      {item.connectors.map((slug) => {
        const connector = connectors?.find((candidate) => {
          return candidate.slug === slug;
        });
        return connector ? (
          <span key={slug} className="inline-flex items-center gap-1">
            <ConnectorIcon icon={connector.icon} size={12} />
            <span>{connector.label}</span>
          </span>
        ) : null;
      })}
    </span>
  );
}

/**
 * One cover on the shelf, the same tile every other type's shelf carries: the
 * art in its own box, one line of caption under it. The description, the
 * connector names and the steps live in the dialog the tile opens.
 */
function WorkflowTile({
  item,
  onSelect,
}: {
  readonly item: WorkflowRecommendation;
  readonly onSelect: (item: WorkflowRecommendation) => void;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.items;
    },
    {
      returnObjects: true,
    },
  )[item.id];
  return (
    <Button
      type="button"
      variant="quiet"
      data-slot="workflow-recommendation-tile"
      className={cn(RAIL_TILE, "w-[200px]")}
      onClick={() => {
        onSelect(item);
      }}
    >
      <span className="block aspect-video overflow-hidden rounded-xl border border-border bg-muted">
        <WorkflowCover item={item} />
      </span>
      <span className={RAIL_TILE_CAPTION} title={copy.title}>
        {copy.title}
      </span>
    </Button>
  );
}

function useWorkflowActions(signals: ComposerSignals) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows.items;
    },
    { returnObjects: true },
  );
  const view = useGet(signals.taskChips.workflows.view$);
  const context = useGet(signals.taskChips.workflows.context$);
  const prepareWorkflow = useSet(signals.taskChips.workflows.use$);
  const pageSignal = useGet(pageSignal$);
  return () => {
    const item = WORKFLOW_RECOMMENDATIONS.find((candidate) => {
      return candidate.id === view;
    });
    if (!item) {
      return;
    }
    const template = item.templateId
      ? localizedWorkflowTemplate(findWorkflowTemplateItem(item.templateId)!)
      : null;
    const preference = context.trim();
    const prompt = preference
      ? `${copy[item.id].prompt}\n\n${t(
          ($) => {
            return $.chat.taskChips.workflows.contextPrefix;
          },
          { preference },
        )}`
      : copy[item.id].prompt;
    detach(
      prepareWorkflow({ template, prompt }, pageSignal),
      Reason.DomCallback,
    );
  };
}

function WorkflowDetailNavigation({
  signals,
  item,
}: {
  readonly signals: ComposerSignals;
  readonly item: WorkflowRecommendation;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows;
    },
    { returnObjects: true },
  );
  const open = useSet(signals.taskChips.workflows.open$);
  const browse = useSet(signals.taskChips.workflows.browse$);
  const move = (offset: number) => {
    const index = WORKFLOW_RECOMMENDATIONS.findIndex((candidate) => {
      return candidate.id === item.id;
    });
    open(
      WORKFLOW_RECOMMENDATIONS[
        (index + offset + WORKFLOW_RECOMMENDATIONS.length) %
          WORKFLOW_RECOMMENDATIONS.length
      ]!.id,
    );
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        variant="quiet"
        size="xs"
        onClick={browse}
        className="gap-1.5 font-normal"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {copy.back}
      </Button>
      <div className="flex gap-1">
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={copy.previous}
          onClick={() => {
            move(-1);
          }}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={copy.next}
          onClick={() => {
            move(1);
          }}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function WorkflowSteps({ item }: { readonly item: WorkflowRecommendation }) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows;
    },
    { returnObjects: true },
  );
  const detail = copy.items[item.id];
  return (
    <div className="space-y-5">
      <WorkflowResultPreview id={item.id} />
      <div className="space-y-3">
        <h3 className="text-xs font-medium">{copy.whatHappens}</h3>
        <ol className="space-y-3">
          {DETAIL_ORDER.map((key, index) => {
            return (
              <li
                key={key}
                className="flex items-start gap-2.5 text-xs leading-5 text-muted-foreground"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-foreground">
                  {index + 1}
                </span>
                <span>{detail.steps[key]}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {copy.ownSources}
      </p>
    </div>
  );
}

function WorkflowResults({ item }: { readonly item: WorkflowRecommendation }) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows;
    },
    { returnObjects: true },
  );
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium">{copy.whatYouGet}</h3>
      <ul className="space-y-2">
        {DETAIL_ORDER.map((key) => {
          return (
            <li
              key={key}
              className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
            >
              <Check
                className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
              <span>{copy.items[item.id].results[key]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WorkflowDetail({
  signals,
  item,
  onUse,
}: {
  readonly signals: ComposerSignals;
  readonly item: WorkflowRecommendation;
  readonly onUse: () => void;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows;
    },
    { returnObjects: true },
  );
  const detail = copy.items[item.id];
  const context = useGet(signals.taskChips.workflows.context$);
  const setContext = useSet(signals.taskChips.workflows.setContext$);
  return (
    <div className="space-y-4 pb-2">
      <WorkflowDetailNavigation signals={signals} item={item} />
      <div className="grid gap-6 md:grid-cols-2">
        <WorkflowSteps item={item} />
        <div className="flex min-w-0 flex-col gap-5">
          <h2 className="text-xl font-medium leading-7">{detail.title}</h2>
          <WorkflowResults item={item} />
          <div className="space-y-2">
            <h3 className="text-xs font-medium">{copy.worksWith}</h3>
            <WorkflowConnectors item={item} />
            <p className="text-[11px] leading-4 text-muted-foreground">
              {detail.scope}
            </p>
          </div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden />
            {detail.cadence}
          </p>
          <div className="space-y-2">
            <label
              htmlFor="workflow-recommendation-context"
              className="text-xs font-medium"
            >
              {copy.tailor}
            </label>
            <Textarea
              id="workflow-recommendation-context"
              value={context}
              onChange={(event) => {
                setContext(event.target.value);
              }}
              placeholder={copy.placeholder}
              rows={3}
              className="resize-none text-xs"
            />
          </div>
          <div className="mt-auto space-y-2">
            <Button className="w-full gap-2" onClick={onUse}>
              {copy.use}
              <ArrowRight className="size-4" aria-hidden />
            </Button>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {detail.next}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkflowDialog({ signals }: { readonly signals: ComposerSignals }) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows;
    },
    { returnObjects: true },
  );
  const view = useGet(signals.taskChips.workflows.view$);
  const close = useSet(signals.taskChips.workflows.close$);
  const useWorkflow = useWorkflowActions(signals);
  const onCloseComplete = useSet(signals.taskChips.workflows.completeClose$);
  const item = WORKFLOW_RECOMMENDATIONS.find((candidate) => {
    return candidate.id === view;
  });
  return (
    <Dialog
      open={view !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          close();
        }
      }}
      onOpenChangeComplete={onCloseComplete}
    >
      <DialogContent maxWidth="4xl" closeLabel={copy.close}>
        <DialogHeader className="pr-10">
          <DialogTitle>{item && copy.items[item.id].name}</DialogTitle>
          <DialogDescription>
            {item && copy.items[item.id].description}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {item && (
            <WorkflowDetail signals={signals} item={item} onUse={useWorkflow} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Workflow shelf: the same header line, rail and cover metrics as every
 * other type's shelf, so the tab stops being the one panel laid out as a grid.
 * All nine recommendations ride one rail; the pagers move it.
 */
export function ComposerWorkflowRecommendations({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows;
    },
    { returnObjects: true },
  );
  const label = t(($) => {
    return $.chat.taskChips.shelf.workflows;
  });
  const open = useSet(signals.taskChips.workflows.open$);
  const browse = useSet(signals.taskChips.workflows.browse$);
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-base font-medium">{label}</p>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="shrink-0 gap-1.5 font-normal"
          onClick={browse}
        >
          {copy.browse}
          <ArrowRight className="size-3" aria-hidden />
        </Button>
      </div>
      <ComposerRail
        signals={signals}
        rail="templates:workflow"
        gap="gap-3"
        items={WORKFLOW_RECOMMENDATIONS.map((item) => {
          return (
            <WorkflowTile
              key={item.id}
              item={item}
              onSelect={() => {
                open(item.id);
              }}
            />
          );
        })}
      />
      <WorkflowDialog signals={signals} />
    </div>
  );
}
