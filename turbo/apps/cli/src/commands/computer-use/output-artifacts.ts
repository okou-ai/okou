import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const COMPUTER_USE_OUTPUT_DIR_MODE = 0o700;
const COMPUTER_USE_OUTPUT_FILE_MODE = 0o600;
const COMPUTER_USE_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COMPUTER_USE_OUTPUT_DIR = path.join(
  tmpdir(),
  "okou",
  "computer-use",
);

export function computerUseOutputDir(): string {
  const canonical = process.env.OKOU_COMPUTER_OUTPUT_DIR?.trim();
  if (canonical) {
    return canonical;
  }

  return DEFAULT_COMPUTER_USE_OUTPUT_DIR;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, {
    recursive: true,
    mode: COMPUTER_USE_OUTPUT_DIR_MODE,
  });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Computer-use output path is not a directory: ${directory}`,
    );
  }
  await chmod(directory, COMPUTER_USE_OUTPUT_DIR_MODE);
}

async function removeStaleEntries(
  directory: string,
  cutoffMs: number,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const stats = await lstat(entryPath).catch(() => {
      return null;
    });
    if (!stats) {
      continue;
    }
    if (entry.isDirectory() && !stats.isSymbolicLink()) {
      await removeStaleEntries(entryPath, cutoffMs);
      if (stats.mtimeMs < cutoffMs) {
        try {
          await rmdir(entryPath);
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            ["ENOTEMPTY", "EEXIST", "ENOENT"].includes(String(error.code))
          ))
            throw error;
        }
      }
      continue;
    }
    if (stats.mtimeMs < cutoffMs) {
      await rm(entryPath, { force: true, recursive: entry.isDirectory() });
    }
  }
}

async function prepareComputerUseOutputDir(): Promise<string> {
  const outputDir = computerUseOutputDir();
  await ensurePrivateDirectory(outputDir);
  await removeStaleEntries(outputDir, Date.now() - COMPUTER_USE_OUTPUT_TTL_MS);
  return outputDir;
}

async function ensureOutputPathDirectory(outputPath: string): Promise<void> {
  const outputDir = await prepareComputerUseOutputDir();
  const directory = path.dirname(outputPath);
  const relative = path.relative(outputDir, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Computer-use artifact path escapes output directory`);
  }

  let current = outputDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await ensurePrivateDirectory(current);
  }
}

export async function writeComputerUseArtifact(
  outputPath: string,
  data: string | Buffer,
): Promise<void> {
  await ensureOutputPathDirectory(outputPath);
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid.toString()}.${randomUUID()}.tmp`,
  );
  let moved = false;
  try {
    await writeFile(tempPath, data, {
      flag: "wx",
      mode: COMPUTER_USE_OUTPUT_FILE_MODE,
    });
    await chmod(tempPath, COMPUTER_USE_OUTPUT_FILE_MODE);
    await rename(tempPath, outputPath);
    moved = true;
    await chmod(outputPath, COMPUTER_USE_OUTPUT_FILE_MODE);
  } finally {
    if (!moved) {
      await rm(tempPath, { force: true });
    }
  }
}

/** Publish both files under one rename. A repeated delivery must match the original bytes. */
export async function publishComputerUseAppState(
  commandId: string,
  snapshotId: string,
  appState: string,
  png: Buffer,
  signal: AbortSignal,
) {
  const root = await prepareComputerUseOutputDir();
  const final = path.join(root, commandId);
  const temporary = await mkdtemp(path.join(root, ".app-state-"));
  const text = `${snapshotId}.appState.txt`;
  const image = `${snapshotId}.png`;
  try {
    await writeFile(path.join(temporary, text), appState, {
      mode: COMPUTER_USE_OUTPUT_FILE_MODE,
      signal,
    });
    await writeFile(path.join(temporary, image), png, {
      mode: COMPUTER_USE_OUTPUT_FILE_MODE,
      signal,
    });
    signal.throwIfAborted();
    try {
      await rename(temporary, final);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTEMPTY" || error.code === "EEXIST")
      ))
        throw error;
      const existing = await lstat(final);
      if (
        !existing.isDirectory() ||
        (await readFile(path.join(final, text), "utf8")) !== appState ||
        !(await readFile(path.join(final, image))).equals(png)
      ) {
        throw new Error("Conflicting Computer Use delivery for this command");
      }
    }
    return {
      status: "succeeded",
      snapshotId,
      appState: path.join(final, text),
      screenshot: path.join(final, image),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
