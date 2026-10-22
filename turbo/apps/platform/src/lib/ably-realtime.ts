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

export function createAblyRealtime(options: AblyRealtimeOptions): AblyRealtime {
  return new BaseRealtime({
    ...options,
    plugins: {
      FetchRequest,
      RealtimePresence,
      WebSocketTransport,
      XHRPolling,
    },
  });
}
