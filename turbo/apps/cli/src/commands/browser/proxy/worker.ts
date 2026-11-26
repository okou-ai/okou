import { object, string, number, url, uuid } from "zod";
import { writeProxyDiagnostic, type TimedProxyExit } from "./diagnostic";
import { startWindowProxy } from "./server";

const configuration = object({
  cdpUrl: url(),
  runtimeId: string().regex(/^[a-p]{32}$/u),
  windowId: number().int().nonnegative().safe(),
  instanceId: uuid(),
}).strict();

type WorkerMessage = { ready: true } | { endpoint: string } | { error: string };

function send(message: WorkerMessage): Promise<void> {
  const pipe = process.send?.bind(process);
  if (!pipe || !process.connected)
    return Promise.reject(new Error("Private startup pipe required"));
  return new Promise((resolve, reject) => {
    pipe(message, (error: Error | null) => {
      if (error) reject(new Error("Private startup pipe closed"));
      else resolve();
    });
  });
}

function receiveConfiguration(signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.removeListener("message", received);
      process.removeListener("disconnect", cancelled);
      signal.removeEventListener("abort", cancelled);
    };
    const received = (input: unknown) => {
      cleanup();
      resolve(input);
    };
    const cancelled = () => {
      cleanup();
      reject(new Error("Private startup pipe closed"));
    };
    process.once("message", received);
    process.once("disconnect", cancelled);
    signal.addEventListener("abort", cancelled, { once: true });
    // Configuration must wait until asynchronous CLI bootstrap has installed us.
    send({ ready: true }).catch(cancelled);
  });
}

export async function runBrowserProxyWorker(): Promise<void> {
  if (!process.send || !process.connected)
    throw new Error("The Browser proxy requires a private startup pipe");
  const owner = new AbortController();
  const abort = () => {
    owner.abort();
  };
  let configured = false;
  const disconnected = () => {
    if (!configured) owner.abort();
  };
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  process.once("disconnect", disconnected);
  let proxy: Awaited<ReturnType<typeof startWindowProxy>> | undefined;
  let instanceId: string | undefined;
  let setupFailed = false;
  try {
    const input = await receiveConfiguration(owner.signal);
    configured = true;
    const config = configuration.parse(input);
    instanceId = config.instanceId;
    // The canonical CLI entry configures the global network proxy before loading us.
    proxy = await startWindowProxy(config, owner.signal);
    await send({ endpoint: proxy.endpoint });
    await proxy.closed;
  } catch {
    setupFailed = true;
    process.exitCode = 1;
  } finally {
    owner.abort();
    try {
      await proxy?.close();
    } catch {
      process.exitCode = 1;
    }
    if (instanceId) {
      const exit: TimedProxyExit = proxy
        ? await proxy.closed
        : { reason: "startup-failed", closedAt: new Date().toISOString() };
      await writeProxyDiagnostic(instanceId, exit);
    }
    if (setupFailed && process.connected)
      await send({ error: "Scoped Browser setup failed" }).catch(() => {});
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    process.removeListener("disconnect", disconnected);
    if (process.connected) process.disconnect();
    // The Guest task owns this runtime; release all closing CLI/transport IO.
    process.exit(process.exitCode ?? 0);
  }
}
