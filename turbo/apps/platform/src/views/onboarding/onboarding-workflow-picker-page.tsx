import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Box,
  Briefcase,
  ChartBar,
  CircleCheckBig,
  Code,
  MessageCircle,
  MessageSquarePlus,
  ScanEye,
  Sparkles,
  Megaphone,
  Sun,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Button, cn } from "@okouai/ui";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { useTranslation } from "react-i18next";
import {
  onboardingDraft$,
  onboardingUi$,
  updateOnboardingDraft$,
  updateOnboardingUi$,
} from "../../signals/onboarding/onboarding-state.ts";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import { onboardingWorkflowConnectorsBySlug$ } from "../../signals/onboarding/onboarding-workflow-connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  CUSTOM_WORKFLOW_ID,
  onboardingWorkflowCategories,
  type OnboardingWorkflow,
  type OnboardingWorkflowCategory,
} from "./onboarding-data.ts";
import type { OnboardingWorkflowCategoryId } from "./onboarding-workflow-specs.ts";
import {
  WorkflowConnectorIcon,
  WorkflowPreviewDiagram,
} from "./onboarding-workflow-diagram.tsx";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import {
  OnboardingDialog,
  OnboardingFooter,
  OnboardingShell,
} from "./onboarding-shell.tsx";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { assistantName$ } from "../../signals/branding.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

const CATEGORY_ICONS: Readonly<
  Record<OnboardingWorkflowCategoryId, LucideIcon>
> = {
  engineering: Code,
  product: Box,
  data: ChartBar,
  marketing: Megaphone,
  sales: TrendingUp,
  support: MessageCircle,
  ceo: Briefcase,
  operations: Sun,
  everyone: Sparkles,
};

export function WorkflowConnectorPills({
  connectorSlugs,
}: {
  readonly connectorSlugs: readonly ConnectorSlug[];
}) {
  if (connectorSlugs.length === 0) {
    return null;
  }
  return (
    <span className="flex items-center gap-1.5" aria-hidden="true">
      {connectorSlugs.slice(0, 4).map((connectorSlug) => {
        return (
          <span
            key={connectorSlug}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/30"
          >
            <WorkflowConnectorIcon connectorSlug={connectorSlug} size={14} />
          </span>
        );
      })}
    </span>
  );
}

