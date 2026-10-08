import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Clock3 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
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

/* What the workflow reads and writes, then how often it runs: one row of
   chips in place of a "Works with" section and a separate cadence line. */
const WORKFLOW_FACT =
  "inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-foreground";

function WorkflowFacts({ item }: { readonly item: WorkflowRecommendation }) {
  const { t } = useTranslation();
  const cadence = t(
    ($) => {
      return $.chat.taskChips.workflows.items;
    },
    { returnObjects: true },
  )[item.id].cadence;
  const connectors = useLastResolved(connectorCatalogStatus$)?.connectors;
  return (
    <ul className="flex min-w-0 flex-wrap gap-2">
      {item.connectors.map((slug) => {
        const connector = connectors?.find((candidate) => {
          return candidate.slug === slug;
        });
        return connector ? (
          <li key={slug} className={WORKFLOW_FACT}>
            <ConnectorIcon icon={connector.icon} size={14} />
            {connector.label}
          </li>
        ) : null;
      })}
      <li className={WORKFLOW_FACT}>
        <Clock3 className="size-3.5 text-muted-foreground" aria-hidden />
        {cadence}
      </li>
    </ul>
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

function WorkflowSteps({ item }: { readonly item: WorkflowRecommendation }) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.workflows;
    },
    { returnObjects: true },
  );
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{copy.whatHappens}</h3>
      <ol className="space-y-2.5">
        {DETAIL_ORDER.map((key, index) => {
          return (
            <li
              key={key}
              className="flex items-start gap-3 text-sm leading-5 text-muted-foreground"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground">
                {index + 1}
              </span>
              <span>{copy.items[item.id].steps[key]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The decision column beside the sample: the name, what the workflow touches,
 * what it does each time, then the optional preference and the two ways out.
 */
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
  const browse = useSet(signals.taskChips.workflows.browse$);
  return (
    <div className="flex min-w-0 flex-col gap-6 p-6 md:p-8">
      <div className="space-y-2 pr-8">
        <DialogTitle className="text-xl leading-7">{detail.name}</DialogTitle>
        <DialogDescription className="leading-5">
          {detail.description}
        </DialogDescription>
      </div>
      <WorkflowFacts item={item} />
      <WorkflowSteps item={item} />
      <div className="space-y-3 pt-1">
        <Textarea
          aria-label={copy.tailor}
          value={context}
          onChange={(event) => {
            setContext(event.target.value);
          }}
          placeholder={copy.tailor}
          rows={2}
          className="resize-none"
        />
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="quiet"
            size="sm"
            onClick={browse}
            className="-ml-3 font-normal"
          >
            {copy.browse}
          </Button>
          <Button className="gap-2" onClick={onUse}>
            {copy.use}
            <ArrowRight className="size-4" aria-hidden />
          </Button>
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
      {/* The sample fills the left column to the dialog's own edges, so the
          popup's radius and clipping frame it; the columns stack below md. */}
      <DialogContent
        maxWidth="4xl"
        closeLabel={copy.close}
        contentClassName="gap-0 p-0 md:grid-cols-[minmax(0,9fr)_minmax(0,11fr)]"
      >
        {item && (
          <>
            <WorkflowResultPreview id={item.id} />
            <WorkflowDetail signals={signals} item={item} onUse={useWorkflow} />
          </>
        )}
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
