const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { packagedAppPaths } = require("./packaged-app-paths");
const { resolveDesktopBuildConfig } = require("./desktop-build-config");
const { readDesktopSmokeEvidence } = require("./desktop-smoke-evidence");

const LAUNCH_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 128 * 1024;

if (process.platform !== "darwin") {
  throw new Error("Packaged desktop smoke tests are only supported on macOS.");
}

const { executablePath, mainBundlePath, mcpBundlePath, appBundlePath } =
  packagedAppPaths({
    appBundlePath: process.env.OKOU_DESKTOP_SMOKE_APP_PATH,
  });

if (process.argv.includes("--signed")) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", appBundlePath], {
    stdio: "pipe",
  });
}

if (!fs.existsSync(executablePath)) {
  throw new Error(`Packaged app executable was not found at ${executablePath}`);
}

if (!fs.existsSync(mcpBundlePath)) {
  throw new Error(
    `Packaged filesystem MCP bundle was not found at ${mcpBundlePath}`,
  );
}

function assertNoUnbundledRequires(bundlePath, bundle, prefixes, guidance) {
  for (const prefix of prefixes) {
    for (const unbundledRequire of [
      `require("${prefix}`,
      `require('${prefix}`,
    ]) {
      if (bundle.includes(unbundledRequire)) {
        throw new Error(
          `Packaged bundle contains an unbundled require (${unbundledRequire}...) in ${bundlePath}. ${guidance}`,
        );
      }
    }
  }
}

function assertNoUnbundledEsmImports(bundlePath, bundle, prefixes, guidance) {
  const lines = bundle.split(/\r?\n/);
  for (const prefix of prefixes) {
    for (const importSpecifier of [`"${prefix}`, `'${prefix}`]) {
      const lineIndex = lines.findIndex((line) => {
        const trimmed = line.trimStart();
        return (
          trimmed.startsWith("import ") && trimmed.includes(importSpecifier)
        );
      });
      if (lineIndex !== -1) {
        throw new Error(
          `Packaged bundle contains an unbundled import (${importSpecifier}...) in ${bundlePath}:${lineIndex + 1}. ${guidance}`,
        );
      }
    }
  }
}

const mainBundle = fs.readFileSync(mainBundlePath, "utf8");
assertNoUnbundledRequires(
  mainBundlePath,
  mainBundle,
  ["@okouai/", "@modelcontextprotocol/sdk/"],
  "These packages must be bundled via tsup noExternal; see tsup.electron.config.js.",
);
console.log("Main bundle dependency verification passed");

const mcpBundle = fs.readFileSync(mcpBundlePath, "utf8");
const unbundledMcpPrefixes = ["@modelcontextprotocol/sdk"];
assertNoUnbundledRequires(
  mcpBundlePath,
  mcpBundle,
  unbundledMcpPrefixes,
  "These packages must be bundled via tsup noExternal; see tsup.mcp-filesystem.config.js.",
);
assertNoUnbundledEsmImports(
  mcpBundlePath,
  mcpBundle,
  unbundledMcpPrefixes,
  "These packages must be bundled via tsup noExternal; see tsup.mcp-filesystem.config.js.",
);
console.log("Filesystem MCP bundle dependency verification passed");

const child = spawn(executablePath, [], {
  env: {
    ...process.env,
    OKOU_DESKTOP_SMOKE_TEST: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let outputBytes = 0;
let outputExceeded = false;
let timedOut = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  outputBytes += Buffer.byteLength(chunk);
  if (outputBytes > OUTPUT_LIMIT) {
    outputExceeded = true;
    child.kill("SIGKILL");
  } else stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  outputBytes += Buffer.byteLength(chunk);
  if (outputBytes > OUTPUT_LIMIT) {
    outputExceeded = true;
    child.kill("SIGKILL");
  }
});

const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, LAUNCH_TIMEOUT_MS);

child.on("error", () => {
  clearTimeout(timeout);
  console.error("Packaged verification failed: launch_failed");
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  clearTimeout(timeout);
  try {
    if (code !== 0 || signal !== null || timedOut || outputExceeded) {
      throw new Error("process_failed");
    }
    const evidence = readDesktopSmokeEvidence(
      stdout,
      resolveDesktopBuildConfig().identity,
    );
    const report = {
      kind: "startup",
      processExit: { code, signal, timedOut, outputExceeded },
      evidence,
    };
    if (process.env.OKOU_DESKTOP_SMOKE_EVIDENCE_PATH) {
      fs.mkdirSync(path.dirname(process.env.OKOU_DESKTOP_SMOKE_EVIDENCE_PATH), {
        recursive: true,
      });
      fs.writeFileSync(
        process.env.OKOU_DESKTOP_SMOKE_EVIDENCE_PATH,
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    console.log(JSON.stringify(report));
  } catch {
    // Electron stderr can contain user paths. Never copy raw child output
    // into CI artifacts, including on malformed or oversized evidence.
    console.error(
      `Packaged verification failed: code=${code} signal=${signal} timedOut=${timedOut} outputExceeded=${outputExceeded}`,
    );
    process.exitCode = 1;
  }
});
