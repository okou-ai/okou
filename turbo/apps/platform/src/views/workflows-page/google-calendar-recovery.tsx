import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import { Button } from "@okouai/ui";
import { i18n } from "../../i18n/index.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { relatedCatalogItems$ } from "../../signals/okou-page/settings/connectors.ts";
import {
  builtinAccountConnectDialog$,
  builtinAccountManager$,
  openBuiltinAccountConnectDialog$,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import {
  cancelGoogleCalendarRecovery$,
  checkGoogleCalendarRecovery$,
  closeGoogleCalendarReconnect$,
  googleCalendarRecoveryTarget$,
  openGoogleCalendarRecovery$,
} from "../../signals/workflows-page/google-calendar-recovery.ts";
import type { GoogleCalendarWorkflowAutomationSummary } from "../../signals/workflows-page/workflows-signals.ts";
import { ConnectorAccountManagerDialog } from "../okou-page/components/settings/connector-account-manager-dialog.tsx";
import { ConnectModal } from "../okou-page/components/settings/add-connection-dialog.tsx";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";

const GOOGLE_CALENDAR_CONNECTOR_SLUG = "google-calendar";

export function GoogleCalendarReconnectAction({
  automation,
}: {
  readonly automation: GoogleCalendarWorkflowAutomationSummary;
}) {
  const connectorLoadable = useLoadable(relatedCatalogItems$);
  const openRecovery = useSet(openGoogleCalendarRecovery$);
  const recovery = useGet(googleCalendarRecoveryTarget$);
  const pageSignal = useGet(pageSignal$);
  const connector =
    connectorLoadable.state === "hasData"
      ? (connectorLoadable.data.find((candidate) => {
          return candidate.slug === GOOGLE_CALENDAR_CONNECTOR_SLUG;
        }) ?? null)
      : null;

  return (
    <Button
      type="button"
      variant="link"
      className="h-auto w-fit p-0 text-xs text-amber-700 dark:text-amber-400"
      disabled={!connector || recovery !== null}
      onClick={() => {
        if (connector) {
          openRecovery(connector, automation, pageSignal);
        }
      }}
    >
      {connectorLoadable.state === "loading" ? (
        <Loader2 size={13} className="animate-spin" />
      ) : null}
      {i18n.t(($) => {
        return $.workflows.automations.calendar.reconnectGoogleCalendar;
      })}
    </Button>
  );
}

export function GoogleCalendarRecoveryDialogs() {
  const managedConnector = useGet(builtinAccountManager$);
  const accountConnect = useGet(builtinAccountConnectDialog$);
  const recovery = useGet(googleCalendarRecoveryTarget$);
  const cancelRecovery = useSet(cancelGoogleCalendarRecovery$);
  const closeReconnect = useSet(closeGoogleCalendarReconnect$);
  const [confirmation, checkRecovery] = useLoadableSet(
    checkGoogleCalendarRecovery$,
  );
  const openAccountConnect = useSet(openBuiltinAccountConnectDialog$);
  const pageSignal = useGet(pageSignal$);
  const googleCalendarManager =
    managedConnector?.slug === GOOGLE_CALENDAR_CONNECTOR_SLUG
      ? managedConnector
      : null;
  const googleCalendarConnect =
    accountConnect?.connector.slug === GOOGLE_CALENDAR_CONNECTOR_SLUG &&
    accountConnect.mode.kind === "reconnect"
      ? {
          connector: accountConnect.connector,
          mode: accountConnect.mode,
        }
      : null;

  return (
    <>
      {recovery?.phase === "confirm" ? (
        <GoogleCalendarRecoveryStatus
          checking={confirmation.state === "loading"}
          onCheck={() => {
            detach(
              checkRecovery(recovery, undefined, pageSignal),
              Reason.DomCallback,
            );
          }}
          onCancel={cancelRecovery}
        />
      ) : null}
      {googleCalendarManager && recovery ? (
        <ConnectorAccountManagerDialog
          target={{
            kind: "builtin",
            connectorSlug: googleCalendarManager.slug,
          }}
          connectorLabel={googleCalendarManager.label}
          icon={<ConnectorIcon icon={googleCalendarManager.icon} size={20} />}
          connectionActionsEnabled
          onClose={cancelRecovery}
          onReconnect={(account) => {
            openAccountConnect(googleCalendarManager, {
              kind: "reconnect",
              connectionId: account.id,
              authMethod: account.authMethod,
            });
          }}
        />
      ) : null}
      {googleCalendarConnect && recovery ? (
        <ConnectModal
          item={googleCalendarConnect.connector}
          accountMode={googleCalendarConnect.mode}
          reconnectAuthMethod={googleCalendarConnect.mode.authMethod}
          accountOptions={{
            account: {
              intent: "reconnect",
              connectionId: googleCalendarConnect.mode.connectionId,
            },
          }}
          onClose={() => {
            closeReconnect(recovery);
          }}
          onSuccess={(connectionId, signal) => {
            return checkRecovery(recovery, connectionId, signal);
          }}
        />
      ) : null}
    </>
  );
}

function GoogleCalendarRecoveryStatus({
  checking,
  onCheck,
  onCancel,
}: {
  readonly checking: boolean;
  readonly onCheck: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <section
      aria-label={i18n.t(($) => {
        return $.workflows.automations.calendar.recoveryStatus;
      })}
      className="mx-6 my-3 rounded-lg border p-4 text-sm"
    >
      {checking ? (
        <p role="status" className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {i18n.t(($) => {
            return $.workflows.automations.calendar.checkingRecovery;
          })}
        </p>
      ) : (
        <p role="alert">
          {i18n.t(($) => {
            return $.workflows.automations.calendar.recoveryUnconfirmed;
          })}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={onCheck}
        >
          {i18n.t(($) => {
            return $.workflows.automations.calendar.checkRecoveryStatus;
          })}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {i18n.t(($) => {
            return $.workflows.automations.calendar.cancelRecovery;
          })}
        </Button>
      </div>
    </section>
  );
}
