import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import { UnsupportedPiSessionVersionError } from "./errors";

function assertStrictJsonl(jsonl: string): void {
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // JSON.parse errors can include source text. History errors must not.
      throw new SyntaxError("Pi session JSONL contains an invalid JSON record");
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Pi session JSONL records must be objects");
    }
  }
}

/** Validate every parent component without restricting Pi's extension payloads. */
export function validatePiSessionEntries(
  entries: readonly SessionEntry[],
): void {
  const parents = new Map<string, string | null>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("Pi session entry id must be a nonempty string");
    }
    if (parents.has(entry.id)) {
      throw new Error("Pi session contains duplicate entry ids");
    }
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      throw new Error("Pi session entry parentId must be null or a string");
    }
    parents.set(entry.id, entry.parentId);
  }

  const visited = new Set<string>();
  const complete = new Set<string>();
  for (const id of parents.keys()) {
    const path: string[] = [];
    let current: string | null | undefined = id;
    // Multiple roots, forward references and missing-parent termination are
    // official Pi semantics. Only parentId is an edge, not other references.
    while (current !== null && current !== undefined && parents.has(current)) {
      if (complete.has(current)) {
        break;
      }
      if (visited.has(current)) {
        throw new Error("Pi session parent graph contains a cycle");
      }
      visited.add(current);
      path.push(current);
      current = parents.get(current);
    }
    for (const entryId of path) {
      complete.add(entryId);
    }
  }
}

/** Keep strict native-history parsing around the pinned SDK's official migrations. */
export function parseValidatedPiSessionJsonl(jsonl: string): {
  readonly header: SessionHeader;
  readonly entries: SessionEntry[];
} {
  // The SDK parser skips malformed lines for interactive recovery. Canonical
  // native-history boundaries cannot silently drop records.
  assertStrictJsonl(jsonl);
  const fileEntries = parseSessionEntries(jsonl);
  const header = fileEntries[0];
  if (header?.type !== "session" || typeof header.id !== "string") {
    throw new Error("Pi session JSONL must start with a session header");
  }
  const entries: SessionEntry[] = [];
  for (const entry of fileEntries.slice(1)) {
    if (entry.type === "session") {
      throw new Error(
        "Pi session JSONL must contain exactly one session header",
      );
    }
    entries.push(entry);
  }
  if (
    header.version !== undefined &&
    header.version > CURRENT_SESSION_VERSION
  ) {
    throw new UnsupportedPiSessionVersionError(
      `Pi session version is newer than supported version ${CURRENT_SESSION_VERSION}`,
    );
  }
  // v1 entries do not have graph fields until Pi migrates them.
  migrateSessionEntries(fileEntries);
  if (header.version !== CURRENT_SESSION_VERSION) {
    throw new UnsupportedPiSessionVersionError(
      "Pi session could not be migrated to the current version",
    );
  }
  validatePiSessionEntries(entries);
  return { header, entries };
}
