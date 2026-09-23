import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  MessageSquarePlus,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { HomeTaskRecommendation } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { Button, Skeleton, surfaceVariants } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import {
  homeTaskRecommendations$,
  homeTaskRecommendationsEnabled$,
  homeTaskRecommendationsGmailSuspendedAgentId$,
  homeTaskRecommendationsPendingRevision$,
  homeTaskRecommendationsRemovedAgentId$,
  homeTaskRecommendationsRevision$,
  reloadHomeTaskRecommendations$,
  startHomeTaskRecommendation$,
} from "../../signals/okou-page/home-task-recommendations.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";

function RecommendationConnectors({
  slugs,
}: {
  readonly slugs: readonly string[];
}) {
  const connectors = useLastResolved(connectorCatalogStatus$)?.connectors;
  if (slugs.length === 0) {
    return null;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
      {slugs.map((slug) => {
        // A slug the catalog does not know is not drawn. The ranking model is
        // told to use the member's own inventory, and a mark the product
        // cannot name would claim a capability nobody can verify.
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

function RecommendationTarget({
  target,
  purpose,
}: {
  readonly target: HomeTaskRecommendation["target"];
  readonly purpose: HomeTaskRecommendation["purpose"];
}) {
  const { t } = useTranslation();
  if (purpose === "workflow") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <Workflow className="size-3" aria-hidden />
        {t(($) => {
          return $.chat.homeTasks.exploreWorkflow;
        })}
      </span>
    );
  }
  const existing = target.kind === "existing-thread";
  const Icon = existing ? MessageSquareText : MessageSquarePlus;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <Icon className="size-3" aria-hidden />
      {existing
        ? t(($) => {
            return $.chat.homeTasks.existingThread;
          })
        : t(($) => {
            return $.chat.homeTasks.newThread;
          })}
    </span>
  );
}

function RecommendationCard({
  recommendation,
  onStart,
}: {
  readonly recommendation: HomeTaskRecommendation;
  readonly onStart: (recommendation: HomeTaskRecommendation) => void;
}) {
  return (
    <button
      type="button"
      data-slot="home-task-recommendation-card"
      className={cn(
        surfaceVariants({ interactive: true }),
        "group flex min-w-0 flex-col gap-1.5 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={() => {
        onStart(recommendation);
      }}
    >
      <span className="line-clamp-2 text-[13px] font-medium leading-[18px]">
        {recommendation.title}
      </span>
      <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
        {recommendation.rationale}
      </span>
      <span className="mt-auto flex items-center justify-between gap-2 pt-2">
        <span className="flex min-w-0 items-center gap-2">
          <RecommendationTarget
            target={recommendation.target}
            purpose={recommendation.purpose}
          />
          <RecommendationConnectors slugs={recommendation.connectors} />
        </span>
        <ArrowRight
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </span>
    </button>
  );
}

function RecommendationCardSkeleton() {
  return (
    <div
      data-slot="home-task-recommendation-skeleton"
      className={cn(surfaceVariants(), "flex min-h-28 flex-col gap-2 p-3")}
    >
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="mt-auto h-3 w-1/3" />
    </div>
  );
}

/**
 * The personalized task row on the agent home page.
 *
 * Cards remain fixed during a visit. Entry and explicit reload read one
 * completed server snapshot; an Ably push only offers a reload affordance.
 */
export function HomeTaskRecommendations({
  agentId,
}: {
  readonly agentId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const enabled = useGet(homeTaskRecommendationsEnabled$);
  const revision = useGet(homeTaskRecommendationsRevision$);
  const pendingRevision = useGet(homeTaskRecommendationsPendingRevision$);
  const removedAgentId = useGet(homeTaskRecommendationsRemovedAgentId$);
  const gmailSuspendedAgentId = useGet(
    homeTaskRecommendationsGmailSuspendedAgentId$,
  );
  const start = useSet(startHomeTaskRecommendation$);
  const reload = useSet(reloadHomeTaskRecommendations$);
  const loadable = useLoadable(homeTaskRecommendations$);
  const set = useLastResolved(homeTaskRecommendations$);

  if (!enabled || !agentId || removedAgentId === agentId) {
    return null;
  }

  const visibleSet =
    set?.revision === revision && set.agentId === agentId ? set : null;
  const loading = loadable.state === "loading" && visibleSet === null;
  const visibleRecommendations = visibleSet?.recommendations.filter(
    (recommendation) => {
      return (
        gmailSuspendedAgentId !== agentId ||
        !recommendation.connectors.includes("gmail")
      );
    },
  );
  const hasNewTasks =
    pendingRevision?.agentId === agentId &&
    (pendingRevision.revision === undefined ||
      pendingRevision.revision !== visibleSet?.contentRevision);

  const handleStart = (recommendation: HomeTaskRecommendation) => {
    detach(start({ agentId, recommendation }, pageSignal), Reason.DomCallback);
  };
  const handleReload = () => {
    detach(reload(pageSignal), Reason.DomCallback);
  };

  return (
    <section
      data-testid="home-task-recommendations"
      // `order-1` keeps the mobile column greeting, recommendations, starting
      // points, composer: the composer's own `order-3` is what holds it at the
      // bottom within thumb reach, so this section takes the step above the
      // chips rather than sharing theirs. It rides the section and not a
      // wrapper in the page, so that returning null above leaves no flex item
      // behind for the column's `gap` to charge for.
      className="order-1 flex w-full flex-col gap-2 sm:order-none"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="size-3.5" aria-hidden />
          {t(($) => {
            return $.chat.homeTasks.heading;
          })}
        </h3>
        <div className="flex items-center gap-1">
          {hasNewTasks ? (
            <span className="text-[11px] text-muted-foreground">
              {t(($) => {
                return $.chat.homeTasks.newTasksAvailable;
              })}
            </span>
          ) : null}
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            disabled={loading}
            aria-label={t(($) => {
              return $.chat.homeTasks.reload;
            })}
            title={t(($) => {
              return $.chat.homeTasks.reload;
            })}
            onClick={handleReload}
          >
            <RefreshCw aria-hidden />
          </Button>
        </div>
      </div>
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {loading
          ? [0, 1, 2].map((index) => {
              return <RecommendationCardSkeleton key={index} />;
            })
          : visibleRecommendations?.map((recommendation) => {
              return (
                <RecommendationCard
                  key={recommendation.id}
                  recommendation={recommendation}
                  onStart={handleStart}
                />
              );
            })}
      </div>
      {!loading && visibleRecommendations?.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.homeTasks.empty;
          })}
        </p>
      ) : null}
    </section>
  );
}
