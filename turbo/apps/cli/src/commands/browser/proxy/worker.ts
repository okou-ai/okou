import { object, string, number, url } from "zod";
import { configureGlobalProxyFromEnv } from "../../../lib/network/proxy";
import { startWindowProxy } from "./server";

const configuration = object({
  cdpUrl: url(),
  runtimeId: string().regex(/^[a-p]{32}$/u),
  windowId: number().int().nonnegative().safe(),
}).strict();

const owner = new AbortController();
process.once("SIGTERM", () => {
  return owner.abort();
});
process.once("SIGINT", () => {
  return owner.abort();
});
let configured = false;
process.once("disconnect", () => {
  if (!configured) owner.abort();
});
process.once("message", (input: unknown) => {
  configured = true;
  run(input).catch(() => {
    process.exitCode = 1;
    process.send?.({ error: "Scoped Browser setup failed" });
    owner.abort();
    process.disconnect?.();
  });
});

async function run(input: unknown): Promise<void> {
  const config = configuration.parse(input);
  await configureGlobalProxyFromEnv();
  const proxy = await startWindowProxy(config, owner.signal);
  if (!process.send) {
    await proxy.close();
    throw new Error("Private startup pipe required");
  }
  process.send({ endpoint: proxy.endpoint });
  await proxy.closed;
  // The task runtime owns only its proxy sockets; exit releases any closing IO.
  process.exit(process.exitCode ?? 0);
}
