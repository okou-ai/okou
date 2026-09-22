import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Textarea } from "@okouai/ui";
import {
  ONBOARDING_INDUSTRY_IDS,
  type OnboardingIndustry,
} from "@okouai/core/onboarding-industry";
import {
  captureSourceOnboardingPromptEdited$,
  captureSourceOnboardingStartClicked$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { justConnectedBuiltinSlugs$ } from "../../signals/okou-page/settings/connectors.ts";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import { updateSourcesFirstDraft$ } from "../../signals/onboarding/onboarding-sources-first-state.ts";
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
const SUPPORT_EMAIL = "support@okou.ai";
const CELEBRATION_URL =
  "https://static.okou.io/web/assets/onboarding/v3-ready-celebrate_640.png";

function fallbackIndustry(
  industry: OnboardingIndustry | null,
): OnboardingIndustry {
  return (
    industry ?? ONBOARDING_INDUSTRY_IDS[ONBOARDING_INDUSTRY_IDS.length - 1]
  );
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
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const justConnected = useGet(justConnectedBuiltinSlugs$);
  const pageSignal = useGet(pageSignal$);
  const searchParams = useGet(searchParams$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const { runPrompt } = useOnboardingNavigation();

  const connected =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.connectors.filter((connector) => {
          return connector.connected || justConnected.has(connector.slug);
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
  const prompt = startingPromptFor(
    t,
    industry,
    source ? { slug: source.slug, name: source.label } : null,
  );
  const promptKey = `${industry}:${source?.slug ?? "none"}`;
  const text =
    flow.draft.startingPromptKey === promptKey
      ? flow.draft.startingPromptDraft
      : prompt.text;

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
      primaryDisabled={text.trim().length === 0}
      primaryBusy={completeLoadable.state === "loading"}
      onBack={flow.goBack}
      footnote={
        <>
          {t(($) => {
            return $.onboarding.sourcesFirst.welcome.offerTitle;
          })}{" "}
          <a
            className="text-brand-text hover:text-brand-text-hover"
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            {SUPPORT_EMAIL}
          </a>
        </>
      }
    >
      {/* One column on the step's own sheet: the welcome, then the request it
          starts with. */}
      <div className="mx-auto flex w-full max-w-[520px] flex-col">
        <img
          src={CELEBRATION_URL}
          alt=""
          className="mx-auto h-[104px] max-w-full object-contain"
        />
        <div className="mt-8">
          <div className="flex items-baseline gap-2">
            <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
              {prompt.outcome}
            </h2>
            {source ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {source.label}
              </span>
            ) : null}
          </div>
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
              updateDraft({
                startingPromptKey: promptKey,
                startingPromptDraft: event.target.value,
              });
              capturePromptEdited(event.target.value.length);
            }}
          />
        </div>
      </div>
    </OnboardingStepLayout>
  );
}
