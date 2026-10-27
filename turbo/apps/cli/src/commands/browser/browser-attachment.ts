import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { browserWindowContextSchema } from "@okouai/api-contracts/contracts/browser";
import { object, url, uuid, type infer as zInfer } from "zod";

const attachmentSchema = object({
  threadId: uuid(),
  window: browserWindowContextSchema,
  cdpUrl: url({ protocol: /^wss?$/u }),
}).strict();

export type BrowserAttachment = zInfer<typeof attachmentSchema>;

function directory(): string {
  return join(tmpdir(), `okou-browser-attachments-${userInfo().uid}`);
}

function attachmentPath(session: string): string {
  return join(directory(), `${encodeURIComponent(session)}.json`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function checkDirectory(): Promise<void> {
  const info = await lstat(directory());
  if (!info.isDirectory() || info.uid !== userInfo().uid || info.mode & 0o077) {
    throw new Error("The Browser attachment directory is not private");
  }
}

export async function readBrowserAttachment(
  session: string,
): Promise<BrowserAttachment | null> {
  let data: string;
  try {
    await checkDirectory();
    data = await readFile(attachmentPath(session), "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    throw new Error("Browser attachment is unreadable; run `okou browser use`");
  }
  const parsed = attachmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Browser attachment is invalid; run `okou browser use`");
  }
  return parsed.data;
}

export async function clearBrowserAttachment(session: string): Promise<void> {
  try {
    await checkDirectory();
    await rm(attachmentPath(session), { force: true });
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

export async function saveBrowserAttachment(
  session: string,
  attachment: BrowserAttachment,
): Promise<void> {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  await checkDirectory();
  const temporary = await mkdtemp(join(directory(), "attachment-"));
  try {
    const file = join(temporary, "context.json");
    await writeFile(file, JSON.stringify(attachment), { mode: 0o600 });
    await rename(file, attachmentPath(session));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
