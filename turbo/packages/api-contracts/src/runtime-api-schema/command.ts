import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { object, string } from "zod";
import { iosResponseTransforms } from "../client-transforms/ios";
import { desktopResponseTransforms } from "../client-transforms/desktop";
import { compareRuntimeApiSchemas } from "./compat";
import {
  DESKTOP_PUBLISHED_VERSION_ORACLE,
  IOS_PUBLISHED_VERSION_ORACLE,
  type NativeFloorChange,
  evaluateRuntimeApiGate,
  parseStableVersion,
  renderRuntimeApiGateReport,
  renderRuntimeApiGateReportJson,
  runtimeApiGateAnnotations,
} from "./gate";
import { type RuntimeApiRouteOwner, runtimeApiRouteOwners } from "./routes";
import {
  buildRuntimeApiSchemaDocument,
  readRuntimeApiSchemaDocument,
  renderRuntimeApiSchemaDocument,
  type RuntimeApiSchemaDocument,
} from "./schema";

const BUILD_OPTIONS = { out: "single" } as const;
const LINT_OPTIONS = {
  against: "single",
  current: "single",
  "base-schema": "single",
  "report-out": "single",
  "block-owner": "repeatable",
  "desktop-floor": "single",
  "desktop-base-floor": "single",
  "desktop-published-version": "single",
  "ios-floor": "single",
  "ios-base-floor": "single",
  "ios-published-version": "single",
} as const;

type OptionSpec = Readonly<Record<string, "single" | "repeatable">>;
type ParsedOptions = ReadonlyMap<string, readonly string[]>;

const USAGE = `Usage:
  tsx src/runtime-api-schema/cli.ts build --out runtime-api-schema.json
  tsx src/runtime-api-schema/cli.ts lint --against online-schema.json
    [--current current-schema.json] [--base-schema base-schema.json]
    [--report-out report.json] [--block-owner <owner>]...
    [--desktop-floor desktop-compatibility.json --desktop-base-floor base-desktop-compatibility.json]
    [--desktop-published-version x.y.z]
    [--ios-floor ios-client-compatibility.json --ios-base-floor base-ios-client-compatibility.json]
    [--ios-published-version x.y.z]

Findings on --block-owner owners fail the lint unless proven; other owners only
warn. Owners: ${runtimeApiRouteOwners.join(", ")}.
`;

class CliUsageError extends Error {}

const nativeFloorFileSchema = object({
  minimumSupportedVersion: string().nullable(),
});

/** Runs the runtime API schema CLI and returns its exit code. */
export async function runRuntimeApiSchemaCli(
  argv: readonly string[],
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "build") {
      await buildCommand(parseOptions(rest, BUILD_OPTIONS));
      return 0;
    }
    if (command === "lint") {
      return await lintCommand(parseOptions(rest, LINT_OPTIONS));
    }
    throw new CliUsageError(`Unknown command: ${command ?? "(none)"}`);
  } catch (error) {
    if (!(error instanceof CliUsageError)) {
      throw error;
    }
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
}

async function buildCommand(options: ParsedOptions): Promise<void> {
  const out = single(options, "out") ?? "runtime-api-schema.json";
  const outputPath = resolve(out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRuntimeApiSchemaDocument());
  console.log(`Runtime API schema written to ${outputPath}`);
}

