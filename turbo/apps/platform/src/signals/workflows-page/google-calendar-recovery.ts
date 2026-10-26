import { command, computed, state } from "ccstate";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import {
  builtinAccountConnectDialog$,
  closeBuiltinAccountConnectDialog$,
  closeBuiltinAccountManager$,
  finishConnectorAccountConnection$,
  openBuiltinAccountManager$,
} from "../okou-page/settings/connector-account-dialogs.ts";
import {
  currentWorkflowId$,
  type GoogleCalendarWorkflowAutomationSummary,
} from "./workflows-signals.ts";

interface CalendarRecoveryTarget {
  readonly workflowId: string;
  readonly automationId: string;
  readonly eventType: GoogleCalendarWorkflowAutomationSummary["eventType"];
}

const internalRecoveryTarget$ = state<CalendarRecoveryTarget | null>(null);
export const googleCalendarRecoveryTarget$ = computed((get) => {
  return get(internalRecoveryTarget$);
});

export const cancelGoogleCalendarRecovery$ = command(({ set }) => {
  set(internalRecoveryTarget$, null);
  set(closeBuiltinAccountManager$);
  set(closeBuiltinAccountConnectDialog$);
});

export const openGoogleCalendarRecovery$ = command(
  (
    { get, set },
    connector: PlatformConnectorCatalogStatusItem,
    automation: GoogleCalendarWorkflowAutomationSummary,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const workflowId = get(currentWorkflowId$);
    if (!workflowId || get(internalRecoveryTarget$)) {
      return;
    }
    set(internalRecoveryTarget$, {
      workflowId,
      automationId: automation.id,
      eventType: automation.eventType,
    });
    set(openBuiltinAccountManager$, connector, signal);
  },
);

export const closeGoogleCalendarReconnect$ = command(
  ({ get, set }, target: CalendarRecoveryTarget) => {
    if (get(internalRecoveryTarget$) === target) {
      set(cancelGoogleCalendarRecovery$);
    }
  },
);

export const finishGoogleCalendarReconnect$ = command(
  async (
    { get, set },
    target: CalendarRecoveryTarget,
    connectionId: string | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (get(internalRecoveryTarget$) !== target) {
      return;
    }
    const dialog = get(builtinAccountConnectDialog$);
    if (
      !dialog ||
      dialog.mode.kind !== "reconnect" ||
      connectionId === undefined
    ) {
      return;
    }
    await set(
      finishConnectorAccountConnection$,
      {
        target: { kind: "builtin", connectorSlug: dialog.connector.slug },
        connectionId,
        connectorLabel: dialog.connector.label,
        mode: dialog.mode,
      },
      signal,
    );
    signal.throwIfAborted();
    set(cancelGoogleCalendarRecovery$);
  },
);
