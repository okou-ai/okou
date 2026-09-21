import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELP = `Usage:
  node .github/scripts/publish-presentation-extract-template.mjs prepare --source-archive <tar.gz> --output-dir <dir>
  node .github/scripts/publish-presentation-extract-template.mjs verify --output-dir <dir>
  node .github/scripts/publish-presentation-extract-template.mjs publish --output-dir <dir> --execute

prepare and verify are local operations. publish --execute writes only the
pinned presentation-extract-template storage and its immutable R2 objects.
It requires DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, and R2_USER_STORAGES_BUCKET_NAME.
`;

export function run(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (!["prepare", "verify", "publish"].includes(command)) {
    throw new Error(HELP);
  }
  if (command === "publish" && !options.includes("--execute")) {
    throw new Error("Publication requires the explicit --execute flag.");
  }
  const entry = new URL(
    `./presentation-extract-template-release/${command === "publish" ? "publish" : "local"}-command.mjs`,
    import.meta.url,
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(entry), command, ...options],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${command} terminated by signal ${result.signal}`);
  }
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  run();
}
