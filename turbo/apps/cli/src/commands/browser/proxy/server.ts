import { createServer } from "node:http";
import { OkouBrowserClient } from "@okouai/browser-extension-client";
import { WebSocketServer } from "ws";
import { ControlWire, record, type PeerWire } from "./wire";
import { WindowScope } from "./scope";
import { ProxyPeer } from "./peer";

export interface ProxyConfiguration {
  readonly cdpUrl: string;
  readonly runtimeId: string;
  readonly windowId: number;
}

/** The managed Guest task owns this listener; the already-created window is external. */
export async function startWindowProxy(
  config: ProxyConfiguration,
  signal: AbortSignal,
) {
  let endpoint = config.cdpUrl;
  const url = new URL(endpoint);
  if (url.protocol === "https:" || url.protocol === "http:") {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/json/version`;
    const response = await fetch(url, { signal, redirect: "error" });
    const version: unknown = await response.json();
    if (
      !response.ok ||
      !record(version) ||
      typeof version.webSocketDebuggerUrl !== "string" ||
      !["ws:", "wss:"].includes(new URL(version.webSocketDebuggerUrl).protocol)
    )
      throw new Error("Browser CDP discovery unavailable");
    endpoint = version.webSocketDebuggerUrl;
  }
  const server = createServer((request, response) => {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 0 });
  const peers = new Set<ProxyPeer>();
  const path = "/devtools/browser";
  const handshakes = new Set<() => void>();
  let finished!: () => void;
  const closed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let native: OkouBrowserClient | undefined;
  let control: ControlWire | undefined;
  let scope: WindowScope | undefined;
  let closing: Promise<void> | undefined;
  let claimed = false;
  let unclaimed: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    close().catch(() => {
      process.exitCode = 1;
    });
  };

  function close(): Promise<void> {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      clearTimeout(unclaimed);
      signal.removeEventListener("abort", abort);
      scope?.close();
      for (const cancel of handshakes) cancel();
      handshakes.clear();
      for (const peer of peers) peer.close();
      sockets.close();
      server.close();
      server.closeAllConnections();
      control?.close();
      try {
        await native?.close();
      } catch (error) {
        process.exitCode = 1;
        throw error;
      } finally {
        finished();
      }
    });
    return closing;
  }

  signal.addEventListener("abort", abort, { once: true });
  try {
    control = await ControlWire.connect(endpoint, signal);
    native = await OkouBrowserClient.connect({
      transport: control,
      runtimeId: config.runtimeId,
      signal,
    });
    scope = new WindowScope(
      control,
      native,
      config.windowId,
      abort,
      config.runtimeId,
      native.signal,
    );
    await scope.start();
    signal.throwIfAborted();
    if (closing) throw new Error("Scoped Browser setup was retired");
    const activeScope = scope;
    const activeControl = control;
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== path || closing) {
        socket.destroy();
        return;
      }
      let upstream: PeerWire | undefined;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        clearTimeout(timer);
        socket.destroy();
        upstream?.close();
        handshakes.delete(cancel);
      };
      const timer = setTimeout(() => {
        cancel();
      }, 15_000);
      handshakes.add(cancel);
      socket.once("close", cancel);
      activeControl
        .openPeer()
        .then((channel) => {
          upstream = channel;
          if (cancelled || closing || socket.destroyed || channel.closed) {
            cancel();
            return;
          }
          // A rejected upgrade never transfers ownership to a ProxyPeer.
          sockets.handleUpgrade(request, socket, head, (downstream) => {
            clearTimeout(timer);
            handshakes.delete(cancel);
            socket.removeListener("close", cancel);
            claimed = true;
            clearTimeout(unclaimed);
            const peer = new ProxyPeer(downstream, channel, activeScope, () => {
              peers.delete(peer);
              if (claimed && !peers.size) abort();
            });
            peers.add(peer);
          });
        })
        .catch(cancel);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Scoped Browser listener unavailable");
    // Startup bound only: an established CDP connection has no additional lease.
    unclaimed = setTimeout(abort, 30_000);
    return { endpoint: `ws://127.0.0.1:${address.port}${path}`, close, closed };
  } catch (error) {
    await close();
    throw error;
  }
}
