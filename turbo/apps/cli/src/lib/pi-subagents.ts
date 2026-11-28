import { execFile } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { PI_SESSION_ROLE_ENV, requirePiSession } from "./pi-session-env";
import {
  guestTaskStartupSchema,
  launchGuestTask,
  stopGuestTask,
  type GuestTask,
} from "./guest-task";

const execFileAsync = promisify(execFile);
const ID_PATTERN = /^[1-9]\d*$/u;
const LOOP_COMMAND = "__subagent_loop__";

export interface SubagentLaunchOptions {
  readonly entry?: string;
  readonly execArgv?: readonly string[];
}

export interface SubagentInspection {
  readonly id: string;
  readonly pid: number;
  readonly running: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function environmentRunDirectory(): string {
  const runId = process.env.OKOU_RUN_ID;
  if (!runId || !/^[a-zA-Z0-9-]+$/u.test(runId))
    throw new Error("Invalid Pi Run ID.");
  return join(process.env.OKOU_PI_RUNTIME_ROOT ?? "/tmp/pi", runId);
}

function runDirectory(): string {
  requirePiSession();
  return environmentRunDirectory();
}

export function validateSubagentDirectory(directory: string): void {
  const path = resolve(directory);
  if (
    dirname(path) !== resolve(environmentRunDirectory()) ||
    !ID_PATTERN.test(basename(path))
  ) {
    throw new Error(
      "The child directory must be a numeric subagent ID in the current Run.",
    );
  }
}

function taskDirectory(id: string): string {
  if (!ID_PATTERN.test(id))
    throw new Error("Subagent ID must be a positive integer.");
  return join(runDirectory(), id);
}

export async function removeSubagentDirectory(
  directory: string,
): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function readTask(directory: string) {
  try {
    return guestTaskStartupSchema.parse(
      JSON.parse(await readFile(join(directory, "task"), "utf8")),
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function allocateDirectory(): Promise<{ id: string; directory: string }> {
  const root = runDirectory();
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Reservations live for the Run, even after disposable task directories go.
  // mkdir both allocates safely across callers and avoids reusing a stale ID.
  const reservations = join(root, ".ids");
  await mkdir(reservations, { recursive: true, mode: 0o700 });
  const names = await readdir(reservations);
  let id =
    names.reduce((max, name) => {
      return ID_PATTERN.test(name) && BigInt(name) > max ? BigInt(name) : max;
    }, 0n) + 1n;
  for (;;) {
    const directory = join(root, String(id));
    try {
      await mkdir(join(reservations, String(id)), { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      id += 1n;
      continue;
    }
    await mkdir(directory, { mode: 0o700 });
    return { id: String(id), directory };
  }
}

export async function startSubagent(
  prompt: string,
  options: SubagentLaunchOptions = {},
): Promise<SubagentInspection> {
  if (!prompt.trim())
    throw new Error("A non-empty subagent prompt is required.");
  if (Buffer.byteLength(JSON.stringify({ prompt })) > 1024 * 1024)
    throw new Error("Subagent prompt exceeds 1 MiB.");
  const entry = options.entry ?? process.argv[1];
  if (!entry)
    throw new Error("Cannot locate the current Okou CLI entry point.");
  const { id, directory } = await allocateDirectory();
  const descriptors: number[] = [];
  let task: GuestTask | undefined;
  try {
    await execFileAsync("mkfifo", ["-m", "600", join(directory, "stdin")]);
    const stdout = openSync(join(directory, "stdout"), "wx", 0o600);
    descriptors.push(stdout);
    const stderr = openSync(join(directory, "stderr"), "wx", 0o600);
    descriptors.push(stderr);
    task = await launchGuestTask(
      process.execPath,
      [
        ...(options.execArgv ?? process.execArgv),
        entry,
        LOOP_COMMAND,
        directory,
      ],
      {
        stdout,
        stderr,
        env: {
          ...process.env,
          [PI_SESSION_ROLE_ENV]: "child",
          OKOU_PI_PREPARATION_TIMING: "0",
        },
      },
    );
    await writeFile(
      join(directory, "task.pending"),
      JSON.stringify({ handle: task.handle, pid: task.pid }),
      { mode: 0o600, flag: "wx" },
    );
    // Readers see a complete record; this is not an application readiness gate.
    await rename(join(directory, "task.pending"), join(directory, "task"));
    const stdin = task.child.stdin;
    if (!stdin) throw new Error("Subagent has no bootstrap input.");
    await new Promise<void>((done, fail) => {
      stdin.once("error", fail);
      stdin.once("close", () => {
        stdin.off("error", fail);
      });
      stdin.end(JSON.stringify({ prompt }), (error?: Error | null) => {
        if (error) fail(error);
        else done();
      });
    });
    task.detach();
    return {
      id,
      pid: task.pid,
      running: true,
      stdout: join(directory, "stdout"),
      stderr: join(directory, "stderr"),
    };
  } catch (error) {
    if (task) {
      try {
        await task.stop();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Subagent startup and Guest cleanup failed; its directory was retained.",
        );
      }
    }
    await removeSubagentDirectory(directory);
    throw error;
  } finally {
    for (const fd of descriptors) closeSync(fd);
  }
}

async function isOwnedProcess(
  pid: number,
  directory: string,
): Promise<boolean> {
  try {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    return argv.includes(LOOP_COMMAND) && argv.includes(directory);
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return false;
    throw error;
  }
}

async function readInspection(
  id: string,
): Promise<SubagentInspection | undefined> {
  const directory = taskDirectory(id);
  const task = await readTask(directory);
  if (!task) return undefined;
  const { pid } = task;
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error(`Subagent ${id} has an invalid PID.`);
  return {
    id,
    pid,
    running: await isOwnedProcess(pid, directory),
    stdout: join(directory, "stdout"),
    stderr: join(directory, "stderr"),
  };
}

export async function inspectSubagent(id: string): Promise<SubagentInspection> {
  const item = await readInspection(id);
  if (!item)
    throw new Error(`Subagent ${id} was not found or is still starting.`);
  return item;
}

export async function listSubagents(): Promise<SubagentInspection[]> {
  const root = runDirectory();
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const result: SubagentInspection[] = [];
  for (const id of names
    .filter((name) => {
      return ID_PATTERN.test(name);
    })
    .sort((a, b) => {
      return BigInt(a) < BigInt(b) ? -1 : 1;
    })) {
    // Directories may disappear or have no pid yet; list is a live view.
    const item = await readInspection(id);
    if (item?.running) result.push(item);
  }
  return result;
}

export async function steerSubagent(id: string, prompt: string): Promise<void> {
  const directory = taskDirectory(id);
  const task = await readTask(directory);
  if (!task || !(await isOwnedProcess(task.pid, directory)))
    throw new Error(`Subagent ${id} is not running.`);
  if (!prompt.trim())
    throw new Error("A non-empty steering prompt is required.");
  const frame = Buffer.from(`${JSON.stringify({ prompt })}\n`);
  // One atomic Linux PIPE_BUF write prevents concurrent steering frames interleaving.
  if (frame.length > 4096)
    throw new Error("Steering input exceeds the 4096-byte FIFO frame limit.");
  const fifo = await open(
    join(directory, "stdin"),
    constants.O_WRONLY | constants.O_NONBLOCK,
  );
  try {
    const { bytesWritten } = await fifo.write(frame);
    if (bytesWritten !== frame.length)
      throw new Error("Could not write the complete steering frame.");
  } finally {
    await fifo.close();
  }
}

export async function killSubagent(id: string): Promise<void> {
  const directory = taskDirectory(id);
  const task = await readTask(directory);
  if (!task)
    throw new Error(`Subagent ${id} was not found or is still starting.`);
  await stopGuestTask(task.handle);
  await removeSubagentDirectory(directory);
}
