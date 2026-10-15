import {
  collectTemporaryAuthDiagnostic,
  observeTemporaryAuthPromise,
} from "@okouai/core/temporary-auth-diagnostics";
import {
  createAuthDiagnosticId,
  recordAuthDiagnostic,
  startAuthDiagnosticMeasurement,
  type AuthDiagnosticContext,
} from "./auth-diagnostics.ts";
import { detach, Reason } from "../signals/utils.ts";
import { now } from "./time.ts";

export interface AblyAuthDiagnosticScope {
  readonly context: AuthDiagnosticContext;
  callbackContext?: AuthDiagnosticContext;
  readonly requestContexts: WeakMap<object, AuthDiagnosticContext>;
}

export function createAblyAuthDiagnosticScope(
  context: AuthDiagnosticContext,
): AblyAuthDiagnosticScope {
  return { context, requestContexts: new WeakMap() };
}

/** The modular SDK exposes its HTTP plugin as unknown. Only wrap callable
 * exports and preserve the original promise and all SDK arguments unchanged.
 */
export function observeAblyFetchRequest(
  plugin: unknown,
  scope: AblyAuthDiagnosticScope,
  signal: AbortSignal,
): unknown {
  if (typeof plugin !== "function") {
    return plugin;
  }
  return (...args: unknown[]): unknown => {
    const observation = collectTemporaryAuthDiagnostic(now, () => {
      const [method, , uri, headers] = args;
      if (
        typeof method !== "string" ||
        method.toUpperCase() !== "POST" ||
        typeof uri !== "string" ||
        !/^\/keys\/[^/]+\/requestToken$/.test(new URL(uri).pathname)
      ) {
        return;
      }
      // SDK 2.29 uses the same headers object for every host attempt of a
      // logical exchange. Weak keys retain no signed request or credential.
      const headerKey =
        typeof headers === "object" && headers !== null ? headers : undefined;
      const invocation =
        (headerKey && scope.requestContexts.get(headerKey)) ??
        scope.callbackContext;
      if (headerKey && invocation) {
        scope.requestContexts.set(headerKey, invocation);
      }
      const context = invocation ?? scope.context;
      const exchangeAttemptId = createAuthDiagnosticId();
      const measurement = startAuthDiagnosticMeasurement();
      recordAuthDiagnostic({
        stage: "ably_token_exchange_started",
        context,
        exchangeAttemptId,
        outcome: "started",
      });
      return { context, exchangeAttemptId, measurement };
    });
    const result: unknown = plugin(...args);
    collectTemporaryAuthDiagnostic(now, () => {
      if (!observation || !(result instanceof Promise)) {
        return;
      }
      // Attach before the SDK consumes the original promise: it can normalize
      // (and mutate) an error result. The observer never replaces that promise.
      detach(
        observeTemporaryAuthPromise(result, now, (settled) => {
          if (!settled.ok) {
            recordAuthDiagnostic({
              stage: "ably_token_exchange_finished",
              ...observation,
              reason: settled.error,
              outcome: "error",
              ownerAborted: signal.aborted,
            });
            return;
          }
          const value: unknown = settled.value;
          if (typeof value !== "object" || value === null) {
            return;
          }
          // Read data properties only. Never execute a provider getter or
          // inspect response body, headers, request URI, key or signature.
          const status: unknown = Object.getOwnPropertyDescriptor(
            value,
            "statusCode",
          )?.value;
          const errorDescriptor = Object.getOwnPropertyDescriptor(
            value,
            "error",
          );
          if (errorDescriptor && !("value" in errorDescriptor)) {
            return;
          }
          const reason: unknown = errorDescriptor?.value;
          recordAuthDiagnostic({
            stage: "ably_token_exchange_finished",
            ...observation,
            status:
              typeof status === "number" &&
              Number.isSafeInteger(status) &&
              status >= 100 &&
              status <= 599
                ? status
                : undefined,
            reason,
            outcome: reason ? "error" : "success",
            ownerAborted: signal.aborted,
          });
        }),
        Reason.DomCallback,
        "ably-token-exchange-diagnostics",
      );
    });
    return result;
  };
}
