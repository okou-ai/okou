import { closeSync, openSync, readSync, statSync } from "node:fs";

// Only stderr is eligible for display. Turbo's stdout JSON can contain secrets.
const [stderrPath, stdoutPath] = process.argv.slice(2);
const size = statSync(stderrPath).size;
const offset = Math.max(0, size - 32 * 1024);
const buffer = Buffer.alloc(size - offset);
const fd = openSync(stderrPath, "r");
let diagnostic;
try {
  diagnostic = buffer
    .subarray(0, readSync(fd, buffer, 0, buffer.length, offset))
    .toString("utf8");
} finally {
  closeSync(fd);
}
// Discard a cut first line rather than showing a partially captured credential.
if (offset > 0) {
  const newline = diagnostic.indexOf("\n");
  diagnostic = newline < 0 ? "" : diagnostic.slice(newline + 1);
}
diagnostic = diagnostic
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

// Read credential values only for masking; never print the environment itself.
const secrets = Object.entries(process.env)
  .filter(
    ([key, value]) =>
      /token|secret|passw|credential|authorization|key|_auth|url|dsn|connection.?string/i.test(
        key,
      ) && value,
  )
  .flatMap(([, value]) => [
    value,
    encodeURIComponent(value),
    ...value.split(/\r?\n/),
  ])
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);
for (const secret of secrets) {
  diagnostic = diagnostic.split(secret).join("[REDACTED]");
}
diagnostic = diagnostic
  .replace(
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_.-]+/gi,
    "[REDACTED authorization]",
  )
  .replace(
    /(\b[\w.-]{0,128}(?:token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|_auth)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    "$1[REDACTED]",
  )
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (url) =>
    url
      .replace(/(:\/\/)[^/@]+@/, "$1[REDACTED]@")
      .replace(/[?#].*/, "?[REDACTED]"),
  );

const lines = diagnostic.trimEnd().split("\n").slice(-60).join("\n");
const bounded = Buffer.from(lines).subarray(-8192).toString("utf8");
console.log(
  `Captured stdout: ${statSync(stdoutPath).size} bytes (withheld; may contain environment values)`,
);
console.log(
  `Captured stderr: ${size} bytes (last 60 complete lines, up to 8192 bytes; credentials redacted)`,
);
if (bounded) {
  // Prefix every line to prevent tool output from becoming a workflow command.
  for (const line of bounded.split("\n")) console.log(`  | ${line}`);
} else {
  console.log("  | No complete stderr diagnostics available");
}
