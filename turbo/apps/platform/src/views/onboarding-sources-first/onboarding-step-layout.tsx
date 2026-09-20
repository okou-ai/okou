import type { ReactNode } from "react";
import { Button } from "@okouai/ui";
import { useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
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
  footnote,
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
  /** A line under the action, for a step that carries an offer or a note. */
  readonly footnote?: ReactNode;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative box-border flex h-full max-h-full min-h-full w-full overflow-hidden bg-sidebar pb-(--sab) text-foreground">
      <SettingsDialogMount />
      {/* The app's own rail: the workspace at the top, the account at the
          bottom, both as the marks the sidebar nav already uses. */}
      <div className="flex w-14 shrink-0 flex-col items-center justify-between py-3">
        <OrgSwitcherCompact />
        <OnboardingAccount />
      </div>
      <main
        key={`${String(currentStep)}-${title}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden"
      >
        {/* The question stays on the rail's own surface, set down from the top
            edge and anchored there, so neither the track nor the title moves as
            a step's words run longer. The column takes the slack the narrower
            sheet leaves, while its words keep one measure. */}
        <div className="w-full min-w-0 px-6 pt-8 pb-6 lg:flex-1 lg:px-10 lg:pt-28 lg:pb-10">
          <div className="lg:max-w-[380px]">
            <OnboardingStepProgress current={currentStep} total={totalSteps} />
            <h1 className="mt-12 text-[30px] font-semibold leading-[1.16] tracking-[-0.02em] lg:text-[34px]">
              {title}
            </h1>
            <p className="mt-5 text-base leading-[1.7] text-muted-foreground">
              {description}
            </p>
            {footnote ? (
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                {footnote}
              </p>
            ) : null}
          </div>
        </div>
        {/* The answers sit on the app's own sheet: the same small margin,
            radius and border as the workspace, held to one width so the answers
            keep a readable measure, with the way back and the way on under a
            rule at its foot. */}
        <div className="m-2 mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background lg:ml-0 lg:mt-2 lg:w-[760px] lg:flex-none">
          <div className="min-h-0 flex-1 overflow-y-auto p-6 lg:p-8">
            {/* Centred while it fits, scrolled from the top when it does
                not. */}
            <div className="flex min-h-full flex-col justify-center">
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
