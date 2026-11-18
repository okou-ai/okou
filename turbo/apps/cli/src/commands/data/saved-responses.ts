import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boolean, json, number, object, record, string } from "zod";
import { getClientConfig } from "../../lib/api/core/client-factory";
import { getDataRouterUrl } from "../../lib/api/data-router-client";
import { getOkouConnectorAccountContextFile } from "../../lib/okou-env";

/** Private, authenticated-context-local responses, retained to avoid paid retries. */
const savedCallSchema = object({
  seq: number().int().positive(),
  savedAt: string(),
  tool: string(),
  inputHash: string(),
  input: record(string(), json()),
  status: number().int(),
  requestId: string().optional(),
  requestHistory: boolean().optional(),
  bytes: number().int().nonnegative(),
  file: string(),
});

export type SavedCall = ReturnType<typeof savedCallSchema.parse>;

const INDEX_FILE = "index.jsonl";
const SEQ_PATTERN = /^(\d+)\.json$/;
const MAX_SEQ_ATTEMPTS = 100;
const RECOVERY_GUIDANCE =
  "Please do not repeat the external request automatically. Recover the saved response first; use --refresh only if you deliberately want a new, potentially paid request.";

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

/** Only the digest is persisted; credentials and account context stay in memory. */
export async function savedResponsesDir(): Promise<string> {
  const { baseUrl, baseHeaders } = await getClientConfig();
  const contextFile = getOkouConnectorAccountContextFile();
  let accountContext: string | undefined;
  if (contextFile) {
    try {
      accountContext = await readFile(contextFile, "utf8");
    } catch {
      throw new Error(
        "Cannot read the configured connector account context file; saved response access is disabled.",
      );
    }
  }
  const context = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          baseUrl,
          baseHeaders,
          routerUrl: getDataRouterUrl().href,
          runId: process.env.OKOU_RUN_ID,
          accountContext,
        }),
      ),
    )
    .digest("hex");
  return join(tmpdir(), "okou-data", context);
}

function inputHash(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify([tool, canonical(input)]))
    .digest("hex")
    .slice(0, 16);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function responseFile(directory: string, seq: number): string {
  return join(directory, `${String(seq).padStart(4, "0")}.json`);
}

/** Never chmod or follow an existing unsafe store. */
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasCode(error, "EEXIST")) throw error;
  });
  const before = await lstat(directory);
  if (before.isSymbolicLink())
    throw new Error(`Unsafe saved response directory: ${directory}`);
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (
      !stats.isDirectory() ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o7777) !== 0o700 ||
      stats.dev !== before.dev ||
      stats.ino !== before.ino
    )
      throw new Error(`Unsafe saved response directory: ${directory}`);
  } finally {
    await handle.close();
  }
}

async function storeDirectory(): Promise<string> {
  const directory = await savedResponsesDir();
  await privateDirectory(join(tmpdir(), "okou-data"));
  await privateDirectory(directory);
  return directory;
}

/** Validate on the same no-follow handle used for every private file operation. */
async function openPrivateFile(file: string, flags: number) {
  const handle = await open(file, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o7777) !== 0o600 ||
      stats.nlink !== 1
    )
      throw new Error(`Unsafe saved response file: ${file}`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readSavedCalls(): Promise<SavedCall[]> {
  try {
    const directory = await storeDirectory();
    const file = join(directory, INDEX_FILE);
    const handle = await openPrivateFile(file, constants.O_RDONLY).catch(
      (error: unknown) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      },
    );
    if (!handle) {
      const names = await readdir(directory);
      if (
        names.some((name) => {
          return SEQ_PATTERN.test(name);
        })
      )
        throw new Error(
          `Missing ${file} while saved response files still exist`,
        );
      return [];
    }
    let text: string;
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const seen = new Set<number>();
    return lines.map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Malformed JSON in ${file} at line ${index + 1}`);
      }
      const parsed = savedCallSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.file !== responseFile(directory, parsed.data.seq) ||
        seen.has(parsed.data.seq)
      )
        throw new Error(
          `Invalid saved response record in ${file} at line ${index + 1}`,
        );
      seen.add(parsed.data.seq);
      return parsed.data;
    });
  } catch (error) {
    throw new Error(
      `Cannot read saved response history: ${error instanceof Error ? error.message : "unknown storage error"}. ${RECOVERY_GUIDANCE}`,
      { cause: error },
    );
  }
}

/** Arbitrary caller-supplied JSON files need not have private-store permissions. */
export async function readJsonFile(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`${file} is not a regular JSON file`);
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} does not contain valid JSON`);
  }
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

