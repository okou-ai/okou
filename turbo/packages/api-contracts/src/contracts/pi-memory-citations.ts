import { z } from "zod";
import { CitationLiteralEscaper } from "./pi-memory-citation-literals";

/**
 * Adapted from OpenAI Codex rust-v0.152.1 at
 * 5adb68a49933ae446bf11935662c83dba55a0804. Portions copyright OpenAI and
 * licensed under Apache-2.0. Okou additionally suppresses stray complete
 * delimiters so internal transport markup cannot reach public projections.
 */

export const PI_MEMORY_CITATION_OPEN = "<oai-mem-citation>";
export const PI_MEMORY_CITATION_CLOSE = "</oai-mem-citation>";

export const PI_MEMORY_CITATION_LIMITS = {
  bodyBytes: 64 * 1024,
  entries: 64,
  rolloutIds: 64,
  pathBytes: 1024,
  noteBytes: 2048,
  lineNumberMax: 0xffff_ffff,
} as const;

export interface PiMemoryCitationEntry {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly note: string;
}

export interface PiMemoryCitation {
  readonly entries: readonly PiMemoryCitationEntry[];
  readonly rolloutIds: readonly string[];
}

export interface PiMemoryCitationDiagnostics {
  readonly envelopes: number;
  readonly validEntries: number;
  readonly validRolloutIds: number;
  readonly invalidEntries: number;
  readonly invalidRolloutIds: number;
  readonly oversizedBodies: number;
  readonly incompleteBodies: number;
}

export interface PiMemoryCitationProjection {
  readonly visibleText: string;
  readonly citation?: PiMemoryCitation;
  readonly diagnostics: PiMemoryCitationDiagnostics;
}

interface MutableDiagnostics {
  envelopes: number;
  validEntries: number;
  validRolloutIds: number;
  invalidEntries: number;
  invalidRolloutIds: number;
  oversizedBodies: number;
  incompleteBodies: number;
}

interface SourcedCharacter {
  readonly value: string;
  readonly source: number;
}

interface MutableCitation {
  readonly entries: PiMemoryCitationEntry[];
  readonly rolloutIds: string[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const boundedCitationStringSchema = (maxBytes: number) => {
  return z
    .string()
    .min(1)
    .refine((value) => {
      return utf8Bytes(value) <= maxBytes;
    });
};

export const piMemoryCitationEntrySchema = z
  .object({
    path: boundedCitationStringSchema(PI_MEMORY_CITATION_LIMITS.pathBytes),
    lineStart: z
      .number()
      .int()
      .positive()
      .max(PI_MEMORY_CITATION_LIMITS.lineNumberMax),
    lineEnd: z
      .number()
      .int()
      .positive()
      .max(PI_MEMORY_CITATION_LIMITS.lineNumberMax),
    note: boundedCitationStringSchema(PI_MEMORY_CITATION_LIMITS.noteBytes),
  })
  .strict()
  .refine((entry) => {
    return entry.lineEnd >= entry.lineStart;
  });

/** Strict boundary for the private Guest-to-API citation sidecar. */
export const piMemoryCitationSchema = z
  .object({
    entries: z
      .array(piMemoryCitationEntrySchema)
      .max(PI_MEMORY_CITATION_LIMITS.entries),
    rolloutIds: z
      .array(z.string().regex(UUID_PATTERN))
      .max(PI_MEMORY_CITATION_LIMITS.rolloutIds),
  })
  .strict()
  .superRefine((citation, context) => {
    if (citation.entries.length === 0 && citation.rolloutIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "memory citation must contain provenance",
      });
    }
    const canonicalIds = citation.rolloutIds.map((id) => {
      return id.toLowerCase();
    });
    if (new Set(canonicalIds).size !== canonicalIds.length) {
      context.addIssue({
        code: "custom",
        path: ["rolloutIds"],
        message: "memory citation rollout IDs must be unique",
      });
    }
  });

function emptyDiagnostics(): MutableDiagnostics {
  return {
    envelopes: 0,
    validEntries: 0,
    validRolloutIds: 0,
    invalidEntries: 0,
    invalidRolloutIds: 0,
    oversizedBodies: 0,
    incompleteBodies: 0,
  };
}

