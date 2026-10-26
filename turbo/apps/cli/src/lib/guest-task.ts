import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { number, strictObject, string } from "zod";

const GUEST_TASK_EXEC = "/usr/local/bin/guest-task-exec";
// One consumer deadline covers connection, placement and private reporting.
const HELPER_TIMEOUT_MS = 30_000;
const MAX_REPORT_BYTES = 4_096;
export const guestTaskStartupSchema = strictObject({
  handle: string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  ),
  pid: number().int().positive().max(0xffff_ffff),
});

export interface GuestTask {
  readonly handle: string;
  readonly pid: number;
  readonly child: ChildProcess;
  detach(): void;
  stop(): Promise<void>;
}

export interface GuestTaskLaunchOptions {
  readonly stdout: number;
  readonly stderr: number;
  readonly env: NodeJS.ProcessEnv;
  /** Install application listeners synchronously, before native admission. */
  readonly onSpawn: (child: ChildProcess) => void;
}

function observeClose(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("close", resolve);
  });
}

async function waitForClose(
  closed: Promise<number | null>,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error("Guest task process did not exit before its deadline"),
          );
        }, HELPER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readStartup(report: Readable, pid: number | undefined) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of report as AsyncIterable<unknown>) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("Guest task launcher returned invalid report bytes");
    }
    size += chunk.length;
    if (size > MAX_REPORT_BYTES) {
      throw new Error(
        "Guest task launcher returned an oversized startup report",
      );
    }
    chunks.push(chunk);
  }
  const record = Buffer.concat(chunks).toString("utf8");
  if (!record.endsWith("\n")) {
    throw new Error(
      "Guest task launcher exited without a complete startup report",
    );
  }
  const startup = guestTaskStartupSchema.parse(JSON.parse(record));
  if (startup.pid !== pid) {
    throw new Error("Guest task launcher reported a different process ID");
  }
  return startup;
}

export async function stopGuestTask(handle: string): Promise<void> {
  guestTaskStartupSchema.shape.handle.parse(handle);
  const helper = spawn(GUEST_TASK_EXEC, ["stop", handle], {
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
    timeout: HELPER_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const closed = observeClose(helper);
  let spawnError: Error | undefined;
  helper.once("error", (error) => {
    spawnError = error;
  });
  let code: number | null;
  try {
    code = await waitForClose(closed);
  } finally {
    helper.kill("SIGKILL");
  }
  if (spawnError) throw spawnError;
  if (code !== 0) {
    throw new Error(
      `Guest task stop failed (exit ${code}, signal ${helper.signalCode})`,
    );
  }
}

/** Admit a background runtime through the Guest owner; never spawn it unmanaged. */
export async function launchGuestTask(
  program: string,
  args: string[],
  output: number | GuestTaskLaunchOptions,
): Promise<GuestTask> {
  const child = spawn(
    GUEST_TASK_EXEC,
    ["--report-fd", "3", "--", program, ...args],
    {
      // A task also needs its own process group to survive caller-group cleanup.
      detached: true,
      env: typeof output === "number" ? process.env : output.env,
      stdio:
        typeof output === "number"
          ? ["ignore", output, output, "pipe"]
          : ["pipe", output.stdout, output.stderr, "pipe", "ipc"],
    },
  );
  const closed = observeClose(child);
  const report = child.stdio[3];
  child.once("error", (error) => {
    if (report instanceof Readable) report.destroy(error);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof output !== "number") output.onSpawn(child);
    if (!(report instanceof Readable)) {
      throw new Error(
        "Guest task launcher did not open its private report pipe",
      );
    }
    timer = setTimeout(() => {
      report.destroy(new Error("Guest task startup report timed out"));
    }, HELPER_TIMEOUT_MS);
    const startup = await readStartup(report, child.pid);
    return {
      ...startup,
      child,
      detach() {
        child.unref();
      },
      async stop() {
        try {
          await stopGuestTask(startup.handle);
        } finally {
          // Runtime exit also triggers the broker's descendant-cleanup owner.
          child.kill("SIGKILL");
          await waitForClose(closed);
        }
      },
    };
  } catch (error) {
    if (report instanceof Readable) report.destroy();
    child.kill("SIGKILL");
    await waitForClose(closed);
    throw new Error(
      "Could not start a managed Guest task. The Guest task launcher and active operation are required.",
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    if (report instanceof Readable) report.destroy();
  }
}
