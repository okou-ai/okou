import { fileURLToPath } from "node:url";
import { object, string } from "zod";
import { launchGuestTask, type GuestTask } from "../../../lib/guest-task";
import type { ProxyConfiguration } from "./server";

const readySchema = object({
  endpoint: string().regex(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser$/u),
});

export async function launchWindowProxy(config: ProxyConfiguration) {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<string>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  // Observe readiness rejection while the Guest admission report is in flight.
  const observed = ready.then(
    (endpoint) => {
      return { endpoint };
    },
    (error) => {
      return { error };
    },
  );
  const timer = setTimeout(() => {
    return reject(new Error("Scoped Browser startup timed out"));
  }, 30_000);
  let task: GuestTask | undefined;
  try {
    task = await launchGuestTask(
      process.execPath,
      [fileURLToPath(new URL("./browser-proxy-worker.js", import.meta.url))],
      {
        stdout: 2,
        stderr: 2,
        env: process.env,
        onSpawn(child) {
          child.once("error", reject);
          child.once("exit", () => {
            return reject(new Error("Scoped Browser exited during startup"));
          });
          child.once("message", (message: unknown) => {
            const parsed = readySchema.safeParse(message);
            if (parsed.success) resolve(parsed.data.endpoint);
            else reject(new Error("Scoped Browser startup failed"));
          });
          child.send(config);
        },
      },
    );
    const owned = task;
    const result = await observed;
    if ("error" in result) throw result.error;
    return {
      endpoint: result.endpoint,
      detach() {
        if (owned.child.connected) owned.child.disconnect();
        owned.detach();
      },
      stop() {
        return owned.stop();
      },
    };
  } catch (error) {
    if (task) await task.stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
