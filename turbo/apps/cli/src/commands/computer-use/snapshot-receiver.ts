import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isSnapshotId,
  requestSnapshotWorker,
  verifiedSnapshot,
} from "./snapshot-channel";

const worker = new URL("./snapshot-receiver-worker.js", import.meta.url);

export function snapshotReceiverMode(): "auto" | "relay" | undefined {
  if (
    process.platform !== "linux" ||
    process.env.OKOU_COMPUTER_USE_SNAPSHOT_MODE === "control" ||
    !existsSync(worker)
  )
    return undefined;
  return process.env.OKOU_COMPUTER_USE_SNAPSHOT_MODE === "relay"
    ? "relay"
    : "auto";
}

export function prepareSnapshotReceiver(session: string, commandId: string) {
  const attempt = { session, warm: false };
  if (!isSnapshotId(commandId)) return attempt;
  // The authoritative command wait must start immediately, including on a cold start.
  void requestSnapshotWorker(session, "watch " + commandId)
    .then((state) => {
      attempt.warm = state.toString() === "warm";
    })
    .catch(() => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(worker), session, commandId],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.on("error", () => {
        /* The ordinary artifact path still owns delivery. */
      });
      child.unref();
    });
  return attempt;
}

export async function takeSnapshot(
  session: string,
  commandId: string,
  result: Record<string, unknown>,
) {
  if (
    !isSnapshotId(result.snapshotId) ||
    typeof result.snapshotKey !== "string"
  )
    return null;
  const packet = await requestSnapshotWorker(
    session,
    "take " + commandId + " " + result.snapshotId,
  ).catch(() => {
    return Buffer.alloc(0);
  });
  return verifiedSnapshot(
    packet,
    commandId,
    result.snapshotId,
    result.snapshotKey,
    result.snapshotSha256,
  );
}
