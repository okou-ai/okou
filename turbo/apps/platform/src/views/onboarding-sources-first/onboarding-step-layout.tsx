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
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        {/* One grid for every step: the track, the title and the action line
            sit at the same height on all of them, and the step's own content is
            centred inside a band of fixed height. The wrapper centres the step
            while it fits and grows downward when it does not, so a centred flex
            child never clips its own top. */}
        <div className="flex min-h-full flex-col justify-center">
          <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-10 lg:flex-row lg:items-start lg:justify-center lg:gap-16">
            <div className="w-full shrink-0 lg:w-[340px]">
              <div className="lg:min-h-[430px]">
                <OnboardingStepProgress
                  current={currentStep}
                  total={totalSteps}
                />
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
            <div className="w-full min-w-0 lg:w-[720px] lg:shrink-0">
              {/* One card of one size on every step: its answers above the
                  rule, the way back and the way on below it. Content that
                  outgrows the card scrolls inside it. */}
              <div className="flex flex-col overflow-hidden rounded-3xl border border-border/60 bg-background">
                <div className="flex flex-col justify-center overflow-y-auto p-6 lg:h-[440px]">
                  {children}
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border/60 px-6 py-4">
                  {onBack ? (
                    <Button
                      type="button"
                      size="lg"
                      variant="ghost"
                      onClick={onBack}
                    >
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
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
