import {
  RunWssTransport,
  type RunWssState,
} from "../../../turbo/packages/core/src/run-wss-transport";

export const FRAME_SIZES = [0, 1, 17, 1024, 65536, 37] as const;

export interface ReplayProof {
  readonly opened: boolean;
  readonly admissionSent: boolean;
  readonly authOk: boolean;
  readonly closeCode: number;
  readonly remainingMs: number;
  readonly endedBeforeExpiry: boolean;
}

export interface RunWssProbe {
  readonly state: RunWssState;
  readonly bootstrapStatuses: readonly number[];
  connect(runId: string, expectedUrl: string): Promise<void>;
  echo(): Promise<readonly number[]>;
  replay(): Promise<ReplayProof>;
  bootstrapStatus(runId: string): Promise<number>;
  close(): void;
}

declare global {
  interface Window {
    RunWssProbeModule: { readonly createRunWssProbe: typeof createRunWssProbe };
    __runWssProbe?: RunWssProbe;
  }
}

export function createRunWssProbe(
  apiUrl: string,
  bypassSecret?: string,
): RunWssProbe {
  const apiOrigin = new URL(apiUrl).origin;
  const lifetime = new AbortController();
  const replaySockets = new Set<WebSocket>();
  const statuses: number[] = [];
  let transport: RunWssTransport | null = null;
  let admitted: {
    runId: string;
    url: string;
    ticket: string;
    expiresAt: number;
  } | null = null;
  let frameError = false;
  let pending: {
    readonly frames: readonly Uint8Array[];
    received: number;
    readonly resolve: (sizes: readonly number[]) => void;
    readonly reject: (error: Error) => void;
  } | null = null;

  const requestBootstrap = async (runId: string, signal: AbortSignal) => {
    const token = await window.Clerk?.session?.getToken();
    if (!token) throw new Error("Web session unavailable");
    return await fetch(new URL(`/api/runs/${runId}/wss/bootstrap`, apiOrigin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
      },
      signal,
      redirect: "error",
    });
  };

  const probe: RunWssProbe = {
    get state() {
      return transport?.state ?? "idle";
    },
    get bootstrapStatuses() {
      return [...statuses];
    },
    async connect(runId, expectedUrl) {
      if (transport || lifetime.signal.aborted)
        throw new Error("Probe already used");
      transport = new RunWssTransport(
        runId,
        async (id, signal) => {
          const response = await requestBootstrap(id, signal);
          statuses.push(response.status);
          if (response.status !== 200) {
            await response.body?.cancel();
            return {
              kind:
                response.status >= 400 && response.status < 500
                  ? "terminal"
                  : "transient",
            };
          }
          const body: unknown = await response.json();
          if (!isBootstrap(body) || body.wssUrl !== expectedUrl)
            throw new Error("Unexpected WSS target");
          admitted = {
            runId,
            url: body.wssUrl,
            ticket: body.ticket,
            expiresAt: Date.parse(body.expiresAt),
          };
          return { kind: "success", body };
        },
        {
          onFrame(frame) {
            const expected = pending?.frames[pending.received];
            const actual = new Uint8Array(frame);
            if (
              !pending ||
              !expected ||
              actual.length !== expected.length ||
              actual.some((value, index) => value !== expected[index])
            ) {
              frameError = true;
              pending?.reject(new Error("Opaque echo mismatch"));
              throw new Error("Opaque echo mismatch");
            }
            pending.received += 1;
            if (pending.received === pending.frames.length) {
              pending.resolve(pending.frames.map((value) => value.byteLength));
              pending = null;
            }
          },
          onStateChange(state) {
            if (
              state === "closed" ||
              state === "failed" ||
              state === "reconnecting"
            ) {
              pending?.reject(new Error("Echo connection lost"));
            }
          },
        },
      );
      await transport.connect(
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(90_000)]),
      );
      if (frameError || transport.state !== "ready")
        throw new Error("Probe did not reach readiness");
    },
    async echo() {
      if (!transport || transport.state !== "ready" || pending || frameError)
        throw new Error("Probe unavailable for echo");
      const frames = FRAME_SIZES.map((size, frameIndex) =>
        Uint8Array.from(
          { length: size },
          (_, index) => (index * 31 + frameIndex * 17) % 256,
        ),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<readonly number[]>((resolve, reject) => {
          pending = { frames, received: 0, resolve, reject };
          timer = setTimeout(
            () => reject(new Error("Opaque echo deadline exceeded")),
            10_000,
          );
          for (const frame of frames) {
            if (!transport?.send(frame.buffer)) {
              reject(new Error("Frame was not accepted"));
              break;
            }
          }
        });
      } finally {
        clearTimeout(timer);
        pending = null;
      }
    },
    async replay() {
      if (!admitted || transport?.state !== "ready" || frameError)
        throw new Error("No admitted ticket");
      const ticket = admitted;
      const remainingMs = ticket.expiresAt - Date.now();
      if (remainingMs <= 5_000)
        throw new Error("Replay no longer has a valid ticket window");
      const socket = new WebSocket(ticket.url);
      replaySockets.add(socket);
      let opened = false;
      let admissionSent = false;
      let authOk = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => socket.close();
      try {
        return await new Promise<ReplayProof>((resolve, reject) => {
          timer = setTimeout(() => {
            socket.close();
            reject(new Error("Replay did not close within deadline"));
          }, 5_000);
          lifetime.signal.addEventListener("abort", onAbort, { once: true });
          socket.addEventListener("open", () => {
            opened = true;
            if (Date.now() >= ticket.expiresAt || lifetime.signal.aborted) {
              socket.close();
              reject(new Error("Replay window closed"));
              return;
            }
            socket.send(
              JSON.stringify({ runId: ticket.runId, ticket: ticket.ticket }),
            );
            admissionSent = true;
          });
          socket.addEventListener("message", (event: MessageEvent<unknown>) => {
            try {
              const value: unknown =
                typeof event.data === "string" ? JSON.parse(event.data) : null;
              if (
                typeof value === "object" &&
                value !== null &&
                "type" in value &&
                value.type === "auth.ok"
              )
                authOk = true;
              else throw new Error("Unexpected replay response");
            } catch {
              socket.close();
              reject(new Error("Unexpected replay response"));
            }
          });
          socket.addEventListener("close", (event) =>
            resolve({
              opened,
              admissionSent,
              authOk,
              closeCode: event.code,
              remainingMs,
              endedBeforeExpiry: Date.now() < ticket.expiresAt,
            }),
          );
        });
      } finally {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", onAbort);
        replaySockets.delete(socket);
        socket.close();
      }
    },
    async bootstrapStatus(runId) {
      const response = await requestBootstrap(
        runId,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
      );
      await response.body?.cancel();
      return response.status;
    },
    close() {
      lifetime.abort();
      transport?.close();
      for (const socket of replaySockets) socket.close();
      replaySockets.clear();
      admitted = null;
    },
  };
  return probe;
}

function isBootstrap(
  value: unknown,
): value is { wssUrl: string; ticket: string; expiresAt: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "wssUrl" in value &&
    typeof value.wssUrl === "string" &&
    "ticket" in value &&
    typeof value.ticket === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "string"
  );
}
