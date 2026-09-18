import type { ReactNode } from "react";
import { Button, cn } from "@okouai/ui";
import { useSet } from "ccstate-react";
import { ChevronLeft, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AccountDropdown } from "../okou-page/sidebar-account";
import { OrgSwitcherCompact } from "../okou-page/org-switcher.tsx";
import { SettingsDialogMount } from "../okou-page/components/settings/settings-dialog.tsx";
import { handleAccountAction$ } from "../../signals/okou-page/nav.ts";

/**
 * The step's own width. The content column stays centred, so a two-card step
 * does not stretch a single card across the whole canvas.
 */
const CONTENT_WIDTHS = {
  grid: "max-w-[900px]",
  pair: "max-w-[760px]",
  single: "max-w-[620px]",
} as const;

type OnboardingContentWidth = keyof typeof CONTENT_WIDTHS;

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
      className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
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
  contentWidth = "pair",
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
  readonly contentWidth?: OnboardingContentWidth;
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
        className="min-h-0 flex-1 overflow-y-auto px-6 py-10"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col items-center justify-center gap-10 lg:flex-row lg:items-center lg:gap-14">
          <div className="w-full shrink-0 lg:w-[380px]">
            <OnboardingStepProgress current={currentStep} total={totalSteps} />
            <h1 className="mt-10 text-[32px] font-semibold leading-[1.12] tracking-[-0.02em] lg:mt-14 lg:text-[40px]">
              {title}
            </h1>
            <p className="mt-5 text-base leading-[1.7] text-muted-foreground">
              {description}
            </p>
            {/* One filled action, its opt-out beside it, and the way back
                under both -- the same weights the app's other footers use. */}
            <div className="mt-9 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="lg"
                onClick={onPrimary}
                disabled={primaryDisabled || primaryBusy}
                aria-busy={primaryBusy}
                className="min-w-[132px] gap-2 disabled:bg-[hsl(var(--primary-100))]"
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
            </div>
            {onBack ? (
              <Button
                type="button"
                size="sm"
                variant="quiet"
                onClick={onBack}
                className="-ml-3 mt-3 gap-1"
              >
                <ChevronLeft size={16} aria-hidden="true" />
                {t(($) => {
                  return $.onboarding.sourcesFirst.common.back;
                })}
              </Button>
            ) : null}
          </div>
          <div
            className={cn(
              "w-full min-w-0 lg:flex-1",
              CONTENT_WIDTHS[contentWidth],
            )}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
