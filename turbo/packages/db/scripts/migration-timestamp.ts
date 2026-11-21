import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { array, number, object, string } from "zod";

export async function migrationTimestamp(tag: string): Promise<number> {
  const journal = object({
    entries: array(object({ tag: string(), when: number() })),
  }).parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const migration = journal.entries.find((entry) => {
    return entry.tag === tag;
  });
  assert.ok(migration, `Missing migration ${tag}`);
  return migration.when;
}