/** Exclusively reserve a tool-independent number, write the body, then index it. */
export async function saveResponse(args: {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly status: number;
  readonly body: unknown;
  readonly requestId?: string;
  readonly requestHistory: boolean;
}): Promise<SavedCall> {
  let bodyFile: string | undefined;
  let bodyWritten = false;
  try {
    const directory = await storeDirectory();
    const encoded = JSON.stringify(args.body, null, 2);
    if (encoded === undefined) throw new Error("Response body is not JSON");
    const content = `${encoded}\n`;
    const input = savedCallSchema.shape.input.parse(args.input);
    let seq = await nextSeq(directory);
    for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1, seq += 1) {
      const file = responseFile(directory, seq);
      const handle = await openPrivateFile(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      ).catch((error: unknown) => {
        if (hasCode(error, "EEXIST")) return undefined;
        throw error;
      });
      if (!handle) continue;
      bodyFile = file;
      try {
        await handle.writeFile(content, "utf8");
        bodyWritten = true;
      } finally {
        await handle.close();
      }
      const saved: SavedCall = {
        seq,
        savedAt: new Date().toISOString(),
        tool: args.tool,
        inputHash: inputHash(args.tool, args.input),
        input,
        status: args.status,
        ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(args.requestHistory ? { requestHistory: true } : {}),
        bytes: Buffer.byteLength(content),
        file,
      };
      const index = await openPrivateFile(
        join(directory, INDEX_FILE),
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
      );
      try {
        await index.writeFile(`${JSON.stringify(saved)}\n`, "utf8");
      } finally {
        await index.close();
      }
      return saved;
    }
    throw new Error(`Could not allocate a saved response file in ${directory}`);
  } catch (error) {
    const location = bodyFile
      ? `Surviving body file: ${bodyFile}${bodyWritten ? "" : " (may be incomplete)"}.`
      : "No response body file was written.";
    throw new Error(
      `The external request completed (status ${args.status}, requestId ${args.requestId ?? "unavailable"}), but saving its response failed. ${location} ${RECOVERY_GUIDANCE} Storage error: ${error instanceof Error ? error.message : "unknown storage error"}`,
      { cause: error },
    );
  }
}

/** Use only the latest matching success; a damaged result must not trigger a retry. */
export async function findReusableResponse(
  tool: string,
  input: Record<string, unknown>,
): Promise<{ readonly saved: SavedCall; readonly body: unknown } | undefined> {
  const hash = inputHash(tool, input);
  const saved = (await readSavedCalls()).reverse().find((call) => {
    return (
      call.tool === tool &&
      call.inputHash === hash &&
      call.status >= 200 &&
      call.status < 300 &&
      !call.requestHistory
    );
  });
  if (!saved) return undefined;
  try {
    const handle = await openPrivateFile(saved.file, constants.O_RDONLY);
    let text: string;
    try {
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (Buffer.byteLength(text) !== saved.bytes)
      throw new Error("Saved response size does not match its index record");
    const body: unknown = JSON.parse(text);
    return { saved, body };
  } catch (error) {
    throw new Error(
      `The latest successful request completed (status ${saved.status}, requestId ${saved.requestId ?? "unavailable"}), but its saved response is missing, corrupt or unsafe: ${saved.file}. ${RECOVERY_GUIDANCE}`,
      { cause: error },
    );
  }
}
