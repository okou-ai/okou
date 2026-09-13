import { Button } from "@okouai/ui";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Building2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DesktopAuthSignals } from "../../signals/desktop-auth/desktop-auth.ts";
import type { DesktopAuthRoute } from "../../signals/desktop-auth/protocol.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AuthCardShell } from "../auth/auth-card-shell.tsx";
import { AuthChoiceRow } from "../auth/auth-choice-row.tsx";

export function DesktopAuthPage({
  signals,
  mode,
}: {
  readonly signals: DesktopAuthSignals;
  readonly mode: DesktopAuthRoute;
}) {
  const { t } = useTranslation();
  const phase = useGet(signals.phase$);
  const selected = useGet(signals.selectedOrganization$);
  const pageSignal = useGet(pageSignal$);
  const select = useSet(signals.selectOrganization$);
  const reopen = useSet(signals.reopen$);
  const retry = useSet(signals.retry$);
  const title = t(($) => {
    return $.auth.desktop.title;
  });
  const descriptions = {
    connecting: t(($) => {
      return $.auth.desktop.phases["connecting"];
    }),
    pending: t(($) => {
      return $.auth.desktop.phases["pending"];
    }),
    consumed: t(($) => {
      return $.auth.desktop.phases["consumed"];
    }),
    completed: t(($) => {
      return $.auth.desktop.phases["completed"];
    }),
    selecting: t(($) => {
      return $.auth.desktop.phases["selecting"];
    }),
    "no-workspaces": t(($) => {
      return $.auth.desktop.phases["no-workspaces"];
    }),
    failed: t(($) => {
      return $.auth.desktop.phases["failed"];
    }),
  };
  const description = descriptions[phase];

  return (
    <main
      className="flex min-h-full items-center justify-center bg-background p-6"
      data-testid="desktop-auth"
    >
      <AuthCardShell
        focusKey={phase}
        title={title}
        description={description}
        announcement={description}
      >
        <div className="space-y-3">
          {phase === "selecting" ? (
            <DesktopWorkspaces
              signals={signals}
              selected={selected}
              onSelect={(id) => {
                detach(select(id, pageSignal), Reason.DomCallback);
              }}
            />
          ) : null}
          {phase === "pending" ? (
            <Button
              className="w-full bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
              variant="default"
              onClick={() => {
                return reopen(pageSignal);
              }}
            >
              {t(($) => {
                return $.auth.desktop.reopen;
              })}
            </Button>
          ) : null}
          {phase === "failed" && mode === "callback" ? (
            <Button
              className="w-full bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
              variant="default"
              onClick={() => {
                return retry(pageSignal);
              }}
            >
              {t(($) => {
                return $.auth.desktop.retry;
              })}
            </Button>
          ) : null}
        </div>
      </AuthCardShell>
    </main>
  );
}

function DesktopWorkspaces({
  signals,
  selected,
  onSelect,
}: {
  readonly signals: DesktopAuthSignals;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const memberships = useLastResolved(signals.memberships$) ?? [];
  return memberships.map(({ organization }) => {
    return (
      <AuthChoiceRow
        key={organization.id}
        actionLabel={organization.name}
        primary={organization.name}
        leading={<Building2 className="size-4" aria-hidden="true" />}
        busy={selected === organization.id}
        disabled={selected !== null}
        onSelect={() => {
          return onSelect(organization.id);
        }}
      />
    );
  });
}
