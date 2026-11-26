import { createServer } from "node:http";
import { OkouBrowserClient } from "@okouai/browser-extension-client";
import { WebSocketServer } from "ws";
import { ControlWire, record } from "./wire";
import { WindowScope } from "./scope";
import { ProxyPeer } from "./peer";
import type { ProxyExit, TimedProxyExit } from "./diagnostic";

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
  let finished!: (exit: TimedProxyExit) => void;
  const closed = new Promise<TimedProxyExit>((resolve) => {
    finished = resolve;
  });
  let native: OkouBrowserClient | undefined;
  let control: ControlWire | undefined;
  let scope: WindowScope | undefined;
  let closing: Promise<void> | undefined;
  let claimed = false;
  let unclaimed: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: ProxyExit["reason"]) => {
    close(control?.exit ?? { reason }).catch(() => {
      process.exitCode = 1;
    });
  };
  const abort = () => {
    stop("owner-cancelled");
  };

  function close(exit: ProxyExit): Promise<void> {
    if (closing) return closing;
    const closedAt = new Date().toISOString();
    closing = Promise.resolve().then(async () => {
      try {
        clearTimeout(unclaimed);
        signal.removeEventListener("abort", abort);
        scope?.close();
        control?.close();
        sockets.close();
        server.close();
        server.closeAllConnections();
        await native?.close();
      } catch (error) {
        process.exitCode = 1;
        throw error;
      } finally {
        finished({ ...exit, closedAt });
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
      stop,
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
      const channel = activeControl.openPeer();
      const disconnect = () => {
        channel.close();
      };
      socket.once("close", disconnect);
      socket.once("error", disconnect);
      channel.onClose(() => {
        socket.destroy();
      });
      channel.opened
        .then(() => {
          if (closing) {
            channel.close();
            return;
          }
          if (channel.closed) return;
          sockets.handleUpgrade(request, socket, head, (downstream) => {
            claimed = true;
            clearTimeout(unclaimed);
            const peer = new ProxyPeer(downstream, channel, activeScope, () => {
              peers.delete(peer);
              if (claimed && !peers.size) stop("last-client-disconnected");
            });
            peers.add(peer);
          });
        })
        .catch(() => {
          channel.close();
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Scoped Browser listener unavailable");
    // Startup bound only: an established CDP connection has no additional lease.
    unclaimed = setTimeout(() => {
      stop("unclaimed-listener-timeout");
    }, 30_000);
    return {
      endpoint: `ws://127.0.0.1:${address.port}${path}`,
      close: () => {
        return close({ reason: "closed" });
      },
      closed,
    };
  } catch (error) {
    await close(control?.exit ?? { reason: "startup-failed" });
    throw error;
  }
}
