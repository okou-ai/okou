import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMMANDS = new Map([
  [
    "build",
    new URL(
      "./presentation-template-release/build-command.mjs",
      import.meta.url,
    ),
  ],
  [
    "verify",
    new URL(
      "./presentation-template-release/verify-command.mjs",
      import.meta.url,
    ),
  ],
  [
    "publish",
    new URL(
      "./presentation-template-release/publish-command.mjs",
      import.meta.url,
    ),
  ],
]);

export function run(args = process.argv.slice(2)) {
  const [mode, ...options] = args;
  const commandUrl = COMMANDS.get(mode);
  if (!commandUrl) {
    throw new Error(
      "Usage: publish-presentation-template-archives.mjs <build|verify|publish> [options]",
    );
  }

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(commandUrl), ...options],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${mode} terminated by signal ${result.signal}`);
  }
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  run();
}
