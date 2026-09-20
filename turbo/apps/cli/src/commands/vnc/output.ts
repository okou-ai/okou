import type { VncOutcome } from "./protocol";
import { VncCommandError } from "./validation";

function failureMessage(result: Extract<VncOutcome, { reason: string }>) {
  const delivery = "delivery" in result ? result.delivery : undefined;
  let guidance =
    "Check VNC access, the saved host configuration and this command's --help before proceeding.";
  if (result.outcome === "unknown" || delivery === "unknown")
    guidance =
      "The operation may have taken effect. Never replay automatically; inspect session list/status and take a fresh screenshot.";
  else if (result.reason === "permission_denied")
    guidance = "Ask the owner to grant VNC access and start a new Run.";
  else if (result.reason === "stale_geometry")
    guidance =
      "Take a fresh screenshot and re-evaluate the intended coordinates.";
  else if (result.reason === "timed_out")
    guidance =
      "The VNC operation exceeded its time budget. Check reachability from the Runner network, confirm the server promptly sends an RFB banner, and inspect relevant firewall or VNC server logs; this result does not identify which component was silent.";
  return `VNC ${result.outcome}: ${result.reason}${delivery ? `; delivery=${delivery}` : ""}. ${guidance}`;
}

export function outputVncOutcome(result: VncOutcome, json?: boolean): void {
  const failed = ["failed", "not_started", "unknown"].includes(result.outcome);
  process.exitCode = failed || result.cleanupReason ? 1 : 0;
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  switch (result.outcome) {
    case "started":
    case "status":
      console.log(
        `${result.session.sessionId}  ${result.session.connectionId}  requested mode: ${result.session.mode}\nUse okou vnc screenshot ${result.session.sessionId} --output <file> --json for a fresh image and geometry. Close with okou vnc session close ${result.session.sessionId} --json when finished.`,
      );
      break;
    case "listed":
      if (!result.sessions.length)
        console.log(
          "No active VNC sessions in this Run. Use okou vnc host list --json, then vnc session start with an explicit --mode.",
        );
      for (const session of result.sessions)
        console.log(
          `${session.sessionId}  ${session.connectionId}  requested mode: ${session.mode}`,
        );
      break;
    case "closed":
      console.log(
        "VNC session closed. Other viewers are governed by the VNC server.",
      );
      break;
    case "captured":
      console.log(
        `${result.path}\n${result.width}x${result.height}, ${result.bytes} bytes, SHA-256 ${result.sha256}\nGeometry: ${JSON.stringify(result.geometry)}\nUse this geometry for coordinate input; take another screenshot after input to inspect the result.`,
      );
      break;
    case "sent":
      console.log(
        "VNC input was written and flushed; this is not application acknowledgement. Take a fresh screenshot to inspect the result.",
      );
      break;
    case "failed":
    case "not_started":
    case "unknown": {
      console.error(failureMessage(result));
      break;
    }
  }
  if (result.cleanupReason)
    console.error(
      `VNC local cleanup failed: ${result.cleanupReason}.${result.residue ? ` Private staging remains at ${result.residue}.` : ""}`,
    );
}

export function outputVncCommandError(
  error: unknown,
  json: boolean | undefined,
  input: boolean,
): void {
  if (!(error instanceof VncCommandError)) throw error;
  process.exitCode = 1;
  if (json) {
    console.log(
      JSON.stringify({
        outcome: input ? "not_started" : "failed",
        reason: error.reason,
        delivery: "not_dispatched",
      }),
    );
  } else console.error(`VNC request was not dispatched: ${error.message}`);
}
