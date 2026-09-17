import type { BuiltInModelCooldownDiagnostics } from "@okouai/api-contracts/contracts/model-provider-routes";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Badge,
} from "@okouai/ui";
import {
  useGet,
  useLastResolved,
  useLoadableState,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronDown, ChevronUp, CircleX, Cpu, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import {
  builtInModelCooldownDiagnostics$,
  cancelBuiltInModelCooldown$,
  reloadBuiltInModelCooldownDiagnostics$,
} from "../../../../signals/okou-page/settings/built-in-model-cooldown-diagnostics.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

type BuiltInModelCooldown =
  BuiltInModelCooldownDiagnostics["activeCooldowns"][number];

function CooldownDiagnosticsSummary({
  diagnostics,
}: {
  readonly diagnostics: BuiltInModelCooldownDiagnostics;
}) {
  const { t } = useTranslation();

  return (
    <summary className="flex w-full cursor-pointer list-none items-start gap-4 p-4 text-left transition-colors hover:bg-state-hover [&::-webkit-details-marker]:hidden">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <Cpu size={22} className="text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span
          id="built-in-model-cooldown-diagnostics-title"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown.title;
          })}
        </span>
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .description;
          })}
        </span>
        <span className="flex flex-wrap gap-1.5 font-mono text-[11px] text-foreground">
          <Badge>
            {t(($) => {
              return $.settings.preferences.debug.builtInModelCooldown
                .globalActive;
            })}
            : {formatLocalizedNumber(diagnostics.activeCooldowns.length)}
          </Badge>
        </span>
      </span>
      <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground group-open:hidden" />
      <ChevronUp className="mt-1 hidden h-4 w-4 shrink-0 text-muted-foreground group-open:block" />
    </summary>
  );
}

function CooldownDetails({
  cooldown,
  showUnavailableUntil,
}: {
  readonly cooldown: BuiltInModelCooldown;
  readonly showUnavailableUntil: boolean;
}) {
  const { t } = useTranslation();

  return (
    <dl className="grid gap-2 font-mono text-[11px] sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .selectedModel;
          })}
        </dt>
        <dd className="break-all text-foreground">{cooldown.selectedModel}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .providerType;
          })}
        </dt>
        <dd className="break-all text-foreground">{cooldown.providerType}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .upstreamModel;
          })}
        </dt>
        <dd className="break-all text-foreground">{cooldown.upstreamModel}</dd>
      </div>
      {showUnavailableUntil && (
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.debug.builtInModelCooldown
                .unavailableUntil;
            })}
          </dt>
          <dd className="break-all text-foreground">
            <time dateTime={cooldown.unavailableUntil}>
              {cooldown.unavailableUntil}
            </time>
          </dd>
        </div>
      )}
    </dl>
  );
}

function CooldownCancellationDialogBody({
  cooldown,
  cancelling,
  onConfirm,
}: {
  readonly cooldown: BuiltInModelCooldown;
  readonly cancelling: boolean;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DialogContent maxWidth="md" showCloseButton={!cancelling}>
      <DialogHeader>
        <DialogTitle>
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .cancelTitle;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .cancelDescription;
          })}
        </DialogDescription>
      </DialogHeader>
      <div className="rounded-md bg-muted/30 px-3 py-3">
        <CooldownDetails cooldown={cooldown} showUnavailableUntil={false} />
      </div>
      <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-5 text-foreground">
        {t(($) => {
          return $.settings.preferences.debug.builtInModelCooldown
            .cancelWarning;
        })}
      </p>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={cancelling}>
            {t(($) => {
              return $.settings.preferences.debug.builtInModelCooldown
                .keepCooldown;
            })}
          </Button>
        </DialogClose>
        <Button
          type="button"
          variant="destructive"
          disabled={cancelling}
          onClick={onConfirm}
        >
          {cancelling
            ? t(($) => {
                return $.settings.preferences.debug.builtInModelCooldown
                  .cancelling;
              })
            : t(($) => {
                return $.settings.preferences.debug.builtInModelCooldown
                  .cancelAction;
              })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CooldownCancellationControl({
  cooldown,
  loading,
}: {
  readonly cooldown: BuiltInModelCooldown;
  readonly loading: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [cancelLoadable, cancelCooldown] = useLoadableSet(
    cancelBuiltInModelCooldown$,
  );
  const cancelling = cancelLoadable.state === "loading";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-destructive/40 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={loading}
        >
          <CircleX className="h-3.5 w-3.5" />
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .cancelAction;
          })}
        </Button>
      </DialogTrigger>
      <CooldownCancellationDialogBody
        cooldown={cooldown}
        cancelling={cancelling}
        onConfirm={() => {
          detach(cancelCooldown(cooldown, pageSignal), Reason.DomCallback);
        }}
      />
    </Dialog>
  );
}

