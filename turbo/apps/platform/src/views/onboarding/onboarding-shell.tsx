import type { ReactNode } from "react";
import { Button } from "@okouai/ui";
import { useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { AccountDropdown } from "../okou-page/sidebar-account";
import { OrgSwitcher, OrgSwitcherCompact } from "../okou-page/org-switcher.tsx";
import { SettingsDialogMount } from "../okou-page/components/settings/settings-dialog.tsx";
import { handleAccountAction$ } from "../../signals/okou-page/nav.ts";
import { AppPageRoot } from "../components/app-page-root.tsx";

/**
 * Onboarding uses a softer, larger surface than the rest of the app: a wider
 * radius, the plain border token, and a looser focus ring. Every onboarding
 * `Textarea` opts into it through this one constant so the deviation from the
 * shared field style stays a single deliberate decision.
 */
export const ONBOARDING_TEXTAREA_CLASS =
  "rounded-xl border border-border bg-background focus:ring-2 focus:ring-primary/15";

function OnboardingAccount({ collapsed }: { readonly collapsed: boolean }) {
  const onAccountAction = useSet(handleAccountAction$);
  return (
    <AccountDropdown onAccountAction={onAccountAction} collapsed={collapsed} />
  );
}

function OnboardingProgress({
  current,
  total,
}: {
  readonly current: number;
  readonly total: number;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex h-1 w-full gap-1.5"
      aria-label={t(
        ($) => {
          return $.onboarding.common.stepProgress;
        },
        { current, total },
      )}
    >
      {Array.from({ length: total }, (_, index) => {
        return (
          <span
            key={index}
            data-testid="onboarding-progress-step"
            className={
              index < current
                ? "flex-1 rounded-full bg-foreground"
                : "flex-1 rounded-full bg-muted"
            }
          />
        );
      })}
    </div>
  );
}

export function OnboardingFooter({
  onBack,
  onPrimary,
  primaryLabel,
  primaryDisabled = false,
  busy = false,
}: {
  readonly onBack?: () => void;
  readonly onPrimary?: () => void;
  readonly primaryLabel?: string;
  readonly primaryDisabled?: boolean;
  readonly busy?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full items-center justify-between gap-3 pl-16 sm:pl-0">
      {onBack ? (
        <button
          type="button"
          className="h-10 border-0 bg-transparent px-0 text-sm font-medium text-brand-text hover:text-brand-text-hover"
          onClick={onBack}
        >
          {t(($) => {
            return $.onboarding.common.back;
          })}
        </button>
      ) : (
        <span />
      )}
      {onPrimary && primaryLabel ? (
        <Button
          type="button"
          onClick={onPrimary}
          disabled={primaryDisabled || busy}
          aria-busy={busy}
          variant="default"
          size="lg"
          className="min-w-[100px] gap-2 disabled:bg-[hsl(var(--primary-100))]"
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : null}
          {primaryLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function OnboardingDialog({
  title,
  description,
  children,
  footer,
  onClose,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        maxWidth="4xl"
        contentClassName="flex flex-col gap-0 overflow-hidden border-border bg-background p-5 sm:p-6"
      >
        <header className="shrink-0 pr-9">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-semibold leading-6">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="mt-1 text-sm leading-5 text-muted-foreground">
                {description}
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                {t(
                  ($) => {
                    return $.onboarding.common.dialogPreview;
                  },
                  { title },
                )}
              </DialogDescription>
            )}
          </div>
        </header>
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? (
          <footer className="mt-5 flex shrink-0 justify-end gap-2">
            {footer}
          </footer>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function OnboardingShell({
  currentStep,
  totalSteps,
  title,
  description,
  children,
  footer,
}: {
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly preview?: ReactNode;
}) {
  return (
    <AppPageRoot className="okou-app relative w-full bg-background text-foreground">
      <SettingsDialogMount />
      <div className="fixed left-4 top-4 z-20 hidden w-60 sm:left-6 sm:top-6 sm:block">
        <OrgSwitcher />
      </div>
      <div className="fixed left-4 top-4 z-20 sm:hidden">
        <OrgSwitcherCompact />
      </div>
      <div className="fixed bottom-[max(1.5rem,var(--sab))] left-4 z-20 hidden w-60 sm:block">
        <OnboardingAccount collapsed={false} />
      </div>
      <div className="fixed bottom-[max(2rem,var(--sab))] left-6 z-20 sm:hidden">
        <OnboardingAccount collapsed />
      </div>

      <section className="mx-auto flex h-full min-h-0 w-full max-w-[750px] flex-col">
        <div className="shrink-0 px-5 pb-4 pt-[72px] sm:px-10 lg:pt-8">
          <OnboardingProgress current={currentStep} total={totalSteps} />
        </div>
        <main
          key={`${currentStep}-${title}`}
          className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-[50px] [scrollbar-width:none] sm:px-10 [&::-webkit-scrollbar]:hidden"
        >
          <header>
            <h1 className="text-2xl font-semibold leading-[1.25]">{title}</h1>
            {description ? (
              <p className="mb-6 mt-2 text-sm leading-[1.625] text-muted-foreground">
                {description}
              </p>
            ) : null}
          </header>
          {children}
        </main>
        {footer ? (
          <footer className="shrink-0 border-t border-border/40 px-5 py-5 sm:px-10">
            {footer}
          </footer>
        ) : null}
      </section>
    </AppPageRoot>
  );
}
