import type { ReactNode } from "react";
import { Button } from "@okouai/ui";
import { useSet } from "ccstate-react";
import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AccountDropdown } from "../okou-page/sidebar-account";
import { OrgSwitcherCompact } from "../okou-page/org-switcher.tsx";
import { SettingsDialogMount } from "../okou-page/components/settings/settings-dialog.tsx";
import { handleAccountAction$ } from "../../signals/okou-page/nav.ts";

/** One track that fills with the flow, rather than a segment per step. */
function OnboardingStepProgress({
  current,
  total,
}: {
  readonly current: number;
  readonly total: number;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={t(
        ($) => {
          return $.onboarding.common.stepProgress;
        },
        { current, total },
      )}
    >
      <span
        data-testid="onboarding-progress-fill"
        className="block h-full rounded-full bg-foreground transition-[width] duration-300"
        style={{ width: `${String((current / total) * 100)}%` }}
      />
    </div>
  );
}

function OnboardingAccount() {
  const onAccountAction = useSet(handleAccountAction$);
  return <AccountDropdown onAccountAction={onAccountAction} collapsed />;
}

function OnboardingTrustPoints({
  points,
}: {
  readonly points?: readonly string[];
}) {
  if (!points || points.length === 0) {
    return null;
  }

  return (
    <ul className="mt-10 space-y-4 border-t border-border/60 pt-6">
      {points.map((point) => {
        return (
          <li
            key={point}
            className="flex items-start gap-3 text-sm leading-6 text-muted-foreground"
          >
            <Check
              size={16}
              className="mt-1 shrink-0 text-foreground"
              aria-hidden="true"
            />
            <span>{point}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The step's left column: what it asks, and why it is worth answering. */
function OnboardingStepExplanation({
  intro,
  title,
  description,
  trustPoints,
  footnote,
  supplement,
}: {
  readonly intro?: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly trustPoints?: readonly string[];
  readonly footnote?: ReactNode;
  readonly supplement?: ReactNode;
}) {
  return (
    <>
      {intro}
      <h1
        className={`${intro ? "mt-8" : "mt-12"} text-[30px] font-semibold leading-[1.16] tracking-[-0.02em] lg:text-[34px]`}
      >
        {title}
      </h1>
      <p className="mt-5 text-base leading-[1.7] text-muted-foreground">
        {description}
      </p>
      <OnboardingTrustPoints points={trustPoints} />
      {footnote ? (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {footnote}
        </p>
      ) : null}
      {supplement}
    </>
  );
}

/**
 * Every sources-first step reads the same way: the app's rail on the left, and
 * the step centred on the canvas -- the question and its one action beside the
 * cards that answer it.
 */
export function OnboardingStepLayout({
  currentStep,
  totalSteps,
  title,
  description,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryBusy = false,
  secondaryLabel,
  onSecondary,
  onBack,
  intro,
  trustPoints,
  footnote,
  supplement,
  contentAlign = "center",
  children,
}: {
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly title: string;
  readonly description: string;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly primaryDisabled?: boolean;
  readonly primaryBusy?: boolean;
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
  readonly onBack?: () => void;
  /** What Okou is, above the question, for the step that opens the flow. */
  readonly intro?: ReactNode;
  readonly trustPoints?: readonly string[];
  /** A line under the action, for a step that carries an offer or a note. */
  readonly footnote?: ReactNode;
  /** A block closing the explanation, below everything else it says. */
  readonly supplement?: ReactNode;
  readonly contentAlign?: "center" | "start";
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative box-border flex h-full max-h-full min-h-full w-full overflow-hidden bg-sidebar pb-safe text-foreground">
      <SettingsDialogMount />
      {/* The app's own rail: the workspace at the top, the account at the
          bottom, both as the marks the sidebar nav already uses. */}
      <div className="flex w-14 shrink-0 flex-col items-center justify-between py-3">
        <OrgSwitcherCompact />
        <OnboardingAccount />
      </div>
      <main
        key={`${String(currentStep)}-${title}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(0,calc(50%_-_1.75rem))_minmax(0,calc(50%_+_1.75rem))] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden"
      >
        {/* The rail is 3.5rem wide, so account for half of it in each track:
            the sheet begins at the viewport's actual midpoint. */}
        <div className="w-full min-w-0 px-6 pt-8 pb-6 lg:overflow-y-auto lg:px-10 lg:pt-28 lg:pb-10">
          <div className="lg:mx-auto lg:w-full lg:max-w-[480px]">
            <OnboardingStepProgress current={currentStep} total={totalSteps} />
            <OnboardingStepExplanation
              intro={intro}
              title={title}
              description={description}
              trustPoints={trustPoints}
              footnote={footnote}
              supplement={supplement}
            />
          </div>
        </div>
        {/* The answers sit on the app's own sheet, taking the other half. */}
        <div className="m-2 mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background lg:ml-0 lg:mt-2">
          <div className="min-h-0 flex-1 overflow-y-auto p-6 lg:p-8">
            {/* Centred while it fits, scrolled from the top when it does
                not. */}
            <div
              className={`flex min-h-full flex-col ${contentAlign === "start" ? "justify-start" : "justify-center"}`}
            >
              {children}
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-6 py-4 lg:px-8">
            {onBack ? (
              <Button type="button" size="lg" variant="ghost" onClick={onBack}>
                {t(($) => {
                  return $.onboarding.sourcesFirst.common.back;
                })}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              {secondaryLabel && onSecondary ? (
                <Button
                  type="button"
                  size="lg"
                  variant="ghost"
                  onClick={onSecondary}
                >
                  {secondaryLabel}
                </Button>
              ) : null}
              <Button
                type="button"
                size="lg"
                onClick={onPrimary}
                disabled={primaryDisabled || primaryBusy}
                aria-busy={primaryBusy}
                className="w-[132px] gap-2 disabled:bg-[hsl(var(--primary-100))]"
              >
                {primaryBusy ? (
                  <Loader2
                    size={16}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {primaryLabel}
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
