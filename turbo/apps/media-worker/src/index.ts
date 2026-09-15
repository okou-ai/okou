import { z } from "zod";
import { verifyMediaTools } from "./render";
import { createPosterServer } from "./server";

const config = z
  .object({
    secret: z.string().min(32),
    port: z.coerce.number().int().min(1).max(65535).default(8080),
    maxConcurrency: z.coerce.number().int().min(1).max(16).default(2),
    requestTimeoutMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(120_000)
      .default(90_000),
  })
  .parse({
    secret: process.env.MEDIA_WORKER_SECRET,
    port: process.env.PORT,
    maxConcurrency: process.env.MEDIA_WORKER_MAX_CONCURRENCY,
    requestTimeoutMs: process.env.MEDIA_WORKER_REQUEST_TIMEOUT_MS,
  });

// A missing or broken FFmpeg install must fail startup, not every request.
await verifyMediaTools(AbortSignal.timeout(10_000));

const server = createPosterServer(config);
server.listen(config.port, () => {
  process.stdout.write(
    JSON.stringify({
      event: "media_worker_started",
      port: config.port,
      revision: process.env.GIT_COMMIT_SHA,
    }) + "\n",
  );
});
for (const name of ["SIGTERM", "SIGINT"] as const) {
  process.once(name, () => {
    server.close();
  });
}
