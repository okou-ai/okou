import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("stages exactly the current Swift helpers after an incremental build", () => {
  const directory = mkdtempSync(join(tmpdir(), "desktop-native-build-"));
  temporaryDirectories.push(directory);
  const scripts = join(directory, "scripts");
  const binaries = join(directory, "bin");
  const native = join(directory, "native", "dist", "native");
  const symbols = join(directory, "native", "dist", "symbols");
  for (const path of [scripts, binaries, native]) {
    mkdirSync(path, { recursive: true });
  }
  copyFileSync(
    resolve(__dirname, "../scripts/build-native-helper.js"),
    join(scripts, "build-native-helper.js"),
  );
  const platformOverride = join(directory, "darwin.cjs");
  writeFileSync(
    platformOverride,
    'Object.defineProperty(process, "platform", { value: "darwin" });',
  );
  writeFileSync(join(native, "obsolete-helper"), "previous build");
  mkdirSync(join(native, "obsolete-runtime"));
  writeFileSync(join(native, "obsolete-runtime", "entry.js"), "previous build");
  writeFileSync(join(native, "computer-use-helper"), "previous helper");

  // Exercise the real build entry point; only the external macOS toolchain
  // is replaced with command-line fixtures on non-macOS test hosts.
  for (const [name, source] of [
    [
      "swift",
      `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
assert.deepEqual(process.argv.slice(2, 4), ["build", "--package-path"]);
assert.deepEqual(process.argv.slice(5), ["-c", "release"]);
const output = path.join(process.argv[4], ".build", "release");
fs.mkdirSync(output, { recursive: true });
for (const name of ["computer-use-helper", "screen-recorder-helper"]) {
  fs.writeFileSync(path.join(output, name), name + " current");
}
`,
    ],
    [
      "dsymutil",
      `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
assert.equal(process.argv[3], "-o");
fs.mkdirSync(process.argv[4], { recursive: true });
fs.writeFileSync(path.join(process.argv[4], "symbols"), path.basename(process.argv[2]));
`,
    ],
  ] as const) {
    const executable = join(binaries, name);
    writeFileSync(executable, `#!${process.execPath}\n${source}`);
    chmodSync(executable, 0o755);
  }

  const result = spawnSync(
    process.execPath,
    ["--require", platformOverride, join(scripts, "build-native-helper.js")],
    {
      encoding: "utf8",
      env: {
        PATH: [binaries, process.env.PATH].filter(Boolean).join(delimiter),
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const helpers = ["computer-use-helper", "screen-recorder-helper"];
  expect(readdirSync(native).sort()).toEqual(helpers);
  for (const helper of helpers) {
    expect(readFileSync(join(native, helper), "utf8")).toBe(
      `${helper} current`,
    );
    expect(statSync(join(native, helper)).mode & 0o777).toBe(0o755);
    expect(
      readFileSync(join(symbols, `${helper}.dSYM`, "symbols"), "utf8"),
    ).toBe(helper);
  }
});