function section(body: string, names: readonly string[]): string | null {
  for (const name of names) {
    const open = `<${name}>`;
    const close = `</${name}>`;
    const start = body.indexOf(open);
    if (start < 0) {
      continue;
    }
    const contentStart = start + open.length;
    const end = body.indexOf(close, contentStart);
    if (end >= 0) {
      return body.slice(contentStart, end);
    }
  }
  return null;
}

function parseEntry(line: string): PiMemoryCitationEntry | null {
  const noteSeparator = line.lastIndexOf("|note=[");
  if (noteSeparator < 0 || !line.endsWith("]")) {
    return null;
  }
  const location = line.slice(0, noteSeparator);
  const note = line.slice(noteSeparator + "|note=[".length, -1).trim();
  const rangeSeparator = location.lastIndexOf(":");
  if (rangeSeparator < 0) {
    return null;
  }
  const path = location.slice(0, rangeSeparator).trim();
  const range = location.slice(rangeSeparator + 1);
  const dash = range.indexOf("-");
  if (dash < 0) {
    return null;
  }
  const lineStart = Number(range.slice(0, dash).trim());
  const lineEnd = Number(range.slice(dash + 1).trim());
  if (
    path.length === 0 ||
    note.length === 0 ||
    utf8Bytes(path) > PI_MEMORY_CITATION_LIMITS.pathBytes ||
    utf8Bytes(note) > PI_MEMORY_CITATION_LIMITS.noteBytes ||
    !Number.isSafeInteger(lineStart) ||
    !Number.isSafeInteger(lineEnd) ||
    lineStart <= 0 ||
    lineStart > PI_MEMORY_CITATION_LIMITS.lineNumberMax ||
    lineEnd > PI_MEMORY_CITATION_LIMITS.lineNumberMax ||
    lineEnd < lineStart
  ) {
    return null;
  }
  return { path, lineStart, lineEnd, note };
}

function appendCitationBody(
  body: string,
  citation: MutableCitation,
  diagnostics: MutableDiagnostics,
): void {
  const entries = section(body, ["citation_entries"]);
  if (entries !== null) {
    for (const rawLine of entries.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const entry = parseEntry(line);
      if (
        entry &&
        citation.entries.length < PI_MEMORY_CITATION_LIMITS.entries
      ) {
        citation.entries.push(entry);
        diagnostics.validEntries += 1;
      } else {
        diagnostics.invalidEntries += 1;
      }
    }
  }

  const rolloutIds = section(body, ["rollout_ids", "thread_ids"]);
  if (rolloutIds === null) {
    return;
  }
  const knownIds = new Set(citation.rolloutIds);
  for (const rawLine of rolloutIds.split("\n")) {
    const id = rawLine.trim();
    if (!id) {
      continue;
    }
    if (!UUID_PATTERN.test(id)) {
      diagnostics.invalidRolloutIds += 1;
      continue;
    }
    const canonicalId = id.toLowerCase();
    if (knownIds.has(canonicalId)) {
      continue;
    }
    if (citation.rolloutIds.length >= PI_MEMORY_CITATION_LIMITS.rolloutIds) {
      diagnostics.invalidRolloutIds += 1;
      continue;
    }
    knownIds.add(canonicalId);
    citation.rolloutIds.push(canonicalId);
    diagnostics.validRolloutIds += 1;
  }
}

function isPrefix(value: string, candidate: string): boolean {
  return candidate.startsWith(value);
}

