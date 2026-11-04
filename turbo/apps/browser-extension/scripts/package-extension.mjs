import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  copyFile,
  mkdir,
  utimes,
  rm,
} from "node:fs/promises";
import { resolve, basename } from "node:path";

const directory = process.cwd();
const manifest = JSON.parse(
  await readFile(resolve(directory, "manifest.json"), "utf8"),
);
const pkg = JSON.parse(
  await readFile(resolve(directory, "package.json"), "utf8"),
);
if (manifest.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error("Manifest and package must share one three-part version");
}
const files = ["background.js", "manifest.json"];
const dist = resolve(directory, "dist");
await copyFile(
  resolve(directory, "manifest.json"),
  resolve(dist, "manifest.json"),
);
const epoch = new Date("2000-01-01T00:00:00.000Z");
for (const file of files) await utimes(resolve(dist, file), epoch, epoch);
const artifacts = resolve(directory, "artifacts");
await mkdir(artifacts, { recursive: true });
const name = `${basename(directory)}-${pkg.version}.zip`;
const archive = resolve(artifacts, name);
await rm(archive, { force: true });
// -X excludes machine-specific metadata; fixed timestamps/order make bytes stable.
execFileSync("zip", ["-X", "-q", "-j", archive, ...files], {
  cwd: dist,
  env: { ...process.env, TZ: "UTC" },
});
const bytes = await readFile(archive);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(`${archive}.sha256`, `${sha256}  ${name}\n`);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).length >
  0;
await writeFile(
  `${archive}.provenance.json`,
  JSON.stringify(
    {
      extension: basename(directory),
      version: pkg.version,
      sourceCommit: commit,
      dirty,
      sha256,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${name}: ${sha256}`);
