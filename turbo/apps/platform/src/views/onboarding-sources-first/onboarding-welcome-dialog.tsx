import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Textarea,
} from "@okouai/ui";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { justConnectedSlugs$ } from "../../signals/okou-page/settings/connectors.ts";
import {
  sourcesFirstDraft$,
  sourcesFirstUi$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { useOnboardingNavigation } from "../onboarding/onboarding-navigation.ts";
import { ONBOARDING_TEXTAREA_CLASS } from "../onboarding/onboarding-shell.tsx";
import {
  INDUSTRY_IDS,
  type IndustryId,
} from "./onboarding-sources-first-data.ts";
import {
  pickStartingPromptSource,
  startingPromptFor,
} from "./onboarding-starting-prompt.ts";

const STARTING_PROMPT_MAX_LENGTH = 1000;
const SUPPORT_EMAIL = "support@okou.ai";

function fallbackIndustry(industry: IndustryId | null): IndustryId {
  return industry ?? INDUSTRY_IDS[INDUSTRY_IDS.length - 1];
}

/**
 * The last thing onboarding shows: one editable first request, matched from the
 * chosen industry and a connected source. Only the primary button starts it;
 * closing the dialog keeps the edited text.
 */
function OnboardingWelcomeDialog() {
  const { t } = useTranslation();
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);
  const draft = useGet(sourcesFirstDraft$);
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const justConnected = useGet(justConnectedSlugs$);
  const { runPrompt } = useOnboardingNavigation();

  const connected =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.connectors.filter((connector) => {
          return connector.connected || justConnected.has(connector.slug);
        })
      : [];
  const industry = fallbackIndustry(draft.industry);
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
    draft.startingPromptKey === promptKey
      ? draft.startingPromptDraft
      : prompt.text;

  return (
    <Dialog
      open={ui.welcomeOpen}
      onOpenChange={(open) => {
        updateUi({ welcomeOpen: open });
      }}
    >
      <DialogContent maxWidth="lg" contentClassName="p-6">
        {/* One screen: what is ready, the request it will start with, and the
            offer as a single line under it. */}
        <header className="flex items-start gap-3 pr-8">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Check size={18} />
          </span>
          <span className="min-w-0">
            <DialogTitle className="text-lg font-semibold leading-6">
              {t(($) => {
                return $.onboarding.sourcesFirst.welcome.title;
              })}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.welcome.copy;
              })}
            </DialogDescription>
          </span>
        </header>
        <section className="mt-5 rounded-xl border border-border bg-muted/30 p-4">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
              {prompt.outcome}
            </h3>
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
            className={`mt-3 min-h-[88px] ${ONBOARDING_TEXTAREA_CLASS}`}
            maxLength={STARTING_PROMPT_MAX_LENGTH}
            spellCheck={false}
            value={text}
            onChange={(event) => {
              updateDraft({
                startingPromptKey: promptKey,
                startingPromptDraft: event.target.value,
              });
            }}
          />
        </section>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-xs leading-5 text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.welcome.offerTitle;
            })}{" "}
            <a
              className="text-brand-text hover:text-brand-text-hover"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              {SUPPORT_EMAIL}
            </a>
          </p>
          <Button
            type="button"
            size="lg"
            className="gap-2"
            disabled={text.trim().length === 0}
            onClick={() => {
              runPrompt(text.trim());
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.welcome.start;
            })}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface WelcomeHandoff {
  readonly openWelcome: () => void;
  readonly welcomeDialog: ReactNode;
}

/** Shared by every step that can be the last one in its branch. */
export function useWelcomeHandoff(): WelcomeHandoff {
  const updateUi = useSet(updateSourcesFirstUi$);
  return {
    openWelcome: () => {
      updateUi({ welcomeOpen: true });
    },
    welcomeDialog: <OnboardingWelcomeDialog />,
  };
}
