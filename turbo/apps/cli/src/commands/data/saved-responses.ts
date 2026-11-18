import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boolean, json, number, object, record, string } from "zod";

/**
 * Sandbox-private store of Data Router responses. Every call is saved so an
 * agent can re-read a result instead of paying for the same request again.
 */
const savedCallSchema = object({
  seq: number().int().positive(),
  savedAt: string(),
  tool: string(),
  inputHash: string(),
  input: record(string(), json()),
  status: number().int(),
  requestId: string().optional(),
  requestHistory: boolean().optional(),
  bytes: number().int(),
  file: string(),
});

export type SavedCall = ReturnType<typeof savedCallSchema.parse>;

const INDEX_FILE = "index.jsonl";
const SEQ_PATTERN = /^(\d+)-/;
const MAX_SEQ_ATTEMPTS = 100;

export function savedResponsesDir(): string {
  return join(tmpdir(), "okou-data");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        return [key, canonical(value[key])];
      }),
  );
}

function inputHash(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify([tool, canonical(input)]))
    .digest("hex")
    .slice(0, 16);
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // An interrupted append leaves at most one partial line; skip only that line.
    return undefined;
  }
}

export async function readSavedCalls(): Promise<SavedCall[]> {
  const text = await readFile(
    join(savedResponsesDir(), INDEX_FILE),
    "utf8",
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "";
    throw error;
  });
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const parsed = savedCallSchema.safeParse(parseJsonLine(line));
    return parsed.success ? [parsed.data] : [];
  });
}

export async function readJsonFile(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} does not contain valid JSON`);
  }
}

function safeToolName(tool: string): string {
  return tool.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

async function nextSeq(directory: string): Promise<number> {
  const names = await readdir(directory);
  return (
    Math.max(
      0,
      ...names.map((name) => {
        return Number(SEQ_PATTERN.exec(name)?.[1] ?? 0);
      }),
    ) + 1
  );
}

/** Write the unchanged body to a new numbered file, then record it in the index. */
export async function saveResponse(args: {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly status: number;
  readonly body: unknown;
  readonly requestId?: string;
  readonly requestHistory: boolean;
}): Promise<SavedCall> {
  const directory = savedResponsesDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(args.body, null, 2)}\n`;
  let seq = await nextSeq(directory);
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1, seq += 1) {
    const file = join(
      directory,
      `${String(seq).padStart(4, "0")}-${safeToolName(args.tool)}.json`,
    );
    const handle = await open(file, "wx", 0o600).catch((error: unknown) => {
      // A concurrent call took this number; try the next one.
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        return undefined;
      throw error;
    });
    if (!handle) continue;
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    const saved: SavedCall = {
      seq,
      savedAt: new Date().toISOString(),
      tool: args.tool,
      inputHash: inputHash(args.tool, args.input),
      input: savedCallSchema.shape.input.parse(args.input),
      status: args.status,
      ...(args.requestId ? { requestId: args.requestId } : {}),
      ...(args.requestHistory ? { requestHistory: true } : {}),
      bytes: Buffer.byteLength(content),
      file,
    };
    await appendFile(
      join(directory, INDEX_FILE),
      `${JSON.stringify(saved)}\n`,
      { mode: 0o600 },
    );
    return saved;
  }
  throw new Error(`Could not allocate a saved response file in ${directory}`);
}

/**
 * The latest successful saved response for the same tool and input. Calls
 * whose arguments include caller-owned history depend on state outside the
 * input, so they are never reused.
 */
export async function findReusableResponse(
  tool: string,
  input: Record<string, unknown>,
): Promise<{ readonly saved: SavedCall; readonly body: unknown } | undefined> {
  const hash = inputHash(tool, input);
  const candidates = (await readSavedCalls()).filter((saved) => {
    return (
      saved.tool === tool &&
      saved.inputHash === hash &&
      saved.status < 400 &&
      !saved.requestHistory
    );
  });
  for (const saved of candidates.reverse()) {
    const body = await readJsonFile(saved.file).catch(() => {
      // A deleted or unreadable file is not reusable; an older copy may be.
      return undefined;
    });
    if (body !== undefined) return { saved, body };
  }
  return undefined;
}
