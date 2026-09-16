import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";

import { serveWithShutdown } from "../node-server";

function report(event: string, port?: number): void {
  process.send?.({ event, port });
}

function main(): void {
  const instance = new AbortController();
  const background = createServer();
  const controls = new EventEmitter();

  instance.signal.addEventListener("abort", () => {
    report("aborted");
  });

  process.on("message", (message: unknown) => {
    if (message === "finish") {
      controls.emit("finish");
      if (background.listening) {
        background.close(() => {
          report("cleaned");
        });
      }
    } else if (message === "ping") {
      report("pong");
    }
  });
  // IPC coordinates tests but must not be the handle keeping this child alive.
  process.channel?.unref();

  const server = serveWithShutdown(
    {
      hostname: "127.0.0.1",
      port: Number(process.argv[2] ?? 0),
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/work") {
          const finished = once(controls, "finish");
          report("working");
          await finished;
          return Response.json({ cancelled: instance.signal.aborted });
        }
        if (path === "/background") {
          const listening = once(background, "listening");
          background.listen(0, "127.0.0.1");
          await listening;
        }
        return Response.json({ status: "ok" });
      },
    },
    instance,
    (info) => {
      report("ready", info.port);
    },
  );

  // Acknowledge receipt before the parent releases the earlier pipelined request.
  server.on("request", (request) => {
    if (request.headers["x-shutdown-probe"] === "true") {
      report("probe");
    }
  });
}

main();
