import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Sparkles } from "lucide-react";
import type { HomeTaskRecommendation } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { surfaceVariants } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import {
  homeTaskRecommendations$,
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
        <RecommendationConnectors slugs={recommendation.connectors} />
        <ArrowRight
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </span>
    </button>
  );
}

/**
 * The personalized task row on the agent home page.
 *
 * It renders nothing at all when there is nothing to recommend. A heading over
 * an empty row would promise the member a suggestion the evidence did not
 * support, and the page already has its own starting points below.
 */
export function HomeTaskRecommendations({
  agentId,
}: {
  readonly agentId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const start = useSet(startHomeTaskRecommendation$);
  const recommendations = useLastResolved(homeTaskRecommendations$);

  if (!recommendations || recommendations.length === 0 || !agentId) {
    return null;
  }

  const handleStart = (recommendation: HomeTaskRecommendation) => {
    detach(
      start({ agentId, prompt: recommendation.prompt }, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <section
      data-testid="home-task-recommendations"
      className="flex w-full flex-col gap-2"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        {t(($) => {
          return $.chat.homeTasks.heading;
        })}
      </h3>
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {recommendations.map((recommendation) => {
          return (
            <RecommendationCard
              key={recommendation.id}
              recommendation={recommendation}
              onStart={handleStart}
            />
          );
        })}
      </div>
    </section>
  );
}