async function lintCommand(options: ParsedOptions): Promise<number> {
  const against = single(options, "against");
  if (!against) {
    throw new CliUsageError("Missing required --against <path> option");
  }
  const blockingOwners = readBlockingOwners(options);
  const desktop = await readNativePolicy(options, "desktop");
  const ios = await readNativePolicy(options, "ios");

  const currentPath = single(options, "current");
  const current = currentPath
    ? await readRuntimeApiSchemaDocument(resolve(currentPath))
    : buildRuntimeApiSchemaDocument();
  const online = await readOptionalSchema(against, "Online");
  const basePath = single(options, "base-schema");
  const base = basePath
    ? await readOptionalSchema(basePath, "Base")
    : undefined;
  if (!online) {
    console.warn(
      "Runtime API schema comparison skipped because no online schema is available yet; Native client floor and transform checks still run.",
    );
  }

  if (
    online &&
    blockingOwners.has("ios") &&
    !online.routes.some((route) => {
      return route.owner === "ios";
    })
  ) {
    console.warn(
      "::warning::Production has no iOS contract baseline yet. The next API production promotion must publish the iOS route inventory before iOS schema changes can be compared.",
    );
  }
  const result = evaluateRuntimeApiGate({
    findings: online ? compareRuntimeApiSchemas(online, current) : [],
    ...(online && base
      ? { baseFindings: compareRuntimeApiSchemas(online, base) }
      : {}),
    blockingOwners,
    ...(desktop.floor ? { desktopFloor: desktop.floor } : {}),
    ...(desktop.publishedVersion
      ? { desktopPublishedVersion: desktop.publishedVersion }
      : {}),
    desktopTransforms: desktopResponseTransforms,
    ...(ios.floor ? { iosFloor: ios.floor } : {}),
    ...(ios.publishedVersion
      ? { iosPublishedVersion: ios.publishedVersion }
      : {}),
    iosTransforms: iosResponseTransforms,
  });

  console.log(renderRuntimeApiGateReport(result));
  const reportOut = single(options, "report-out");
  if (reportOut) {
    const reportPath = resolve(reportOut);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, renderRuntimeApiGateReportJson(result));
    console.log(
      `Runtime API compatibility JSON report written to ${reportPath}`,
    );
  }
  for (const annotation of runtimeApiGateAnnotations(result)) {
    console.error(annotation);
  }

  return result.passed ? 0 : 1;
}

async function readNativePolicy(
  options: ParsedOptions,
  client: "desktop" | "ios",
): Promise<{
  readonly floor: NativeFloorChange | undefined;
  readonly publishedVersion: string | undefined;
}> {
  const floorPath = single(options, `${client}-floor`);
  const basePath = single(options, `${client}-base-floor`);
  if ((floorPath === undefined) !== (basePath === undefined)) {
    throw new CliUsageError(
      `--${client}-floor and --${client}-base-floor must be passed together`,
    );
  }
  return {
    floor:
      floorPath && basePath
        ? {
            floor: await readNativeFloor(floorPath),
            baseFloor: await readNativeFloor(basePath),
          }
        : undefined,
    publishedVersion: readPublishedVersion(options, client),
  };
}

function parseOptions(
  argv: readonly string[],
  spec: OptionSpec,
): ParsedOptions {
  const options = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    // `pnpm run <script> -- <args>` forwards the separator itself.
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new CliUsageError(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const kind = spec[key];
    if (!kind) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Option ${arg} requires a value`);
    }
    const values = options.get(key) ?? [];
    if (kind === "single" && values.length > 0) {
      throw new CliUsageError(`Option ${arg} may only be passed once`);
    }
    options.set(key, [...values, value]);
    index += 1;
  }

  return options;
}

function single(options: ParsedOptions, key: string): string | undefined {
  return options.get(key)?.[0];
}

function readBlockingOwners(
  options: ParsedOptions,
): ReadonlySet<RuntimeApiRouteOwner> {
  const owners = new Set<RuntimeApiRouteOwner>();
  for (const value of options.get("block-owner") ?? []) {
    const owner = runtimeApiRouteOwners.find((candidate) => {
      return candidate === value;
    });
    if (!owner) {
      throw new CliUsageError(`Unknown --block-owner value: ${value}`);
    }
    owners.add(owner);
  }
  return owners;
}

function readPublishedVersion(
  options: ParsedOptions,
  client: "desktop" | "ios" = "desktop",
): string | undefined {
  const value = single(options, `${client}-published-version`);
  if (value === undefined || parseStableVersion(value)) {
    return value;
  }
  console.warn(
    `::warning::Ignoring --${client}-published-version ${JSON.stringify(value)}: not a stable x.y.z version. Oracle: ${client === "ios" ? IOS_PUBLISHED_VERSION_ORACLE : DESKTOP_PUBLISHED_VERSION_ORACLE}.`,
  );
  return undefined;
}

async function readOptionalSchema(
  path: string,
  label: "Online" | "Base",
): Promise<RuntimeApiSchemaDocument | undefined> {
  try {
    return await readRuntimeApiSchemaDocument(resolve(path));
  } catch (error) {
    console.warn(
      `::warning::${label} runtime API schema could not be read from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function readNativeFloor(path: string): Promise<string | null> {
  const raw = await readFile(resolve(path), "utf8");
  return nativeFloorFileSchema.parse(JSON.parse(raw)).minimumSupportedVersion;
}
