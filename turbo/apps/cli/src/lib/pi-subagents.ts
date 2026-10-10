import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, openSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as scheduleTimeout, clearTimeout } from "node:timers";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

import { PI_SESSION_ROLE_ENV, requirePiParentSession } from "./pi-session-env";

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
  requirePiParentSession();
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
  // Disposable task control/log files: deletion is intentionally best effort.
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function allocateDirectory(): Promise<{ id: string; directory: string }> {
  const root = runDirectory();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const names = await readdir(root);
  let id =
    names.reduce((max, name) => {
      return ID_PATTERN.test(name) && BigInt(name) > max ? BigInt(name) : max;
    }, 0n) + 1n;
  for (;;) {
    const directory = join(root, String(id));
    try {
      await mkdir(directory, { mode: 0o700 });
      return { id: String(id), directory };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      id += 1n;
    }
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
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await execFileAsync("mkfifo", ["-m", "600", join(directory, "stdin")]);
    const stdout = openSync(join(directory, "stdout"), "wx", 0o600);
    descriptors.push(stdout);
    const stderr = openSync(join(directory, "stderr"), "wx", 0o600);
    descriptors.push(stderr);
    child = spawn(
      process.execPath,
      [
        ...(options.execArgv ?? process.execArgv),
        entry,
        LOOP_COMMAND,
        directory,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ["pipe", stdout, stderr, "ipc"],
        env: {
          ...process.env,
          [PI_SESSION_ROLE_ENV]: "child",
          OKOU_PI_SESSION_ID: randomUUID(),
          OKOU_PI_PREPARATION_TIMING: "0",
        },
      },
    );
    const started = child;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = scheduleTimeout(() => {
        return onError(new Error("Subagent startup timed out."));
      }, 10_000);
      const cleanup = () => {
        clearTimeout(timer);
        started.off("message", onMessage);
        started.off("error", onError);
        started.off("exit", onExit);
      };
      const onMessage = (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ready"
        ) {
          cleanup();
          resolve();
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Subagent exited before startup. Check its stderr."));
      };
      started.on("message", onMessage);
      started.once("error", onError);
      started.once("exit", onExit);
    });
    const bootstrap = async () => {
      if (!started.pid) throw new Error("Subagent has no PID.");
      await writeFile(join(directory, "pid"), `${started.pid}\n`, {
        mode: 0o600,
      });
      await new Promise<void>((done, fail) => {
        const stdin = started.stdin;
        if (!stdin) {
          fail(new Error("Subagent has no bootstrap input."));
          return;
        }
        stdin.once("error", fail);
        stdin.end(JSON.stringify({ prompt }), () => {
          stdin.off("error", fail);
          done();
        });
      });
    };
    await Promise.all([ready, bootstrap()]);
    started.unref();
    return {
      id,
      pid: started.pid ?? 0,
      running: true,
      stdout: join(directory, "stdout"),
      stderr: join(directory, "stderr"),
    };
  } catch (error) {
    if (child?.pid) signalProcessGroup(child.pid, "SIGKILL");
    await removeSubagentDirectory(directory);
    throw error;
  } finally {
    for (const fd of descriptors) closeSync(fd);
  }
}

interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly start: string;
  readonly group: number;
}

async function processIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const start = fields[19];
    if (!state || !start || state === "Z") return undefined;
    return { pid, ppid: Number(fields[1]), group: Number(fields[2]), start };
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return undefined;
    throw error;
  }
}

async function isOwnedProcess(
  pid: number,
  directory: string,
): Promise<boolean> {
  if (!(await processIdentity(pid))) return false;
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
  let pid: number;
  try {
    pid = Number((await readFile(join(directory, "pid"), "utf8")).trim());
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
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
  const item = await inspectSubagent(id);
  if (!item.running) throw new Error(`Subagent ${id} is not running.`);
  if (!prompt.trim())
    throw new Error("A non-empty steering prompt is required.");
  const frame = Buffer.from(`${JSON.stringify({ prompt })}\n`);
  // One atomic Linux PIPE_BUF write prevents concurrent steering frames interleaving.
  if (frame.length > 4096)
    throw new Error("Steering input exceeds the 4096-byte FIFO frame limit.");
  const fifo = await open(
    join(taskDirectory(id), "stdin"),
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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
}

async function descendants(
  parent: ProcessIdentity,
): Promise<ProcessIdentity[]> {
  const identities = (
    await Promise.all(
      (await readdir("/proc"))
        .filter((name) => {
          return /^\d+$/u.test(name);
        })
        .map((name) => {
          return processIdentity(Number(name));
        }),
    )
  ).filter((item) => {
    return item !== undefined;
  });
  const result = [parent];
  for (let index = 0; index < result.length; index += 1) {
    const current = result[index];
    result.push(
      ...identities.filter((item) => {
        return item.ppid === current?.pid;
      }),
    );
  }
  return result;
}

async function sameProcess(identity: ProcessIdentity): Promise<boolean> {
  return (await processIdentity(identity.pid))?.start === identity.start;
}

export async function killSubagent(id: string): Promise<void> {
  const item = await inspectSubagent(id);
  const directory = taskDirectory(id);
  const parent = await processIdentity(item.pid);
  if (!item.running || !parent) {
    await removeSubagentDirectory(directory);
    return;
  }
  let owned = await descendants(parent);
  if (await sameProcess(parent)) {
    try {
      process.kill(item.pid, "SIGTERM");
    } catch (error) {
      if (!hasCode(error, "ESRCH")) throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while ((await sameProcess(parent)) && Date.now() < deadline)
    await setTimeout(25);
  if (await sameProcess(parent))
    owned = [...owned, ...(await descendants(parent))];
  // Pi aborts its active Bash tools first. Also cover detached tool groups on escalation.
  for (const identity of owned.reverse()) {
    if (await sameProcess(identity)) {
      if (identity.group === identity.pid)
        signalProcessGroup(identity.pid, "SIGKILL");
      try {
        process.kill(identity.pid, "SIGKILL");
      } catch (error) {
        if (!hasCode(error, "ESRCH")) throw error;
      }
    }
  }
  const exitDeadline = Date.now() + 5_000;
  while ((await Promise.all(owned.map(sameProcess))).some(Boolean)) {
    if (Date.now() >= exitDeadline)
      throw new Error(
        `Subagent ${id} did not exit; its directory was retained.`,
      );
    await setTimeout(25);
  }
  await removeSubagentDirectory(directory);
}
