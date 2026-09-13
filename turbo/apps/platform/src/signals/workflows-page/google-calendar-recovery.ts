import { command, computed, state } from "ccstate";
import { timeout } from "signal-timers";
import { now } from "../../lib/time.ts";
import { dismissConnectorConnectionProgress$ } from "../connector-connection-progress.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import {
  builtinAccountConnectDialog$,
  closeBuiltinAccountConnectDialog$,
  closeBuiltinAccountManager$,
  finishConnectorAccountConnection$,
  openBuiltinAccountManager$,
} from "../okou-page/settings/connector-account-dialogs.ts";
import {
  createChildAbortController,
  resetSignal,
  setLoop,
  withCleanup,
} from "../utils.ts";
import {
  currentWorkflowId$,
  isGoogleCalendarWorkflowAutomation,
  reloadCurrentWorkflowDetail$,
  type GoogleCalendarWorkflowAutomationSummary,
} from "./workflows-signals.ts";

interface CalendarRecoveryTarget {
  readonly workflowId: string;
  readonly automationId: string;
  readonly eventType: GoogleCalendarWorkflowAutomationSummary["eventType"];
  readonly phase: "reconnect" | "confirm";
}

const internalRecoveryTarget$ = state<CalendarRecoveryTarget | null>(null);
const resetConfirmation$ = resetSignal();
export const googleCalendarRecoveryTarget$ = computed((get) => {
  return get(internalRecoveryTarget$);
});

export const cancelGoogleCalendarRecovery$ = command(({ set }) => {
  set(resetConfirmation$);
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
      phase: "reconnect",
    });
    set(openBuiltinAccountManager$, connector, signal);
  },
);

export const closeGoogleCalendarReconnect$ = command(
  ({ get, set }, target: CalendarRecoveryTarget) => {
    // ConnectModal also closes after onSuccess; that must not dismiss confirmation.
    if (
      get(internalRecoveryTarget$) === target &&
      target.phase === "reconnect"
    ) {
      set(cancelGoogleCalendarRecovery$);
    }
  },
);

const confirmRecovery$ = command(
  async ({ get, set }, target: CalendarRecoveryTarget, signal: AbortSignal) => {
    const deadline = now() + 30_000;
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const controller = createChildAbortController(signal);
    timeout(
      () => {
        controller.abort(
          new DOMException(
            "Calendar recovery confirmation expired",
            "TimeoutError",
          ),
        );
      },
      30_000,
      { signal: controller.signal },
    );
    let attempts = 0;
    let recovered = false;
    // At most 10 serial GETs, 2s after each completed pending read, and a 30s
    // total deadline including hung requests. No transport or OAuth retries.
    await withCleanup(
      setLoop(
        async () => {
          if (now() >= deadline || attempts >= 10) {
            return true;
          }
          if (get(currentWorkflowId$) !== target.workflowId) {
            return true;
          }
          attempts++;
          const detail = await set(
            reloadCurrentWorkflowDetail$,
            controller.signal,
          );
          if (now() >= deadline) {
            return true;
          }
          const automation = detail?.automations.find((candidate) => {
            return candidate.id === target.automationId;
          });
          if (
            detail?.id !== target.workflowId ||
            !automation ||
            !isGoogleCalendarWorkflowAutomation(automation) ||
            automation.eventType !== target.eventType
          ) {
            return true;
          }
          recovered = automation.warning === undefined;
          return (
            recovered ||
            automation.warning !== "reconnect_required" ||
            attempts >= 10
          );
        },
        2000,
        controller.signal,
        { retryTransientErrors: false },
      ),
      () => {
        controller.abort();
      },
    );
    signal.throwIfAborted();
    return recovered;
  },
);

export const checkGoogleCalendarRecovery$ = command(
  async (
    { get, set },
    target: CalendarRecoveryTarget,
    connectionId: string | null | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (get(internalRecoveryTarget$) !== target) {
      return;
    }
    const attemptSignal = set(resetConfirmation$, signal);
    if (target.phase === "reconnect") {
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
        attemptSignal,
      );
      signal.throwIfAborted();
      attemptSignal.throwIfAborted();
      set(internalRecoveryTarget$, { ...target, phase: "confirm" });
      // The inline recovery status now owns progress and cancellation.
      set(dismissConnectorConnectionProgress$);
      set(closeBuiltinAccountConnectDialog$);
    }
    const recovered = await set(confirmRecovery$, target, attemptSignal);
    signal.throwIfAborted();
    if (recovered) {
      set(internalRecoveryTarget$, null);
    }
  },
);
