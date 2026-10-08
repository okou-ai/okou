import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PUBLIC_DESTINATION_ADDRESS_POLICY } from "@okouai/connectors/public-destination-policy";

import {
  BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION,
  BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
} from "../contracts/runners";

const generatedBuiltinFirewallCachePath = fileURLToPath(
  new URL(
    "../../../../../crates/runner/mitm-addon/src/generated/builtin_firewall_cache.py",
    import.meta.url,
  ),
);
const generatedPublicDestinationPolicyPath = fileURLToPath(
  new URL(
    "../../../../../crates/runner/mitm-addon/src/generated/public_destination_policy.py",
    import.meta.url,
  ),
);
const generatedPackageInitPath = fileURLToPath(
  new URL(
    "../../../../../crates/runner/mitm-addon/src/generated/__init__.py",
    import.meta.url,
  ),
);

function pythonPositiveInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

function pythonHexInteger(value: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `invalid public destination policy integer: ${String(value)}`,
    );
  }
  const digits = value.toString(16).toUpperCase();
  if (digits.length > width) {
    throw new Error(
      `public destination policy integer exceeds ${String(width)} hex digits: ${String(value)}`,
    );
  }
  return `0x${digits.padStart(width, "0")}`;
}

function upperSnakeCase(value: string): string {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export function renderBuiltinFirewallCacheContract(): string {
  return [
    '"""Generated builtin firewall cache contract shared with Rust.',
    "",
    "Do not edit by hand; regenerate with",
    "``cd turbo && pnpm -F @okouai/api-contracts generate:python``.",
    '"""',
    "",
    "from typing import Final",
    "",
    `BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION: Final[int] = ${pythonPositiveInteger(BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION, "builtin firewall cache schema version")}`,
    `BUILTIN_FIREWALL_CATALOG_MAX_BYTES: Final[int] = ${pythonPositiveInteger(BUILTIN_FIREWALL_CATALOG_MAX_BYTES, "builtin firewall catalog maximum bytes")}`,
    "",
  ].join("\n");
}

function renderPublicDestinationPolicyContract(): string {
  const { ipv4NonPublicRanges, ipv6 } = PUBLIC_DESTINATION_ADDRESS_POLICY;
  const lines = [
    '"""Generated public destination policy shared with TypeScript.',
    "",
    "Do not edit by hand; regenerate with",
    "``cd turbo && pnpm -F @okouai/api-contracts generate:python``.",
    '"""',
    "",
    "from typing import Final",
    "",
    "IPV4_NON_PUBLIC_RANGES: Final[tuple[tuple[int, int], ...]] = (",
  ];
  for (const [start, end] of ipv4NonPublicRanges) {
    lines.push(
      `    (${pythonHexInteger(start, 8)}, ${pythonHexInteger(end, 8)}),`,
    );
  }
  lines.push(")", "");
  for (const [name, value] of Object.entries(ipv6)) {
    lines.push(
      `IPV6_${upperSnakeCase(name)}: Final[int] = ${pythonHexInteger(value, 4)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function generatePythonBindings(): Promise<void> {
  await mkdir(dirname(generatedPackageInitPath), { recursive: true });
  await writeFile(
    generatedPackageInitPath,
    '"""Generated Python bindings shared from TypeScript contracts."""\n',
  );
  await writeFile(
    generatedBuiltinFirewallCachePath,
    renderBuiltinFirewallCacheContract(),
  );
  await writeFile(
    generatedPublicDestinationPolicyPath,
    renderPublicDestinationPolicyContract(),
  );
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  void generatePythonBindings().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