class CitationScanner {
  constructor(
    private readonly onVisible?: (source: number, text: string) => void,
  ) {}
  readonly #literals = new CitationLiteralEscaper(
    PI_MEMORY_CITATION_OPEN,
    PI_MEMORY_CITATION_CLOSE,
  );
  readonly #visibleBySource = new Map<number, string[]>();
  readonly #citation: MutableCitation = { entries: [], rolloutIds: [] };
  readonly #diagnostics = emptyDiagnostics();
  #outsidePending: SourcedCharacter[] = [];
  #closePending: SourcedCharacter[] = [];
  #inside = false;
  #body = "";
  #bodyBytes = 0;
  #bodyOversized = false;

  push(chunk: string, source = 0): void {
    for (const value of chunk) {
      this.#literals.push({ value, source }, (item, escape) => {
        this.#pushLiteralCharacter(item, escape);
      });
    }
  }

  #pushLiteralCharacter(item: SourcedCharacter, escape: boolean): void {
    const replacement =
      escape && !this.#inside
        ? item.value === "<"
          ? "&lt;"
          : item.value === ">"
            ? "&gt;"
            : item.value
        : item.value;
    for (const value of replacement) {
      this.#pushCharacter({ value, source: item.source });
    }
  }

  #emit(character: SourcedCharacter): void {
    const output = this.#visibleBySource.get(character.source) ?? [];
    output.push(character.value);
    this.#visibleBySource.set(character.source, output);
    this.onVisible?.(character.source, character.value);
  }

  #pushCharacter(character: SourcedCharacter): void {
    if (this.#inside) {
      this.#closePending.push(character);
      while (this.#closePending.length > 0) {
        const pending = this.#closePending
          .map(({ value }) => {
            return value;
          })
          .join("");
        if (pending === PI_MEMORY_CITATION_CLOSE) {
          this.#finishBody(false);
          this.#closePending = [];
          this.#inside = false;
          return;
        }
        if (isPrefix(pending, PI_MEMORY_CITATION_CLOSE)) {
          return;
        }
        const [first, ...remaining] = this.#closePending;
        this.#closePending = remaining;
        if (first) {
          this.#appendBody(first.value);
        }
      }
      return;
    }

    this.#outsidePending.push(character);
    while (this.#outsidePending.length > 0) {
      const pending = this.#outsidePending
        .map(({ value }) => {
          return value;
        })
        .join("");
      if (pending === PI_MEMORY_CITATION_OPEN) {
        this.#outsidePending = [];
        this.#inside = true;
        this.#body = "";
        this.#bodyBytes = 0;
        this.#bodyOversized = false;
        return;
      }
      if (pending === PI_MEMORY_CITATION_CLOSE) {
        // A complete stray internal delimiter is private transport syntax.
        this.#outsidePending = [];
        return;
      }
      if (
        isPrefix(pending, PI_MEMORY_CITATION_OPEN) ||
        isPrefix(pending, PI_MEMORY_CITATION_CLOSE)
      ) {
        return;
      }
      const [first, ...remaining] = this.#outsidePending;
      this.#outsidePending = remaining;
      if (first) {
        this.#emit(first);
      }
    }
  }

  #appendBody(value: string): void {
    if (this.#bodyOversized) {
      return;
    }
    const nextBytes = this.#bodyBytes + utf8Bytes(value);
    if (nextBytes > PI_MEMORY_CITATION_LIMITS.bodyBytes) {
      this.#body = "";
      this.#bodyOversized = true;
      return;
    }
    this.#body += value;
    this.#bodyBytes = nextBytes;
  }

  #finishBody(incomplete: boolean): void {
    this.#diagnostics.envelopes += 1;
    if (incomplete) {
      this.#diagnostics.incompleteBodies += 1;
    }
    if (this.#bodyOversized) {
      this.#diagnostics.oversizedBodies += 1;
      return;
    }
    appendCitationBody(this.#body, this.#citation, this.#diagnostics);
  }

  finish(): PiMemoryCitationProjection {
    this.#literals.finish((item, escape) => {
      this.#pushLiteralCharacter(item, escape);
    });
    if (this.#inside) {
      for (const character of this.#closePending) {
        this.#appendBody(character.value);
      }
      this.#closePending = [];
      this.#finishBody(true);
      this.#inside = false;
    } else {
      for (const character of this.#outsidePending) {
        this.#emit(character);
      }
      this.#outsidePending = [];
    }
    const visibleText = [...this.#visibleBySource.keys()]
      .sort((left, right) => {
        return left - right;
      })
      .flatMap((source) => {
        return this.#visibleBySource.get(source) ?? [];
      })
      .join("");
    const hasCitation =
      this.#citation.entries.length > 0 || this.#citation.rolloutIds.length > 0;
    return {
      visibleText,
      ...(hasCitation
        ? {
            citation: {
              entries: this.#citation.entries,
              rolloutIds: this.#citation.rolloutIds,
            },
          }
        : {}),
      diagnostics: this.#diagnostics,
    };
  }

  visibleForSource(source: number): string {
    return (this.#visibleBySource.get(source) ?? []).join("");
  }
}

/** Stateful streaming parser with Codex-compatible EOF behavior. */
export class PiMemoryCitationStreamParser {
  readonly #scanner: CitationScanner;

  constructor(onVisible?: (source: number, text: string) => void) {
    this.#scanner = new CitationScanner(onVisible);
  }