export function WorkflowPreview({
  workflow,
  onClose,
  onSelect,
}: {
  readonly workflow: OnboardingWorkflow;
  readonly onClose: () => void;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();

  return (
    <OnboardingDialog
      title={workflow.title}
      description={workflow.description}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t(($) => {
              return $.onboarding.common.gotIt;
            })}
          </Button>
          <Button type="button" onClick={onSelect}>
            {t(($) => {
              return $.onboarding.common.selectTemplate;
            })}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1.15fr)_minmax(240px,0.85fr)]">
        <div className="flex min-h-56 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/20 p-6">
          <WorkflowPreviewDiagram workflow={workflow} />
        </div>
        <div className="space-y-5">
          <section>
            <h3 className="text-sm font-semibold">
              {t(($) => {
                return $.onboarding.workflowPreview.whatItDoes;
              })}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {workflow.scenario}
            </p>
          </section>
          <section>
            <h3 className="text-sm font-semibold">
              {t(($) => {
                return $.onboarding.workflowPreview.howItWorks;
              })}
            </h3>
            <ol className="mt-2 space-y-2 text-sm leading-5 text-muted-foreground">
              {workflow.detailSteps.map((step, index) => {
                return (
                  <li key={step.title} className="flex gap-2">
                    <span className="font-medium text-foreground">
                      {index + 1}.
                    </span>
                    <span>
                      <strong className="font-medium text-foreground">
                        {step.title}:{" "}
                      </strong>
                      {step.description}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </div>
    </OnboardingDialog>
  );
}

function WorkflowCard({
  workflow,
  selected,
  onSelect,
  onPreview,
}: {
  readonly workflow: OnboardingWorkflow;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onPreview: () => void;
}) {
  const { t } = useTranslation();

  return (
    <article
      className={cn(
        "relative flex min-h-[143px] min-w-0 flex-col justify-between gap-3.5 rounded-xl border bg-background p-4 text-left shadow-[var(--okou-card-shadow)] transition-colors hover:border-primary",
        selected && "border-primary",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={t(
          ($) => {
            return $.onboarding.workflowPicker.workflowCardLabel;
          },
          {
            description: workflow.description,
            title: workflow.title,
          },
        )}
        className="absolute inset-0 rounded-xl"
        onClick={onSelect}
      />
      <span className="pointer-events-none min-w-0">
        <span className="block truncate pr-5 text-sm font-semibold leading-5">
          {workflow.title}
        </span>
        <span className="mt-1 h-[46px] overflow-hidden text-sm leading-[22.75px] text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {workflow.description}
        </span>
      </span>
      {/* This positioned footer follows the whole-card button, so tree order
          already keeps its controls above that button. */}
      <span className="relative flex items-center gap-3">
        <WorkflowConnectorPills connectorSlugs={workflow.connectorSlugs} />
        <IconTooltipButton
          type="button"
          className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground hover:border-primary/35 hover:bg-gray-50 hover:text-brand-text dark:hover:bg-gray-50/10"
          aria-label={t(($) => {
            return $.onboarding.common.previewWorkflowDetails;
          })}
          onClick={onPreview}
        >
          <ScanEye size={16} aria-hidden="true" />
        </IconTooltipButton>
      </span>
      {selected ? (
        <CircleCheckBig
          size={18}
          className="absolute right-3 top-3 text-brand-text"
          aria-hidden="true"
        />
      ) : null}
    </article>
  );
}

function WorkflowOptions({
  category,
  selectedId,
  onSelect,
  onPreview,
}: {
  readonly category: OnboardingWorkflowCategory;
  readonly selectedId: string;
  readonly onSelect: (workflowId: string) => void;
  readonly onPreview: (workflow: OnboardingWorkflow) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {category.workflows.map((workflow) => {
        return (
          <WorkflowCard
            key={workflow.id}
            workflow={workflow}
            selected={selectedId === workflow.id}
            onSelect={() => {
              onSelect(workflow.id);
            }}
            onPreview={() => {
              onPreview(workflow);
            }}
          />
        );
      })}
      <button
        type="button"
        aria-pressed={selectedId === CUSTOM_WORKFLOW_ID}
        onClick={() => {
          onSelect(CUSTOM_WORKFLOW_ID);
        }}
        className={cn(
          "flex min-h-[143px] flex-col justify-center gap-2 rounded-xl border border-dashed border-border bg-background p-4 text-left text-muted-foreground shadow-[var(--okou-card-shadow)] transition-colors hover:border-primary hover:text-foreground",
          selectedId === CUSTOM_WORKFLOW_ID &&
            "border-solid border-primary text-foreground",
        )}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted/40 text-brand-text">
          <MessageSquarePlus size={19} aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold text-foreground">
          {t(($) => {
            return $.onboarding.workflowPicker.customTitle;
          })}
        </span>
        <span className="text-xs leading-[1.4]">
          {t(($) => {
            return $.onboarding.workflowPicker.customDescription;
          })}
        </span>
      </button>
    </div>
  );
}

function representativeCategoryConnectors(
  category: OnboardingWorkflowCategory,
): readonly ConnectorSlug[] {
  const counts = new Map<
    ConnectorSlug,
    { readonly count: number; readonly firstSeen: number }
  >();
  let nextOrder = 0;
  for (const workflow of category.workflows) {
    for (const connectorSlug of new Set(workflow.connectorSlugs)) {
      const current = counts.get(connectorSlug);
      counts.set(connectorSlug, {
        count: (current?.count ?? 0) + 1,
        firstSeen: current?.firstSeen ?? nextOrder++,
      });
    }
  }
  return [...counts.entries()]
    .sort((left, right) => {
      return (
        right[1].count - left[1].count || left[1].firstSeen - right[1].firstSeen
      );
    })
    .slice(0, 3)
    .map(([connectorSlug]) => {
      return connectorSlug;
    });
}

const CATEGORY_CONNECTOR_TILE_CLASSES = [
  "-right-2.5 top-2.5 rotate-[7deg] opacity-[0.16]",
  "right-6 top-6 -rotate-[5deg] opacity-[0.1]",
  "right-14 top-2 rotate-[3deg] opacity-[0.06]",
] as const;

function CategoryConnectorBackground({
  category,
}: {
  readonly category: OnboardingWorkflowCategory;
}) {
  const connectorsLoadable = useLastLoadable(
    onboardingWorkflowConnectorsBySlug$,
  );
  if (connectorsLoadable.state !== "hasData") {
    return null;
  }
  const connectors = representativeCategoryConnectors(category).flatMap(
    (connectorSlug) => {
      const icon = connectorsLoadable.data.get(connectorSlug)?.icon;
      return icon ? [{ connectorSlug, icon }] : [];
    },
  );
  if (connectors.length === 0) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] [-webkit-mask-image:linear-gradient(to_left,black_58%,transparent_96%)] [mask-image:linear-gradient(to_left,black_58%,transparent_96%)]"
    >
      {connectors.map(({ connectorSlug, icon }, index) => {
        return (
          <span
            key={connectorSlug}
            className={cn(
              "absolute inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/35 bg-gray-50/40 shadow-[0_6px_18px_hsl(220_12%_20%/0.02)] dark:bg-gray-50/[0.06]",
              CATEGORY_CONNECTOR_TILE_CLASSES[index],
            )}
          >
            <ConnectorIcon icon={icon} size={20} />
          </span>
        );
      })}
    </span>
  );
}

function CategoryOptions({
  categories,
  onSelect,
}: {
  readonly categories: readonly OnboardingWorkflowCategory[];
  readonly onSelect: (category: OnboardingWorkflowCategory) => void;
}) {
  return (
    <div className="mt-5 grid grid-cols-2 gap-3.5 sm:grid-cols-3">
      {categories.map((category) => {
        const CategoryIcon = CATEGORY_ICONS[category.id];
        return (
          <button
            key={category.id}
            type="button"
            onClick={() => {
              onSelect(category);
            }}
            className="relative isolate flex min-h-[130px] min-w-0 flex-col items-start overflow-hidden rounded-xl border border-border bg-background p-4 text-left shadow-[var(--okou-card-shadow)] transition-colors hover:border-primary"
          >
            <CategoryConnectorBackground category={category} />
            <span className="relative z-10 flex min-w-0 flex-col items-start gap-2.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-muted/40">
                <CategoryIcon size={21} aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold">{category.title}</span>
              <span className="text-xs leading-[1.35] text-muted-foreground">
                {category.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function findPreviewWorkflow(
  categories: readonly OnboardingWorkflowCategory[],
  workflowId: string | null,
): OnboardingWorkflow | undefined {
  return categories
    .flatMap((category) => {
      return category.workflows;
    })
    .find((workflow) => {
      return workflow.id === workflowId;
    });
}

export function OnboardingWorkflowPickerPage() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const draft = useGet(onboardingDraft$);
  const ui = useGet(onboardingUi$);
  const setDraft = useSet(updateOnboardingDraft$);
  const setUi = useSet(updateOnboardingUi$);
  const searchParams = useGet(searchParams$);
  const pageSignal = useGet(pageSignal$);
  const [, complete] = useLoadableSet(completeOnboarding$);
  const { navigateTo } = useOnboardingNavigation();
  const categories = onboardingWorkflowCategories(t, assistantName);
  const previewWorkflow = findPreviewWorkflow(categories, ui.workflowPreviewId);
  const selectedCategory = categories.find((category) => {
    return category.id === draft.categoryId;
  });
  const selectedWorkflowId = draft.workflowId ?? "";

  const handleBack = (): void => {
    if (selectedCategory) {
      setDraft({ categoryId: null, workflowId: null });
      return;
    }
    navigateTo(ROUTES.onboarding, {
      updates: { choice: "workflow" },
    });
  };

  const handleWorkflowSelect = (workflowId: string): void => {
    setDraft({ workflowId });
    // "Talk to Okou and make my own" skips the customize step and hands the
    // user straight into the product; preset workflows keep the run page.
    if (workflowId === CUSTOM_WORKFLOW_ID) {
      const redeemCode = searchParams.get("redeemCode")?.trim() || null;
      const completeAndOpenHome = async (): Promise<void> => {
        await complete(redeemCode, pageSignal);
        navigateTo(ROUTES.home, { preserve: false, replace: true });
      };
      detach(completeAndOpenHome(), Reason.DomCallback);
      return;
    }
    navigateTo(ROUTES.onboardingWorkflowRun, {
      updates: {
        choice: "workflow",
        category: draft.categoryId,
        workflow: workflowId,
      },
      remove: ["template"],
    });
  };

  return (
    <>
      <OnboardingShell
        currentStep={2}
        totalSteps={3}
        title={
          selectedCategory
            ? t(
                ($) => {
                  return $.onboarding.workflowPicker.categoryTitle;
                },
                { category: selectedCategory.title },
              )
            : t(($) => {
                return $.onboarding.workflowPicker.title;
              })
        }
        description={
          selectedCategory
            ? t(($) => {
                return $.onboarding.workflowPicker.categoryDescription;
              })
            : t(($) => {
                return $.onboarding.workflowPicker.description;
              })
        }
        footer={<OnboardingFooter onBack={handleBack} />}
      >
        {selectedCategory ? (
          <WorkflowOptions
            category={selectedCategory}
            selectedId={selectedWorkflowId}
            onSelect={(workflowId) => {
              handleWorkflowSelect(workflowId);
            }}
            onPreview={(workflow) => {
              setUi({ workflowPreviewId: workflow.id });
            }}
          />
        ) : (
          <CategoryOptions
            categories={categories}
            onSelect={(category) => {
              setDraft({
                categoryId: category.id,
                workflowId: null,
              });
            }}
          />
        )}
      </OnboardingShell>
      {previewWorkflow ? (
        <WorkflowPreview
          workflow={previewWorkflow}
          onClose={() => {
            setUi({ workflowPreviewId: null });
          }}
          onSelect={() => {
            setUi({ workflowPreviewId: null });
            handleWorkflowSelect(previewWorkflow.id);
          }}
        />
      ) : null}
    </>
  );
}
