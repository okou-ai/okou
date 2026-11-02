import { PersonalSubscriptionDialogs } from "../okou-page/subscription-linking.tsx";
import type { ReactNode } from "react";
import { Button, IconButton } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AccountDropdown } from "../okou-page/sidebar-account";
import { OrgSwitcherCompact } from "../okou-page/org-switcher.tsx";
import { SettingsDialogMount } from "../okou-page/components/settings/settings-dialog.tsx";
import { handleAccountAction$ } from "../../signals/okou-page/nav.ts";
import {
  canSkipPreviewOnboarding$,
  skipPreviewOnboarding$,
} from "../../signals/onboarding/onboarding-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { useMobileOnboarding } from "../onboarding/use-mobile-onboarding.ts";

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
    <div className="mt-6 space-y-3">
      {points.map((point) => {
        return (
          <p
            key={point}
            className="text-base leading-[1.7] text-muted-foreground"
          >
            {point}
          </p>
        );
      })}
    </div>
  );
}

/** The step's left column: what it asks, and why it is worth answering. */
function OnboardingStepExplanation({
  title,
  description,
  mobileTitle,
  mobileDescription,
  trustPoints,
  footnote,
  supplement,
  illustration,
}: {
  readonly title: string;
  readonly description: string;
  readonly mobileTitle?: string;
  readonly mobileDescription?: string;
  readonly trustPoints?: readonly string[];
  readonly footnote?: ReactNode;
  readonly supplement?: ReactNode;
  readonly illustration?: ReactNode;
}) {
  const mobile = useMobileOnboarding();
  const body = mobile ? (mobileDescription ?? description) : description;
  return (
    <>
      <h1
        className={`${illustration ? "mt-8" : "mt-12"} text-[30px] max-sm:mt-2 max-sm:text-2xl font-semibold leading-[1.16] tracking-[-0.02em] lg:text-[34px]`}
      >
        {mobile ? (mobileTitle ?? title) : title}
      </h1>
      {body ? (
        <p className="mt-5 text-base leading-[1.7] text-muted-foreground max-sm:mt-2 max-sm:text-sm max-sm:leading-6">
          {body}
        </p>
      ) : null}
      {illustration}
      {mobile ? null : <OnboardingTrustPoints points={trustPoints} />}
      {!mobile && footnote ? (
        <p
          className={`${illustration ? "mt-2" : "mt-4"} text-base leading-[1.7] text-muted-foreground`}
        >
          {footnote}
        </p>
      ) : null}
      {mobile ? null : supplement}
    </>
  );
}

/**
 * A phone's navigation bar: the way back, how far along the flow is, and the
 * way past the step, where a native app keeps them. It stays pinned while the
 * step scrolls beneath it.
 */
function OnboardingStepTopBar({
  current,
  total,
  secondaryAction,
  secondaryLabel,
  onSecondary,
  secondaryDisabled,
  secondaryBusy,
  onBack,
}: {
  readonly current: number;
  readonly total: number;
  readonly secondaryAction?: ReactNode;
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
  readonly secondaryDisabled: boolean;
  readonly secondaryBusy: boolean;
  readonly onBack?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 bg-background px-2 sm:hidden">
      {onBack ? (
        <IconButton
          type="button"
          aria-label={t(($) => {
            return $.onboarding.sourcesFirst.common.back;
          })}
          onClick={onBack}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </IconButton>
      ) : (
        <span className="size-10 shrink-0" />
      )}
      <div className="min-w-0 flex-1 px-1">
        <OnboardingStepProgress current={current} total={total} />
      </div>
      {secondaryAction ??
        (secondaryLabel && onSecondary ? (
          <Button
            type="button"
            size="lg"
            variant="quiet"
            className="px-3"
            onClick={onSecondary}
            disabled={secondaryDisabled}
            aria-busy={secondaryBusy}
          >
            {secondaryLabel}
          </Button>
        ) : (
          <span className="size-10 shrink-0" />
        ))}
    </div>
  );
}

/**
 * The step's way on. On a phone, Back and the secondary live in the top bar,
 * so the bar keeps only the primary: full width, pinned above the home
 * indicator while the step scrolls.
 */
