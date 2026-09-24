import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Textarea } from "@okouai/ui";
import { Loader2 } from "lucide-react";
import { ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS } from "@okouai/api-contracts/contracts/onboarding";
import {
  ONBOARDING_INDUSTRY_IDS,
  type OnboardingIndustry,
} from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingPromptEdited$,
  captureSourceOnboardingStartClicked$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import { onboardingSourceConnectors$ } from "../../signals/onboarding/onboarding-sources-first-catalog.ts";
import { justConnectedBuiltinSlugs$ } from "../../signals/okou-page/settings/connectors.ts";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import {
  updateSourcesFirstDraft$,
  type SourcesFirstDraft,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { useOnboardingNavigation } from "../onboarding/onboarding-navigation.ts";
import { ONBOARDING_TEXTAREA_CLASS } from "../onboarding/onboarding-shell.tsx";
import {
  pickStartingPromptSource,
  startingPromptFor,
} from "./onboarding-starting-prompt.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

const STARTING_PROMPT_MAX_LENGTH = 1000;
const CELEBRATION_URL =
  "https://static.okou.io/web/assets/onboarding/v3-ready-celebrate_640.png";
const CELEBRATION_2X_URL =
  "https://static.okou.io/web/assets/onboarding/v3-ready-celebrate_1280.png";

function isOnboardingSourceSlug(slug: string): boolean {
  return ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS.some((sourceSlug) => {
    return sourceSlug === slug;
  });
}

function fallbackIndustry(
  industry: OnboardingIndustry | null,
): OnboardingIndustry {
  return (
    industry ?? ONBOARDING_INDUSTRY_IDS[ONBOARDING_INDUSTRY_IDS.length - 1]
  );
}

function StartingPromptPanel({
  isLoading,
  outcome,
  outcomeDetail,
  sourceLabel,
  text,
  onChange,
}: {
  readonly isLoading: boolean;
  readonly outcome: string;
  readonly outcomeDetail: string | null;
  readonly sourceLabel: string | null;
  readonly text: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-8">
      {isLoading ? (
        <div
          className="flex min-h-[148px] flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span>
            {t(($) => {
              return $.onboarding.sourcesFirst.welcome.copy;
            })}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
              {outcome}
            </h2>
            {sourceLabel ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {sourceLabel}
              </span>
            ) : null}
          </div>
          {outcomeDetail ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {outcomeDetail}
            </p>
          ) : null}
          <label className="sr-only" htmlFor="onboarding-starting-prompt">
            {t(($) => {
              return $.onboarding.sourcesFirst.welcome.promptLabel;
            })}
          </label>
          <Textarea
            id="onboarding-starting-prompt"
            className={`mt-3 min-h-[120px] ${ONBOARDING_TEXTAREA_CLASS}`}
            maxLength={STARTING_PROMPT_MAX_LENGTH}
            spellCheck={false}
            value={text}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </>
      )}
    </div>
  );
}

function readyPromptView(
  draft: SourcesFirstDraft,
  fallbackPrompt: ReturnType<typeof startingPromptFor>,
  fallbackPromptKey: string,
  fallbackSourceLabel: string | null,
) {
  const recommendation =
    draft.recommendationStatus === "completed" ? draft.recommendation : null;
  const isLoading =
    recommendation === null &&
    (draft.recommendationStatus === "starting" ||
      draft.recommendationStatus === "pending" ||
      draft.recommendationStatus === "running");
  const recommendationJobId = draft.recommendationJobId;
  if (recommendation !== null && recommendationJobId === null) {
    throw new Error("Completed onboarding recommendation has no job id");
  }
  const promptKey = recommendation
    ? `recommendation:${recommendationJobId}`
    : fallbackPromptKey;
  return {
    isLoading,
    promptKey,
    text:
      draft.startingPromptKey === ""
        ? (recommendation?.prompt ?? fallbackPrompt.text)
        : draft.startingPromptDraft,
    outcome: recommendation?.title ?? fallbackPrompt.outcome,
    outcomeDetail: recommendation?.outcome ?? null,
    sourceLabel: recommendation === null ? fallbackSourceLabel : null,
  };
}

/**
 * The last step: one editable first request, matched from the chosen industry
 * and a connected source. Starting it leaves onboarding.
 */
export function OnboardingReadyPage() {
  const { t } = useTranslation();
  const flow = useSourcesFirstFlow("ready");
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const capturePromptEdited = useSet(captureSourceOnboardingPromptEdited$);
  const captureStartClicked = useSet(captureSourceOnboardingStartClicked$);
  const catalogLoadable = useLastLoadable(onboardingSourceConnectors$);
  const justConnected = useGet(justConnectedBuiltinSlugs$);
  const pageSignal = useGet(pageSignal$);
  const searchParams = useGet(searchParams$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const { runPrompt } = useOnboardingNavigation();

  const connected =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.filter((connector) => {
          return (
            isOnboardingSourceSlug(connector.slug) &&
            (connector.connected || justConnected.has(connector.slug))
          );
        })
      : [];
  const industry = fallbackIndustry(flow.draft.industry);
  const sourceSlug = pickStartingPromptSource(
    industry,
    connected.map((connector) => {
      return connector.slug;
    }),
  );
  const source = connected.find((connector) => {
    return connector.slug === sourceSlug;
  });
  const fallbackPrompt = startingPromptFor(
    t,
    industry,
    source ? { slug: source.slug, name: source.label } : null,
  );
  // Once someone types, their draft owns the text. A recommendation that
  // finishes after the fallback timeout may still update the headline, but it
  // can never replace an edit.
  const { isLoading, promptKey, text, outcome, outcomeDetail, sourceLabel } =
    readyPromptView(
      flow.draft,
      fallbackPrompt,
      `${industry}:${source?.slug ?? "none"}`,
      source?.label ?? null,
    );

  /**
   * Finishing the flow is what marks onboarding complete, so the request goes
   * out before the first prompt: otherwise `needsOnboarding` stays true and the
   * bootstrap guard returns the user here on the next load. A member has no
   * completion of their own to record — the route is admin-only by design — so
   * their run goes straight to the prompt. When completion fails the rejected
   * command keeps the user on this step, with the button ready to try again.
   */
  const completeAndRun = async (request: string): Promise<void> => {
    if (flow.flow === "owner") {
      await complete(
        searchParams.get("redeemCode")?.trim() || null,
        pageSignal,
      );
    }
    runPrompt(request);
  };

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.welcome.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.welcome.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.welcome.start;
      })}
      onPrimary={() => {
        const request = text.trim();
        // The request's length, never the request itself.
        captureStartClicked(request.length);
        detach(completeAndRun(request), Reason.DomCallback);
      }}
      primaryDisabled={isLoading || text.trim().length === 0}
      primaryBusy={completeLoadable.state === "loading"}
      onBack={flow.goBack}
    >
      {/* One column on the step's own sheet: the welcome, then the request it
          starts with. */}
      <div className="mx-auto flex w-full max-w-[520px] flex-col">
        <img
          src={CELEBRATION_URL}
          srcSet={`${CELEBRATION_2X_URL} 2x`}
          alt=""
          className="mx-auto h-40 max-w-full object-contain"
        />
        <StartingPromptPanel
          isLoading={isLoading}
          outcome={outcome}
          outcomeDetail={outcomeDetail}
          sourceLabel={sourceLabel}
          text={text}
          onChange={(value) => {
            updateDraft({
              startingPromptKey: promptKey,
              startingPromptDraft: value,
            });
            capturePromptEdited(value.length);
          }}
        />
      </div>
    </OnboardingStepLayout>
  );
}
