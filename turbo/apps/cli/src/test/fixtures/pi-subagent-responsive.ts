import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv.at(-1);
if (!directory) throw new Error("Missing fixture directory.");
await open(join(directory, "stdin"), constants.O_RDWR | constants.O_NONBLOCK);
process.on("SIGTERM", () => {
  return process.exit(0);
});
process.stdin.resume();
process.send?.({ type: "ready" });
process.disconnect?.();
setInterval(() => {}, 1000);