function CooldownRow({
  cooldown,
  canCancel,
  loading,
}: {
  readonly cooldown: BuiltInModelCooldown;
  readonly canCancel: boolean;
  readonly loading: boolean;
}) {
  return (
    <div className="rounded-md bg-muted/30 px-3 py-3">
      <CooldownDetails cooldown={cooldown} showUnavailableUntil />
      {canCancel && (
        <div className="mt-3 flex justify-end border-t border-border/60 pt-3">
          <CooldownCancellationControl cooldown={cooldown} loading={loading} />
        </div>
      )}
    </div>
  );
}

function CooldownList({
  diagnostics,
  loading,
}: {
  readonly diagnostics: BuiltInModelCooldownDiagnostics;
  readonly loading: boolean;
}) {
  const { t } = useTranslation();

  if (diagnostics.activeCooldowns.length === 0) {
    return (
      <div className="rounded-md bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
        {t(($) => {
          return $.settings.preferences.debug.builtInModelCooldown.empty;
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {diagnostics.activeCooldowns.map((cooldown) => {
        const key = JSON.stringify([
          cooldown.selectedModel,
          cooldown.providerType,
          cooldown.upstreamModel,
        ]);
        return (
          <CooldownRow
            key={key}
            cooldown={cooldown}
            canCancel={diagnostics.canCancelCooldowns === true}
            loading={loading}
          />
        );
      })}
    </div>
  );
}

function CooldownDiagnosticsContent({
  diagnostics,
  loading,
}: {
  readonly diagnostics: BuiltInModelCooldownDiagnostics;
  readonly loading: boolean;
}) {
  const { t } = useTranslation();
  const reloadDiagnostics = useSet(reloadBuiltInModelCooldownDiagnostics$);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .globalExplanation;
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={loading}
          onClick={() => {
            reloadDiagnostics();
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown.refresh;
          })}
        </Button>
      </div>
      <CooldownList diagnostics={diagnostics} loading={loading} />
    </div>
  );
}

export function BuiltInModelCooldownDiagnosticsBlock() {
  const { t } = useTranslation();
  const reloadDiagnostics = useSet(reloadBuiltInModelCooldownDiagnostics$);
  const diagnostics = useLastResolved(builtInModelCooldownDiagnostics$);
  const loading =
    useLoadableState(builtInModelCooldownDiagnostics$) === "loading";

  return (
    <section
      aria-labelledby="built-in-model-cooldown-diagnostics-title"
      className="overflow-hidden rounded-xl bg-card border border-surface-border"
    >
      {diagnostics ? (
        <details className="group">
          <CooldownDiagnosticsSummary diagnostics={diagnostics} />
          <div className="border-t border-border/60 p-4">
            <CooldownDiagnosticsContent
              diagnostics={diagnostics}
              loading={loading}
            />
          </div>
        </details>
      ) : (
        <div className="flex items-start gap-4 p-4">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Cpu size={22} className="text-muted-foreground" />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div
              id="built-in-model-cooldown-diagnostics-title"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.settings.preferences.debug.builtInModelCooldown.title;
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {loading
                  ? t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .loading;
                    })
                  : t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .unavailable;
                    })}
              </div>
              {!loading && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => {
                    reloadDiagnostics();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t(($) => {
                    return $.settings.preferences.debug.builtInModelCooldown
                      .refresh;
                  })}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
