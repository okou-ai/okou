#!/usr/bin/env tsx

/**
 * Validate a deployment's API environment file before release.
 *
 * Usage: pnpm --dir turbo/apps/api env:validate <env-file>
 *
 * The file holds the literal KEY=value records rendered by
 * .github/actions/web-api-env, including multiline PEM values. Validation uses
 * the API schema and appends its decoded result as one API_VALIDATED_ENV
 * record, which deployed runtimes read instead of constructing the schema at
 * startup. Diagnostics name invalid keys, never their values. On failure the
 * script exits non-zero and leaves the file unchanged.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { decodeApiEnv, VALIDATED_API_ENV } from "../lib/env-schema";

// Matches parseEnvironment in .github/scripts/api-worker-preview.cjs, which
// deploys the same files to Workers.
export function parseEnvironmentFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  let key: string | undefined;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const value = key === undefined ? undefined : values[key];
    const inPem =
      value !== undefined &&
      value.includes("-----BEGIN ") &&
      !value.includes("-----END ");
    const match = inPem ? null : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      key = match[1];
      if (Object.hasOwn(values, key)) {
        throw new Error(`Duplicate environment key ${key}`);
      }
      values[key] = match[2];
    } else if (key !== undefined && value !== undefined) {
      values[key] = `${value}\n${line}`;
    } else {
      throw new Error("Malformed environment file");
    }
  }
  return values;
}

export function validatedEnvironmentRecord(text: string): string {
  const values = parseEnvironmentFile(text);
  if (Object.hasOwn(values, VALIDATED_API_ENV)) {
    throw new Error(`Environment file already contains ${VALIDATED_API_ENV}`);
  }
  // The Vercel deploy action trims trailing whitespace from each record line.
  // Keep the values the canonical API runtime has always validated.
  const decoded = decodeApiEnv(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        return [key, value.trimEnd()];
      }),
    ),
  );
  return `${VALIDATED_API_ENV}=${JSON.stringify(decoded)}\n`;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  const file = process.argv[2];
  if (file === undefined) {
    throw new Error("Usage: env:validate <env-file>");
  }
  const text = readFileSync(file, "utf8");
  const record = validatedEnvironmentRecord(text);
  appendFileSync(file, text.endsWith("\n") ? record : `\n${record}`);
  process.stdout.write(
    `Validated API environment; appended ${VALIDATED_API_ENV} (${Buffer.byteLength(record)} bytes)\n`,
  );
}
