const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "darwin") {
  console.log(
    `Skipping native helper build on ${process.platform} (macOS-only).`,
  );
  process.exit(0);
}

const appRoot = path.resolve(__dirname, "..");
const packageRoot = path.join(appRoot, "native", "computer-use-helper");
const distDir = path.join(appRoot, "native", "dist", "native");
const symbolsDir = path.join(appRoot, "native", "dist", "symbols");

// Both executables ship from one SwiftPM package, but they run as separate
// processes: the Computer Use client kills and respawns its helper on command
// timeouts, which would destroy an in-flight screen capture.
const helperNames = ["computer-use-helper", "screen-recorder-helper"];

execFileSync(
  "swift",
  ["build", "--package-path", packageRoot, "-c", "release"],
  {
    stdio: "inherit",
  },
);

// This generated directory is copied wholesale into the application. Rebuild
// its contents so incremental packaging cannot retain retired native helpers.
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(symbolsDir, { recursive: true });

for (const helperName of helperNames) {
  const buildOutput = path.join(packageRoot, ".build", "release", helperName);
  const distOutput = path.join(distDir, helperName);
  const symbolsOutput = path.join(symbolsDir, `${helperName}.dSYM`);

  fs.copyFileSync(buildOutput, distOutput);
  fs.chmodSync(distOutput, 0o755);

  fs.rmSync(symbolsOutput, { recursive: true, force: true });
  execFileSync("dsymutil", [buildOutput, "-o", symbolsOutput], {
    stdio: "inherit",
  });
}
