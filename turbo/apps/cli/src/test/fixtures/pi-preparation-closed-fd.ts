import { closeSync } from "node:fs";
import { writePiPreparationTiming } from "../../lib/pi-startup-timing";

closeSync(2);
writePiPreparationTiming("run", {
  phase: "cli_config",
  startedAt: 0,
  finishedAt: 1,
  durationMs: 1,
  outcome: "error",
});
process.stdout.write("still-alive");
