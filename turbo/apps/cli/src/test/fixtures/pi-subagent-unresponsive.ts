import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv.at(-1);
if (!directory) throw new Error("Missing fixture directory.");
await open(join(directory, "stdin"), constants.O_RDWR | constants.O_NONBLOCK);
process.on("SIGTERM", () => {});
const tool = spawn(
  process.execPath,
  [
    "-e",
    "process.on('SIGTERM',()=>{});process.send({type:'ready'});setInterval(()=>{},1000)",
  ],
  {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  },
);
tool.once("message", () => {
  console.log(JSON.stringify({ toolPid: tool.pid }));
  process.send?.({ type: "ready" });
  process.disconnect?.();
});
process.stdin.resume();
setInterval(() => {}, 1000);
