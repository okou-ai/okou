import { createHash } from "node:crypto";

import type {
  PiStableContextBuildInput,
  PiStableContextProjection,
} from "@okouai/db/jsonb-contracts/pi-stable-context";

export const PI_STABLE_CONTEXT_SCHEMA_VERSION = 1;

function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => {
      return item !== undefined;
    });
    entries.sort(([left], [right]) => {
      return left.localeCompare(right);
    });
    return `{${entries
      .map(([key, item]) => {
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function piStableContextInputDigest(
  input: PiStableContextBuildInput,
): string {
  return sha256(input);
}

export function piStableContextVariantDigest(value: unknown): string {
  return sha256({ schemaVersion: PI_STABLE_CONTEXT_SCHEMA_VERSION, value });
}

export function piStableContextArtifactDigest(
  projection: PiStableContextProjection,
): string {
  return sha256({ kind: "pi-stable-context", projection });
}
