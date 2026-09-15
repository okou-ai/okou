import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";
import { formatTranscript } from "./transcript-output";

type SocialOutputMode = "single" | "collection" | "transcript";

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

function formatsForMode(mode: SocialOutputMode): readonly string[] {
  return mode === "transcript"
    ? ["json", "text", "srt", "vtt"]
    : mode === "collection"
      ? ["json", "csv"]
      : ["json"];
}

export function socialExportCapabilities(mode: SocialOutputMode) {
  const collection = mode === "collection";
  return {
    formats: formatsForMode(mode),
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
      ...(mode === "transcript" ? { formats: ["json"] } : {}),
    },
    stream: false,
    metadata:
      "JSON keeps the envelope; file exports print a metadata-only JSON receipt on stdout",
    ...(collection
      ? {
          csv: "Requires --output and --select; retain stdout receipt for status, limits, errors, and credits",
        }
      : {}),
    ...(mode === "transcript"
      ? {
          transcript: {
            output: "text/srt/vtt require --output and cannot use --select",
            text: "Uses full transcript once, otherwise segment texts in source order",
            timing:
              "Extraction does not guarantee timestamped output; srt/vtt require every segment's finite nonnegative start and positive duration in seconds, ordered starts, and valid millisecond intervals",
            markup:
              "SRT preserves source cue text but rejects timestamp-like lines that readers can interpret as another cue; reader markup support varies. WebVTT escapes literal markup and timing text",
            recovery:
              "Missing or invalid timing fails without retrying; save plain text from the recovered stdout JSON",
          },
        }
      : {}),
  };
}

export function addSocialExportOptions(
  command: Command,
  mode: SocialOutputMode,
): void {
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
      `Output format: ${formatsForMode(mode).join(", ")} (default: json)`,
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
  if (mode === "transcript") {
    command.addHelpText(
      "after",
      `
Transcript export:
  --format text|srt|vtt requires --output and cannot use --select; --json controls receipt compactness.
  Text uses the full transcript once, otherwise joins segment texts. Empty text fails.
  SRT/WebVTT require every segment's numeric start and positive duration in seconds.
  Extraction support does not guarantee timestamped output. Missing timing is never inferred.
  Cue starts must be ordered; overlaps are preserved. Unsafe or zero-length millisecond intervals fail.
  Cue text keeps Unicode; line endings are normalized and blank cue lines removed.
  SRT preserves source cue text; reader markup support varies. Choose vtt for escaped literal markup.
  SRT rejects timestamp-like cue-text lines; choose vtt to preserve literal timing text.
  On failure, save plain text from the recovered stdout JSON without repeating the request.
  Example: okou social transcript https://youtu.be/<id> --format srt --output captions.srt`,
    );
  }
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

function validateOutputOptions(options: SocialExportOptions): void {
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
  if (options.overwrite && options.output === undefined) {
    throw new InvalidArgumentError("--overwrite requires --output");
  }
  if (options.output !== undefined && options.output.trim().length === 0) {
    throw new InvalidArgumentError("--output must name a local file");
  }
}

function validateOptions(options: SocialExportOptions, mode: SocialOutputMode) {
  validateOutputOptions(options);
  const format = options.format ?? "json";
  if (format === "text" || format === "srt" || format === "vtt") {
    if (
      mode !== "transcript" ||
      options.output === undefined ||
      options.select !== undefined
    ) {
      throw new InvalidArgumentError(
        "text/srt/vtt require transcript with --output and cannot use --select",
      );
    }
    return { format, fields: undefined } as const;
  }
  if (format !== "json" && format !== "csv") {
    throw new InvalidArgumentError(
      `--format must be ${formatsForMode(mode).join(", ")}`,
    );
  }
  const fields = selectedFields(options.select);
  if (format === "csv") {
    if (mode !== "collection" || options.output === undefined || !fields) {
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
  mode: SocialOutputMode,
  action: (write: (output: TerminalOutput) => Promise<void>) => Promise<void>,
): Promise<void> {
  const { format, fields } = validateOptions(options, mode);
  const compact = options.json === true || options.stream === true;
  const file =
    options.output === undefined
      ? undefined
      : await prepareDestination(options.output, options.overwrite === true);
  try {
    await action(async (output) => {
      let transcriptLanguage: string | undefined;
      try {
        const projected =
          format === "json" && fields
            ? projectOutput(output, fields, mode === "collection")
            : output;
        if (!file) {
          printJson(projected, compact);
          return;
        }
        let contents: string;
        if (format === "text" || format === "srt" || format === "vtt") {
          const transcript = formatTranscript(output.data, format);
          contents = transcript.contents;
          transcriptLanguage = transcript.language;
        } else {
          contents =
            format === "csv"
              ? csvOutput(output, fields)
              : JSON.stringify(projected, null, compact ? undefined : 2) + "\n";
        }
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
              ...(transcriptLanguage === undefined
                ? {}
                : { language: transcriptLanguage }),
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
