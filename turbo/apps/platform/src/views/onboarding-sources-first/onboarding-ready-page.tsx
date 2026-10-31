import { useGet, useLastLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Textarea, cn, surfaceVariants } from "@okouai/ui";
import { STARTING_PROMPT_MAX_LENGTH } from "../../signals/onboarding/onboarding-output-format.ts";
import { OnboardingOutputFormats } from "./onboarding-output-formats.tsx";
import { Loader2 } from "lucide-react";
import { ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS } from "@okouai/api-contracts/validators/onboarding";
import type { OnboardingRecommendationStatus } from "@okouai/api-contracts/contracts/onboarding";
import {
  ONBOARDING_INDUSTRY_IDS,
  type OnboardingIndustry,
} from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingPromptEdited$,
  captureSourceOnboardingStartClicked$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import { onboardingSourceConnectors$ } from "../../signals/onboarding/onboarding-sources-first-catalog.ts";
import { runOnboardingRequest$ } from "../../signals/onboarding/onboarding-actions.ts";
import { onboardingRecommendation$ } from "../../signals/onboarding/onboarding-recommendation.ts";
import {
  editStartingPrompt$,
  selectStartingPromptOutput$,
  sourcesFirstDraft$,
  type SourcesFirstDraft,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ONBOARDING_TEXTAREA_CLASS } from "../onboarding/onboarding-shell.tsx";
import {
  pickStartingPromptSource,
  startingPromptFor,
} from "./onboarding-starting-prompt.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";
import { useMobileOnboarding } from "../onboarding/use-mobile-onboarding.ts";

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
  promptKey,
  busy,
  onChange,
}: {
  readonly isLoading: boolean;
  readonly outcome: string;
  readonly outcomeDetail: string | null;
  readonly sourceLabel: string | null;
  readonly text: string;
  readonly promptKey: string;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const mobile = useMobileOnboarding();
  const { startingPromptOutput: output } = useGet(sourcesFirstDraft$);
  const selectOutput = useSet(selectStartingPromptOutput$);
  return (
    <div
      className={cn(
        "mt-8",
        mobile && surfaceVariants({ className: "mt-0 p-4" }),
      )}
    >
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
          <div className="flex items-baseline gap-2 max-sm:flex-col max-sm:gap-1">
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
            className={cn(
              "mt-3 field-sizing-content min-h-[120px] max-h-60 max-sm:min-h-48 max-sm:resize-none max-sm:text-base",
              ONBOARDING_TEXTAREA_CLASS,
            )}
            maxLength={
              STARTING_PROMPT_MAX_LENGTH - (output?.suffix.length ?? 0)
            }
            spellCheck={false}
            value={text}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <OnboardingOutputFormats
            output={output?.format ?? null}
            onSelect={(format, instruction) => {
              selectOutput(text, promptKey, format, instruction);
            }}
            isTooLong={(instruction) => {
              return (
                text.length + 2 + instruction.length >
                STARTING_PROMPT_MAX_LENGTH
              );
            }}
            disabled={busy}
          />
        </>
      )}
    </div>
  );
}

function readyPromptView(
  draft: SourcesFirstDraft,
  job: Loadable<OnboardingRecommendationStatus | null>,
  fallbackPrompt: ReturnType<typeof startingPromptFor>,
  fallbackPromptKey: string,
  fallbackSourceLabel: string | null,
) {
  const recommendationJobId = draft.recommendationJobId;
  const settled = job.state === "hasData" ? job.data : null;
  const recommendation =
    settled?.status === "completed" ? settled.recommendation : null;
  // A failed, missing or unreadable job leaves the preset request in place.
  const isLoading =
    recommendationJobId !== null &&
    (job.state === "loading" ||
      settled?.status === "pending" ||
      settled?.status === "running");
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
  const mobile = useMobileOnboarding();
  const flow = useSourcesFirstFlow("ready");
  const editPrompt = useSet(editStartingPrompt$);
  const capturePromptEdited = useSet(captureSourceOnboardingPromptEdited$);
  const captureStartClicked = useSet(captureSourceOnboardingStartClicked$);
  const catalogLoadable = useLastLoadable(onboardingSourceConnectors$);
  const pageSignal = useGet(pageSignal$);
  const [runLoadable, runRequest] = useLoadableSet(runOnboardingRequest$);
  // Keep the settled job while a notification re-reads it.
  const recommendationJob = useLastLoadable(onboardingRecommendation$);

  const connected =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.filter((connector) => {
          return isOnboardingSourceSlug(connector.slug) && connector.connected;
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
  // Once someone types, their draft owns the text. A recommendation may still
  // update the headline, but it can never replace an edit.
  const { isLoading, promptKey, text, outcome, outcomeDetail, sourceLabel } =
    readyPromptView(
      flow.draft,
      recommendationJob,
      fallbackPrompt,
      `${industry}:${source?.slug ?? "none"}`,
      source?.label ?? null,
    );

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
      mobileTitle={t(($) => {
        return $.onboarding.sourcesFirst.mobile.readyTitle;
      })}
      mobileDescription=""
      primaryLabel={t(($) => {
        return mobile
          ? $.onboarding.sourcesFirst.mobile.startTask
          : $.onboarding.sourcesFirst.welcome.start;
      })}
      onPrimary={() => {
        const request = text.trim();
        // The request's length, never the request itself.
        captureStartClicked(request.length);
        // Starting it completes onboarding first: an owner completes the
        // workspace's onboarding; a member completes only their own.
        detach(
          runRequest(
            request,
            null,
            flow.draft.startingPromptOutput?.suffix ?? "",
            pageSignal,
          ),
          Reason.DomCallback,
        );
      }}
      primaryDisabled={isLoading || text.trim().length === 0}
      primaryBusy={runLoadable.state === "loading"}
      onBack={flow.goBack}
    >
      {/* One column on the step's own sheet: the welcome, then the request it
          starts with. */}
      <div className="mx-auto flex w-full max-w-[520px] flex-col">
        <img
          src={CELEBRATION_URL}
          srcSet={`${CELEBRATION_2X_URL} 2x`}
          alt=""
          className="mx-auto h-40 max-w-full object-contain max-sm:hidden"
        />
        <StartingPromptPanel
          isLoading={isLoading}
          outcome={outcome}
          outcomeDetail={outcomeDetail}
          sourceLabel={sourceLabel}
          text={text}
          promptKey={promptKey}
          busy={runLoadable.state === "loading"}
          onChange={(value) => {
            editPrompt(value, promptKey);
            capturePromptEdited(value.length);
          }}
        />
      </div>
    </OnboardingStepLayout>
  );
}
