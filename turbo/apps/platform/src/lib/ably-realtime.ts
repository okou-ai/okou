import type {
  ConnectionStateChange,
  ChannelStateChange,
  RealtimeChannel,
} from "ably";
import {
  recordAuthDiagnostic,
  type AuthDiagnosticContext,
} from "./auth-diagnostics.ts";
import {
  BaseRealtime,
  FetchRequest,
  RealtimePresence,
  WebSocketTransport,
  XHRPolling,
} from "ably/modular";

type AblyRealtimeOptions = Omit<
  ConstructorParameters<typeof BaseRealtime>[0],
  "plugins"
>;

export type AblyRealtime = BaseRealtime;

export function createAblyRealtime(
  options: AblyRealtimeOptions,
  diagnostic: AuthDiagnosticContext,
  signal: AbortSignal,
): AblyRealtime {
  const ably = new BaseRealtime({
    ...options,
    plugins: {
      FetchRequest,
      RealtimePresence,
      WebSocketTransport,
      XHRPolling,
    },
  });
  const handleState = (change: ConnectionStateChange): void => {
    recordAuthDiagnostic({
      stage: "ably_connection",
      context: diagnostic,
      previousState: change.previous,
      state: change.current,
      retryInMs: change.retryIn,
      reasonCode: change.reason?.code,
      reasonStatusCode: change.reason?.statusCode,
    });
  };
  ably.connection.on(handleState);
  signal.addEventListener(
    "abort",
    () => {
      ably.connection.off(handleState);
    },
    { once: true },
  );
  recordAuthDiagnostic({
    stage: "ably_connection",
    context: diagnostic,
    state: ably.connection.state,
  });
  return ably;
}

export function observeAblyChannel(
  channel: RealtimeChannel,
  scope: "credential" | "user" | "org" | "run-output",
  diagnostic: AuthDiagnosticContext,
  signal: AbortSignal,
): () => void {
  const handleState = (change: ChannelStateChange): void => {
    recordAuthDiagnostic({
      stage: "ably_channel",
      context: diagnostic,
      scope,
      previousState: change.previous,
      state: change.current,
      resumed: change.resumed,
      reasonCode: change.reason?.code,
      reasonStatusCode: change.reason?.statusCode,
    });
  };
  const cleanup = (): void => {
    channel.off(handleState);
    signal.removeEventListener("abort", cleanup);
  };
  channel.on(handleState);
  signal.addEventListener("abort", cleanup, { once: true });
  recordAuthDiagnostic({
    stage: "ably_channel",
    context: diagnostic,
    scope,
    state: channel.state,
  });
  return cleanup;
}
