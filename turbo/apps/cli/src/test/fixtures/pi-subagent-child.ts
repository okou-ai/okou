import { runPiSubagentLoop } from "../../lib/pi-subagent-loop";

const [command, directory] = process.argv.slice(2);
if (command !== "__subagent_loop__" || !directory) {
  throw new Error("Expected a subagent loop invocation.");
}
try {
  await runPiSubagentLoop(directory, process.env.OKOU_PI_RUNTIME_ROOT);
} finally {
  process.exit(process.exitCode ?? 0);
}
