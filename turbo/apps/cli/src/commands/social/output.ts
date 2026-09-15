import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

export interface SocialExportOptions {
  readonly json?: boolean;
  readonly output?: string;
  readonly select?: string;
  readonly format?: string;
  readonly overwrite?: boolean;
  readonly stream?: boolean;
}

interface TerminalOutput {
  readonly kind: "result" | "summary";
  readonly data?: unknown;
}

export class SocialExportError extends Error {}

const MAX_FIELDS = 32;
const MAX_FIELD_LENGTH = 128;
const MAX_FIELD_DEPTH = 8;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function socialExportCapabilities(collection: boolean) {
  return {
    formats: collection ? ["json", "csv"] : ["json"],
    destination: "--output <path> (local file; existing parent required)",
    overwrite:
      "--overwrite (regular files only; default refuses existing paths)",
    selection: {
      flag: "--select",
      target: collection ? "each data.items row" : "data",
      maxFields: MAX_FIELDS,
      maxPathLength: MAX_FIELD_LENGTH,
      maxDepth: MAX_FIELD_DEPTH,
      syntax:
        "comma-separated own-property dot paths; no arrays, wildcards, or prototype properties",
    },
    stream: false,
    metadata:
      "JSON keeps the envelope; file exports print a metadata-only JSON receipt on stdout",
    ...(collection
      ? {
          csv: "Requires --output and --select; retain stdout receipt for status, limits, errors, and credits",
        }
      : {}),
  };
}

export function addSocialExportOptions(command: Command): void {
  command
    .option(
      "--output <path>",
      "Save results to a local file (existing parent required)",
    )
    .option(
      "--select <fields>",
      "Select comma-separated data fields in order (up to 32)",
    )
    .option(
      "--format <format>",
      "Output format: json (default) or csv (collections only)",
    )
    .option("--overwrite", "Explicitly replace an existing regular output file")
    .addHelpText(
      "after",
      `
Export:
  JSON preserves status, billing, warnings, and collection metadata.
  --select addresses data fields, or each collection item; use dot paths for nested fields.
  Paths use letters, digits, _, $, or -, start with a letter, _, or $, and have at most 8 segments / 128 characters.
  Selected JSON keys keep the path name. Missing fields are omitted; null stays null.
  CSV requires --output and --select on posts/search/comments. Columns follow --select order.
  CSV uses UTF-8 and CRLF, quotes strings, and encodes nested values as compact JSON.
  Missing CSV fields are empty cells; null is literal null. Spreadsheet-active strings gain a leading apostrophe.
  File exports print a metadata-only JSON receipt; retain it alongside CSV for errors, limits, and credits.
  --stream cannot be combined with --output, --select, --format, or --overwrite.
  Local files need okou web upload-file for delivery in web chat.`,
    );
}

function selectedFields(
  value: string | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length > MAX_FIELDS * (MAX_FIELD_LENGTH + 1)) {
    throw new InvalidArgumentError(
      "--select exceeds the 32-field / 128-character path limits",
    );
  }
  const fields = value.split(",").map((field) => {
    return field.trim();
  });
  if (fields.length > MAX_FIELDS || new Set(fields).size !== fields.length) {
    throw new InvalidArgumentError("--select requires 1-32 unique field paths");
  }
  for (const field of fields) {
    const segments = field.split(".");
    if (
      field.length === 0 ||
      field.length > MAX_FIELD_LENGTH ||
      segments.length > MAX_FIELD_DEPTH ||
      segments.some((segment) => {
        return (
          !/^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(segment) ||
          FORBIDDEN_SEGMENTS.has(segment)
        );
      })
    ) {
      throw new InvalidArgumentError(
        `Invalid --select path ${JSON.stringify(field)}; use up to 8 dot-separated property names and 128 characters, without array indexes, wildcards, or prototype properties`,
      );
    }
  }
  return fields;
}

function validateOptions(options: SocialExportOptions, collection: boolean) {
  if (
    options.stream &&
    (options.output !== undefined ||
      options.select !== undefined ||
      options.format !== undefined ||
      options.overwrite)
  ) {
    throw new InvalidArgumentError(
      "--stream cannot be combined with export options",
    );
  }
  const format = options.format ?? "json";
  if (format !== "json" && format !== "csv") {
    throw new InvalidArgumentError("--format must be json or csv");
  }
  const fields = selectedFields(options.select);
  if (options.overwrite && options.output === undefined) {
    throw new InvalidArgumentError("--overwrite requires --output");
  }
  if (options.output !== undefined && options.output.trim().length === 0) {
    throw new InvalidArgumentError("--output must name a local file");
  }
  if (format === "csv") {
    if (!collection || options.output === undefined || !fields) {
      throw new InvalidArgumentError(
        "CSV requires posts/search/comments with --output and --select",
      );
    }
    return { format, fields } as const;
  }
  return { format, fields } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldValue(row: unknown, field: string): unknown {
  return field.split(".").reduce<unknown>((value, segment) => {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined;
    return value[segment];
  }, row);
}

function projectRow(row: unknown, fields: readonly string[]) {
  if (!isRecord(row)) {
    throw new Error("Selected Social data must be an object");
  }
  return Object.fromEntries(
    fields
      .map((field) => {
        return [field, fieldValue(row, field)];
      })
      .filter(([, value]) => {
        return value !== undefined;
      }),
  );
}

function collectionData(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error(
      "Social CSV/collection selection requires reviewed data.items",
    );
  }
  const items: readonly unknown[] = data.items;
  return { ...data, items };
}

