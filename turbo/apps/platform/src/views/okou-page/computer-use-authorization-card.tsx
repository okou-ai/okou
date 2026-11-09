import type { ComputerUseHost } from "@okouai/api-contracts/contracts/computer-use";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, Loader2, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ComputerUseAuthorizationSignals } from "../../signals/chat-page/computer-use-authorization-block.ts";
import { computerUseProductName$ } from "../../signals/branding.ts";
import { locale$ } from "../../signals/locale.ts";
import { visibleComputerUseHosts } from "../../signals/okou-page/computer-use-hosts.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

function AuthorizationDescription({
  failed,
  unavailable,
  completed,
  empty,
}: {
  failed: boolean;
  unavailable: boolean;
  completed: boolean;
  empty: boolean;
}) {
  const { t } = useTranslation();
  const desktopApplicationName = useGet(computerUseProductName$);
  const description = failed
    ? t(($) => {
        return $.authorization.computerUse.actionFailed;
      })
    : unavailable
      ? t(($) => {
          return $.authorization.computerUse.unavailableDescription;
        })
      : completed
        ? t(($) => {
            return $.authorization.computerUse.authorizedDescription;
          })
        : empty
          ? t(
              ($) => {
                return $.authorization.computerUse.noHostsDescription;
              },
              { desktopApplicationName },
            )
          : t(($) => {
              return $.authorization.computerUse.cardDescription;
            });
  return (
    <p
      className="mt-0.5 text-sm leading-5 text-muted-foreground"
      role={failed ? "alert" : undefined}
      aria-live="polite"
    >
      {description}
    </p>
  );
}

function AuthorizationControls({
  signals,
  hosts,
  loading,
  busy,
  completed,
  failed,
  onAuthorize,
}: {
  signals: ComputerUseAuthorizationSignals;
  hosts: ComputerUseHost[];
  loading: boolean;
  busy: boolean;
  completed: boolean;
  failed: boolean;
  onAuthorize: () => void;
}) {
  const { t } = useTranslation();
  const selection = useLoadable(signals.selectedHost$);
  const selectedHost = selection.state === "hasData" ? selection.data : null;
  const selectHost = useSet(signals.selectHost$);
  return (
    <div className="flex w-full min-w-0 items-center gap-2 @[640px]:w-auto @[640px]:shrink-0">
      {!completed && (
        <Select
          value={selectedHost?.id ?? null}
          onValueChange={selectHost}
          disabled={loading || busy || failed || hosts.length === 0}
          items={hosts.map((host) => {
            return { value: host.id, label: host.displayName };
          })}
        >
          <SelectTrigger
            variant="neutral"
            className="min-w-0 flex-1 @[640px]:w-56"
            aria-label={t(($) => {
              return $.authorization.computerUse.selectComputer;
            })}
          >
            <SelectValue
              placeholder={t(($) => {
                return $.authorization.computerUse.selectComputer;
              })}
            />
          </SelectTrigger>
          <SelectContent>
            {hosts.map((host) => {
              return (
                <SelectItem key={host.id} value={host.id}>
                  {host.displayName}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}
      <Button
        variant="secondary"
        pending={busy}
        disabled={loading || completed || failed || !selectedHost}
        className="shrink-0"
        onClick={onAuthorize}
      >
        {loading ? (
          <Loader2 className="animate-spin" />
        ) : completed ? (
          <Check />
        ) : null}
        {completed
          ? t(($) => {
              return $.authorization.computerUse.authorized;
            })
          : t(($) => {
              return $.authorization.computerUse.authorize;
            })}
      </Button>
    </div>
  );
}

export function ComputerUseAuthorizationCard({
  signals,
}: {
  signals: ComputerUseAuthorizationSignals;
}) {
  const { t } = useTranslation();
  const locale = useGet(locale$);
  const pageSignal = useGet(pageSignal$);
  const request = useLastLoadable(signals.request$);
  const [operation, authorize] = useLoadableSet(signals.authorize$);
  const loading = request.state === "loading";
  const data = request.state === "hasData" ? request.data : null;
  const hosts = visibleComputerUseHosts(data?.hosts ?? [], null, locale);
  const completed = Boolean(data?.completedAt) || operation.state === "hasData";
  const busy = operation.state === "loading";
  const failed = operation.state === "hasError";
  const unavailable = !loading && !data;
  const empty = data !== null && !completed && hosts.length === 0;

  return (
    <ChatCard
      data-testid="computer-use-authorization-card"
      aria-busy={loading || busy}
      className="flex h-[224px] w-full flex-col justify-between gap-3 px-4 py-3 text-left @[320px]:h-[200px] @[640px]:h-[112px] @[640px]:flex-row @[640px]:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
          <Monitor size={22} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.computerUse.authorization;
            })}
          </div>
          <AuthorizationDescription
            failed={failed}
            unavailable={unavailable}
            completed={completed}
            empty={empty}
          />
        </div>
      </div>
      {empty ? (
        <Button
          variant="neutral"
          disabled
          className="w-full shrink-0 @[640px]:w-auto"
        >
          {t(($) => {
            return $.authorization.computerUse.noHostsTitle;
          })}
        </Button>
      ) : (
        !unavailable && (
          <AuthorizationControls
            signals={signals}
            hosts={hosts}
            loading={loading}
            busy={busy}
            completed={completed}
            failed={failed}
            onAuthorize={() => {
              detach(authorize(pageSignal), Reason.DomCallback);
            }}
          />
        )
      )}
    </ChatCard>
  );
}