  push(chunk: string, source = 0): void {
    this.#scanner.push(chunk, source);
  }

  finish(): PiMemoryCitationProjection {
    return this.#scanner.finish();
  }
}

/** Hide citation transport markup and parse bounded internal provenance. */
export function projectPiMemoryCitationText(
  text: string,
): PiMemoryCitationProjection {
  const parser = new PiMemoryCitationStreamParser();
  parser.push(text);
  return parser.finish();
}

/** A low-cost read-time safety projection for historical public text. */
export function visiblePiMemoryCitationText(text: string): string {
  if (!text.includes("<") && !text.includes(">")) {
    return text;
  }
  return projectPiMemoryCitationText(text).visibleText;
}

/**
 * Parse text segments as one stream while retaining each segment's original
 * position around tool calls and other non-text content.
 */
export function projectPiMemoryCitationSegments(segments: readonly string[]): {
  readonly visibleSegments: readonly string[];
  readonly citation?: PiMemoryCitation;
  readonly diagnostics: PiMemoryCitationDiagnostics;
} {
  const scanner = new CitationScanner();
  segments.forEach((segment, index) => {
    scanner.push(segment, index);
  });
  const result = scanner.finish();
  return {
    visibleSegments: segments.map((_, index) => {
      return scanner.visibleForSource(index);
    }),
    ...(result.citation ? { citation: result.citation } : {}),
    diagnostics: result.diagnostics,
  };
}

function boundedString(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= maxBytes
    ? value
    : null;
}

function parseStructuredEntry(value: unknown): PiMemoryCitationEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const path = boundedString(entry.path, PI_MEMORY_CITATION_LIMITS.pathBytes);
  const note = boundedString(entry.note, PI_MEMORY_CITATION_LIMITS.noteBytes);
  const lineStart = entry.lineStart;
  const lineEnd = entry.lineEnd;
  if (
    !path ||
    !note ||
    !Number.isSafeInteger(lineStart) ||
    !Number.isSafeInteger(lineEnd) ||
    (lineStart as number) <= 0 ||
    (lineStart as number) > PI_MEMORY_CITATION_LIMITS.lineNumberMax ||
    (lineEnd as number) > PI_MEMORY_CITATION_LIMITS.lineNumberMax ||
    (lineEnd as number) < (lineStart as number)
  ) {
    return null;
  }
  return {
    path,
    note,
    lineStart: lineStart as number,
    lineEnd: lineEnd as number,
  };
}

function parseStructuredEntries(value: unknown): PiMemoryCitationEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: PiMemoryCitationEntry[] = [];
  for (const candidate of value.slice(0, PI_MEMORY_CITATION_LIMITS.entries)) {
    const entry = parseStructuredEntry(candidate);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function parseStructuredRolloutIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rolloutIds: string[] = [];
  const knownIds = new Set<string>();
  for (const candidate of value.slice(
    0,
    PI_MEMORY_CITATION_LIMITS.rolloutIds,
  )) {
    if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate)) {
      continue;
    }
    const id = candidate.toLowerCase();
    if (!knownIds.has(id)) {
      knownIds.add(id);
      rolloutIds.push(id);
    }
  }
  return rolloutIds;
}

/** Accept structured metadata from a newer Guest without trusting its shape. */
export function parsePiMemoryCitation(value: unknown): PiMemoryCitation | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const entries = parseStructuredEntries(record.entries);
  const rolloutIds = parseStructuredRolloutIds(record.rolloutIds);
  return entries.length > 0 || rolloutIds.length > 0
    ? { entries, rolloutIds }
    : null;
}

export function mergePiMemoryCitations(
  first: PiMemoryCitation | null | undefined,
  second: PiMemoryCitation | null | undefined,
): PiMemoryCitation | undefined {
  if (!first) {
    return second ?? undefined;
  }
  if (!second) {
    return first;
  }
  const rolloutIds = [...first.rolloutIds];
  const knownIds = new Set(rolloutIds);
  for (const id of second.rolloutIds) {
    if (
      !knownIds.has(id) &&
      rolloutIds.length < PI_MEMORY_CITATION_LIMITS.rolloutIds
    ) {
      knownIds.add(id);
      rolloutIds.push(id);
    }
  }
  return {
    entries: [...first.entries, ...second.entries].slice(
      0,
      PI_MEMORY_CITATION_LIMITS.entries,
    ),
    rolloutIds,
  };
}