function OnboardingStepActions({
  primaryAction,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryBusy,
  secondaryAction,
  secondaryLabel,
  onSecondary,
  secondaryDisabled,
  secondaryBusy,
  onBack,
}: {
  readonly primaryAction?: ReactNode;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly primaryDisabled: boolean;
  readonly primaryBusy: boolean;
  readonly secondaryAction?: ReactNode;
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
  readonly secondaryDisabled: boolean;
  readonly secondaryBusy: boolean;
  readonly onBack?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-6 py-4 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:bg-background max-sm:px-4 max-sm:py-3 lg:px-8">
      {onBack ? (
        <Button
          type="button"
          size="lg"
          variant="ghost"
          onClick={onBack}
          className="max-sm:hidden"
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.common.back;
          })}
        </Button>
      ) : (
        <span className="max-sm:hidden" />
      )}
      <div className="flex items-center gap-2 max-sm:flex-1">
        {secondaryAction ? (
          <div className="max-sm:hidden">{secondaryAction}</div>
        ) : secondaryLabel && onSecondary ? (
          <Button
            type="button"
            size="lg"
            variant="quiet"
            onClick={onSecondary}
            disabled={secondaryDisabled}
            aria-busy={secondaryBusy}
            className="max-sm:hidden"
          >
            {secondaryLabel}
          </Button>
        ) : null}
        {primaryAction ?? (
          <Button
            type="button"
            size="lg"
            onClick={onPrimary}
            disabled={primaryDisabled}
            pending={primaryBusy}
            className="min-w-[132px] max-sm:w-full"
          >
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Every sources-first step reads the same way: the app's rail on the left, and
 * the step centred on the canvas -- the question and its one action beside the
 * cards that answer it.
 */
interface OnboardingStepLayoutProps {
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly title: string;
  readonly description: string;
  readonly mobileTitle?: string;
  readonly mobileDescription?: string;
  /** Secondary information follows the task on small screens. */
  readonly mobileFooter?: ReactNode;
  readonly primaryAction?: ReactNode;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly primaryDisabled?: boolean;
  readonly primaryBusy?: boolean;
  readonly secondaryAction?: ReactNode;
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
  readonly onBack?: () => void;
  readonly trustPoints?: readonly string[];
  /** A line under the action, for a step that carries an offer or a note. */
  readonly footnote?: ReactNode;
  /** A block closing the explanation, below everything else it says. */
  readonly supplement?: ReactNode;
  /** An example of the step's outcome, between its introduction and trust copy. */
  readonly illustration?: ReactNode;
  readonly contentAlign?: "center" | "start";
  readonly children: ReactNode;
}

export function OnboardingStepLayout({
  currentStep,
  totalSteps,
  title,
  description,
  mobileTitle,
  mobileDescription,
  mobileFooter,
  primaryAction,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryBusy = false,
  secondaryAction,
  secondaryLabel,
  onSecondary,
  onBack,
  trustPoints,
  footnote,
  supplement,
  illustration,
  contentAlign = "center",
  children,
}: OnboardingStepLayoutProps) {
  const { t } = useTranslation();
  const mobile = useMobileOnboarding();
  const canSkipPreview = useGet(canSkipPreviewOnboarding$);
  const pageSignal = useGet(pageSignal$);
  const [skipLoadable, skipPreview] = useLoadableSet(skipPreviewOnboarding$);
  const skipping = canSkipPreview && skipLoadable.state === "loading";
  const secondaryActionLabel = canSkipPreview
    ? t(($) => {
        return $.onboarding.common.skip;
      })
    : secondaryLabel;
  const secondaryHandler = canSkipPreview
    ? () => {
        detach(skipPreview(pageSignal), Reason.DomCallback);
      }
    : onSecondary;

  return (
    <div className="relative box-border flex h-full max-h-full min-h-full w-full overflow-hidden bg-sidebar pb-safe text-foreground max-sm:bg-background">
      <SettingsDialogMount />
      <PersonalSubscriptionDialogs />
      {/* The app's own rail: the workspace at the top, the account at the
          bottom, both as the marks the sidebar nav already uses. A phone
          gives the step the whole width instead. */}
      <div className="flex w-14 shrink-0 flex-col items-center justify-between py-3 max-sm:hidden">
        <OrgSwitcherCompact />
        <OnboardingAccount />
      </div>
      <main
        key={currentStep}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(0,calc(50%_-_1.75rem))_minmax(0,calc(50%_+_1.75rem))] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden"
      >
        <OnboardingStepTopBar
          current={currentStep}
          total={totalSteps}
          secondaryAction={canSkipPreview ? undefined : secondaryAction}
          secondaryLabel={secondaryActionLabel}
          onSecondary={secondaryHandler}
          secondaryDisabled={canSkipPreview && (skipping || primaryBusy)}
          secondaryBusy={skipping}
          onBack={onBack}
        />
        {/* The rail is 3.5rem wide, so account for half of it in each track:
            the sheet begins at the viewport's actual midpoint. */}
        <div
          className={`w-full min-w-0 px-6 pt-8 pb-6 max-sm:px-5 max-sm:pt-2 max-sm:pb-0 lg:overflow-y-auto lg:px-10 ${illustration ? "lg:pt-24" : "lg:pt-28"} lg:pb-10`}
        >
          <div className="lg:mx-auto lg:w-full lg:max-w-[480px]">
            <div className="max-sm:hidden">
              <OnboardingStepProgress
                current={currentStep}
                total={totalSteps}
              />
            </div>
            <OnboardingStepExplanation
              title={title}
              description={description}
              mobileTitle={mobileTitle}
              mobileDescription={mobileDescription}
              trustPoints={trustPoints}
              footnote={footnote}
              supplement={supplement}
              illustration={illustration}
            />
          </div>
        </div>
        {/* The answers sit on the app's own sheet, taking the other half. A
            phone drops the sheet: the step runs full-bleed and scrolls as one
            page, so the answers are never squeezed under the question. */}
        <div className="m-2 mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background max-sm:m-0 max-sm:flex-[1_0_auto] max-sm:overflow-visible max-sm:rounded-none max-sm:border-0 lg:ml-0 lg:mt-2">
          <div className="min-h-0 flex-1 overflow-y-auto p-6 max-sm:flex-[1_0_auto] max-sm:overflow-visible max-sm:px-5 max-sm:pt-5 lg:p-8">
            {/* Centred while it fits, scrolled from the top when it does
                not. */}
            <div
              className={`flex min-h-full flex-col max-sm:justify-start ${contentAlign === "start" ? "justify-start" : "justify-center"}`}
            >
              {children}
              {mobile && mobileFooter ? (
                <div className="mt-5">{mobileFooter}</div>
              ) : null}
            </div>
          </div>
          <OnboardingStepActions
            primaryAction={primaryAction}
            primaryLabel={primaryLabel}
            onPrimary={onPrimary}
            primaryDisabled={primaryDisabled || skipping}
            primaryBusy={primaryBusy}
            secondaryAction={canSkipPreview ? undefined : secondaryAction}
            secondaryLabel={secondaryActionLabel}
            onSecondary={secondaryHandler}
            secondaryDisabled={canSkipPreview && (skipping || primaryBusy)}
            secondaryBusy={skipping}
            onBack={onBack}
          />
        </div>
      </main>
    </div>
  );
}