function projectOutput(
  output: TerminalOutput,
  fields: readonly string[],
  collection: boolean,
) {
  if (!collection) return { ...output, data: projectRow(output.data, fields) };
  const data = collectionData(output.data);
  return {
    ...output,
    data: {
      ...data,
      items: data.items.map((row) => {
        return projectRow(row, fields);
      }),
    },
  };
}

function csvCell(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (/^[\p{Cc}\s]*[=+@-]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvOutput(output: TerminalOutput, fields: readonly string[]): string {
  const { items } = collectionData(output.data);
  const rows = items.map((row) => {
    if (!isRecord(row)) throw new Error("Social CSV rows must be objects");
    return fields
      .map((field) => {
        return csvCell(fieldValue(row, field));
      })
      .join(",");
  });
  return [fields.map(csvCell).join(","), ...rows].join("\r\n") + "\r\n";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function checkDestination(
  path: string,
  overwrite: boolean,
): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (stat === undefined) return;
  if (!stat.isFile()) {
    throw new Error(
      "Destination must be a regular file, not a symlink, directory, or device",
    );
  }
  if (!overwrite)
    throw new Error(
      "Destination exists; choose another path or use --overwrite",
    );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareDestination(path: string, overwrite: boolean) {
  const destination = resolve(path);
  const staging = join(
    dirname(destination),
    `.okou-social-${randomUUID()}.tmp`,
  );
  try {
    await checkDestination(destination, overwrite);
    const handle = await open(staging, "wx", 0o600);
    return { destination, staging, handle };
  } catch (error) {
    throw new InvalidArgumentError(
      `Cannot prepare --output ${JSON.stringify(destination)}: ${errorMessage(error)}. Use an existing writable parent directory.`,
    );
  }
}

function printJson(output: unknown, compact: boolean): void {
  console.log(JSON.stringify(output, null, compact ? undefined : 2));
}

export async function withSocialOutput(
  options: SocialExportOptions,
  collection: boolean,
  action: (write: (output: TerminalOutput) => Promise<void>) => Promise<void>,
): Promise<void> {
  const { format, fields } = validateOptions(options, collection);
  const compact = options.json === true || options.stream === true;
  const file =
    options.output === undefined
      ? undefined
      : await prepareDestination(options.output, options.overwrite === true);
  try {
    await action(async (output) => {
      try {
        const projected =
          format === "json" && fields
            ? projectOutput(output, fields, collection)
            : output;
        if (!file) {
          printJson(projected, compact);
          return;
        }
        const contents =
          format === "csv"
            ? csvOutput(output, fields)
            : JSON.stringify(projected, null, compact ? undefined : 2) + "\n";
        await file.handle.writeFile(contents, "utf8");
        await file.handle.sync();
        await file.handle.close();
        await checkDestination(file.destination, options.overwrite === true);
        if (options.overwrite) {
          await rename(file.staging, file.destination);
        } else {
          await link(file.staging, file.destination);
        }
      } catch (error) {
        // Provider work has already completed; keep the full envelope recoverable.
        printJson(output, compact);
        throw new SocialExportError(
          `Cannot export Social results${file ? ` to ${JSON.stringify(file.destination)}` : ""}: ${errorMessage(error)}. Retrieved results are on stdout; save them without repeating the Social request.`,
          { cause: error },
        );
      }
      if (file) {
        const { data: _data, ...metadata } = output;
        printJson(
          {
            ...metadata,
            kind: "export",
            export: {
              path: file.destination,
              format,
              ...(fields ? { fields } : {}),
              visibility: "local",
              guidance:
                "This is a local file. Use okou web upload-file to deliver it in web chat.",
            },
          },
          compact,
        );
      }
    });
  } finally {
    if (file) {
      try {
        await file.handle.close();
        await unlink(file.staging).catch((error: unknown) => {
          if (!hasErrorCode(error, "ENOENT")) throw error;
        });
      } catch (error) {
        // Cleanup must not replace the request/export error or truncate stdout.
        const message = `Could not clean Social export staging file ${JSON.stringify(file.staging)}: ${errorMessage(error)}. Check this local path and remove any remaining file after restoring directory access.`;
        console.error(
          compact
            ? JSON.stringify({
                status: "error",
                error: {
                  kind: "export_cleanup",
                  code: "EXPORT_CLEANUP_FAILED",
                  message,
                  retryable: false,
                },
              })
            : message,
        );
        process.exitCode = 1;
      }
    }
  }
}
