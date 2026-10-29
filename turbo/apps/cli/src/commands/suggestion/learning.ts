import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SUGGESTION_MEMORY_PATH,
  SUGGESTION_MEMORY_MAX_BYTES,
  learnSuggestionFeedback,
  suggestionMemorySchema,
} from "@okouai/api-contracts/contracts/suggestion-memory";
import { prepareSuggestionLearning } from "../../lib/api/domains/suggestions";

/** The mounted root remains the ordinary finalizer's expected-base writeback. */
export async function learnSuggestions(memoryRoot: string, readOnly = false) {
  const root = resolve(memoryRoot);
  if ((await realpath(root)) !== root)
    throw new Error("Use the selected, nonsymlink member Memory root.");
  const file = resolve(root, SUGGESTION_MEMORY_PATH);
  const context = await prepareSuggestionLearning();
  let original = "";
  try {
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > SUGGESTION_MEMORY_MAX_BYTES
    )
      throw new Error(
        "Suggestion Memory must be a regular file of at most 64 KiB.",
      );
    original = await readFile(file, "utf8");
    suggestionMemorySchema.parse(JSON.parse(original));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  // Pending events replay local candidates; published HEAD is the current base.
  const memory = learnSuggestionFeedback(
    context.memory,
    context.pending,
    Date.now(),
  );
  const content = JSON.stringify(memory);
  const changed = content !== original;
  if (changed && !readOnly) {
    const directory = dirname(file);
    await mkdir(directory, { recursive: true });
    if ((await realpath(directory)) !== directory)
      throw new Error("Suggestion Memory directory must not be a symlink.");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary);
      throw error;
    }
  }
  return {
    memory,
    changed: changed && !readOnly,
    processed: memory.processedFeedback.length,
    publication: readOnly ? "read_only" : "pending_finalization",
  };
}
