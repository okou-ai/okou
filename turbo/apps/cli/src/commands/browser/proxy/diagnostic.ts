import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enum as zEnum,
  iso,
  number,
  strictObject,
  uuid,
  type infer as zInfer,
} from "zod";
import { decodeSandboxTokenPayload } from "../../../lib/api/sandbox-token";

const closeCodeSchema = number().int().min(1000).max(4999);
const exitSchema = strictObject({
  reason: zEnum([
    "owner-cancelled",
    "upstream-socket-closed",
    "upstream-socket-error",
    "control-transport-retired",
    "native-client-aborted",
    "window-removed",
    "window-refresh-failed",
    "window-cleanup-failed",
    "last-client-disconnected",
    "unclaimed-listener-timeout",
    "startup-failed",
    "closed",
  ]),
  closeCode: closeCodeSchema.optional(),
});

const recordSchema = exitSchema.extend({
  instanceId: uuid(),
  closedAt: iso.datetime(),
});

export type ProxyExit = zInfer<typeof exitSchema>;
export type TimedProxyExit = ProxyExit & { readonly closedAt: string };
const MAX_DIAGNOSTIC_BYTES = 512;

function recordPath(): string | undefined {
  // Tool shells share the Run token with their Guest tasks. They need not
  // inherit the agent process's separate OKOU_RUN_ID environment variable.
  const run = uuid().safeParse(decodeSandboxTokenPayload()?.runId);
  if (run.success) {
    return join(tmpdir(), `okou-browser-proxy-exit-${run.data}.json`);
  }
  return undefined;
}

export async function writeProxyDiagnostic(
  instanceId: string,
  exit: TimedProxyExit,
): Promise<void> {
  const path = recordPath();
  if (!path) return;
  const staged = `${path}.${randomUUID()}`;
  try {
    await writeFile(staged, JSON.stringify({ ...exit, instanceId }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(staged, path);
  } catch {
    await rm(staged, { force: true }).catch(() => {});
  }
}

export async function readProxyDiagnostic() {
  const path = recordPath();
  if (!path) return null;
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await file.stat()).isFile()) return null;
      const buffer = Buffer.alloc(MAX_DIAGNOSTIC_BYTES + 1);
      const { bytesRead } = await file.read(buffer);
      if (bytesRead > MAX_DIAGNOSTIC_BYTES) return null;
      const result = recordSchema.safeParse(
        JSON.parse(buffer.toString("utf8", 0, bytesRead)),
      );
      return result.success ? result.data : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
