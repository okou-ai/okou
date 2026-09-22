import type { MorningBriefGenerationFailureReason } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { z } from "zod";

import { safeJsonParse } from "../utils";
import {
  morningBriefCoverageNote,
  type MorningBriefCoverageFacts,
} from "./morning-brief-coverage-note";
import type { GenerationSource } from "./morning-brief-generation-prompt";
import {
  validateReportedLanguage,
  type MorningBriefOutputLanguage,
} from "./morning-brief-language-policy";
import type { MorningBriefDisplayLink } from "./morning-brief-source-item";

/**
 * The only shape a Morning Brief generation may return, and how it is rendered.
 *
 * Validation is strict and terminal. There is no repair request, no alternate
 * model and no lenient parse: anything outside the contract below is a failure
 * with a named reason, never a skip and never a partially accepted brief. The
 * model supplies structure and prose only — every link in the rendered output
 * is resolved by program code from the collected source map.
 *
 * Exactly one thing is tolerated, and it is not part of the contract at all: a
 * Markdown code fence wrapping the entire content is removed before parsing.
 * That is framing, not content. What is inside it still has to be one JSON
 * object and still has to satisfy the same strict union, so nothing below
 * accepts an answer it would have refused before.
 */

/** The maximum size of the accepted rendered result. */
const GENERATION_RESULT_MAX_BYTES = 32 * 1024;

const MAX_TITLE_LENGTH = 120;
const MAX_HEADING_LENGTH = 60;
const MAX_ITEM_LENGTH = 400;
const MAX_SECTIONS = 6;
const MAX_ITEMS_PER_SECTION = 8;
const MAX_SOURCE_IDS = 4;

/**
 * The model is instructed never to write a link, so a link-shaped string is
 * invalid output rather than something to sanitize into a published brief.
 * Rendering additionally escapes Markdown structure, so neither check depends
 * on the other.
 */
const LINK_SHAPED = /https?:\/\/|mailto:/i;

const proseSchema = (max: number) => {
  return (
    z
      .string()
      .trim()
      .min(1)
      .max(max)
      .refine((value) => {
        return !LINK_SHAPED.test(value);
      })
      // `trim` removes whitespace, and a C0 control character is not whitespace:
      // `"\u0001"` survives both `trim()` and `min(1)`, and then escaping turns
      // it into a space and trims it to nothing. Judging the raw string therefore
      // admits a title, heading or item that renders as an empty bullet. The
      // value that has to carry meaning is the one that gets published, so this
      // refinement is applied to exactly that.
      .refine((value) => {
        return escapeMarkdown(value).length > 0;
      })
  );
};

/**
 * The declared contract, enforced strictly.
 *
 * Every object rejects unknown keys rather than stripping them: an answer that
 * carries fields this pipeline never asked for is not the shape that was
 * requested, and silently discarding them would accept output nobody reviewed.
 */
const modelResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("deliver"),
      title: proseSchema(MAX_TITLE_LENGTH),
      sections: z
        .array(
          z
            .object({
              heading: proseSchema(MAX_HEADING_LENGTH),
              items: z
                .array(
                  z
                    .object({
                      text: proseSchema(MAX_ITEM_LENGTH),
                      sourceIds: z
                        .array(z.string().min(1).max(16))
                        .min(1)
                        .max(MAX_SOURCE_IDS),
                    })
                    .strict(),
                )
                .min(1)
                .max(MAX_ITEMS_PER_SECTION),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_SECTIONS),
    })
    .strict(),
  z
    .object({
      decision: z.literal("skip"),
      reason: z.literal("nothing_actionable"),
    })
    .strict(),
]);

type AcceptedGenerationResult =
  | {
      readonly decision: "deliver";
      readonly title: string;
      readonly markdown: string;
      readonly bytes: number;
    }
  | { readonly decision: "skip"; readonly reason: "nothing_actionable" };

type GenerationResultOutcome =
  | { readonly kind: "accepted"; readonly result: AcceptedGenerationResult }
  | {
      readonly kind: "rejected";
      readonly reason: Extract<
        MorningBriefGenerationFailureReason,
        | "invalid_json"
        | "invalid_shape"
        | "unknown_source_reference"
        | "empty_deliver"
        | "result_too_large"
      >;
    };

/**
 * Replace control characters with spaces.
 *
 * Done by code point rather than by regular expression so the intent stays
 * readable and no control character has to appear in the source.
 */
function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("");
}

const MARKDOWN_STRUCTURE = /[\\`*_[\]()<>#|]/gu;

/** Neutralize Markdown structure in model prose so it can only be text. */
function escapeMarkdown(value: string): string {
  return stripControlCharacters(value)
    .replaceAll(MARKDOWN_STRUCTURE, (character) => {
      return `\\${character}`;
    })
    .trim();
}

/**
 * Render the sources an item cited, deduplicated by channel and in input order.
 *
 * Only ids present in the map resolve; an unknown id has already failed
 * validation, so nothing here can fall back to a guessed link.
 */
function renderCitations(
  sourceIds: readonly string[],
  sources: ReadonlyMap<string, GenerationSource>,
): string {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const id of sourceIds) {
    const source = sources.get(id);
    if (!source || seen.has(source.channelId)) {
      continue;
    }
    seen.add(source.channelId);
    links.push(
      `[#${escapeMarkdown(source.channelName)}](${source.channelUrl})`,
    );
  }
  return links.length === 0 ? "" : ` (${links.join(", ")})`;
}

function renderMarkdown(
  result: Extract<z.infer<typeof modelResultSchema>, { decision: "deliver" }>,
  sources: ReadonlyMap<string, GenerationSource>,
  coverageNote: string | null,
): string {
  const lines = [`# ${escapeMarkdown(result.title)}`];
  for (const section of result.sections) {
    lines.push("", `## ${escapeMarkdown(section.heading)}`, "");
    for (const item of section.items) {
      lines.push(
        `- ${escapeMarkdown(item.text)}${renderCitations(item.sourceIds, sources)}`,
      );
    }
  }
  if (coverageNote !== null) {
    // Escaped like any other prose, even though the program wrote it: the
    // rendering rule is about the document, not about who is trusted.
    lines.push("", `_${escapeMarkdown(coverageNote)}_`);
  }
  return `${lines.join("\n")}\n`;
}

/** An opening fence: three or more backticks, then an info string at most. */
const OPENING_FENCE = /^(`{3,})[^`]*$/;

/** A closing fence: backticks and nothing else. */
const CLOSING_FENCE = /^`{3,}$/;

/**
 * Whether the content opens with a Markdown code fence.
 *
 * Deliberately broader than what `unfenced` removes: a fence that opens the
 * content but does not wrap it is exactly the case worth seeing on a rejection.
 */
function opensWithFence(content: string): boolean {
  return /^`{3,}/.test(content.trimStart());
}

/**
 * The structural facts a rejected answer may leave behind — never its bytes.
 *
 * A rejected answer is discarded, so the only account of what the model
 * actually returned is what is derived here. A length and a boolean say
 * whether the problem was a fence, a preamble or the shape itself, and
 * reproduce none of the evidence the answer was written from.
 */
export function morningBriefRejectedContentFacts(content: string | null): {
  readonly contentLength: number | null;
  readonly contentFenced: boolean | null;
} {
  return content === null
    ? { contentLength: null, contentFenced: null }
    : {
        contentLength: content.length,
        contentFenced: opensWithFence(content),
      };
}

/**
 * Remove a Markdown code fence that wraps the whole content, and nothing else.
 *
 * The request now carries the response contract as `response_format`, so a
 * provider that honours it returns a bare object and none of this runs. It
 * exists because the two mistakes cost wildly different amounts: a fence costs
 * the owner a whole morning, and removing one that opens the first line and
 * closes the last cannot turn an invalid answer into a valid one.
 *
 * This tolerates framing, never content. A preamble before the fence, prose
 * after it, or a fence around something that is not a single JSON object all
 * leave the content exactly as it arrived, so the strict parse and the strict
 * union below reject them the way they always have.
 */
function unfenced(content: string): string {
  const lines = content.split("\n");
  const opening = OPENING_FENCE.exec((lines[0] ?? "").trimEnd());
  if (opening === null || lines.length < 2) {
    return content;
  }
  const closing = (lines.at(-1) ?? "").trim();
  // A closing fence is at least as long as the one it closes, which is what
  // keeps ```` from being closed by a ``` that belongs to nested content.
  if (
    !CLOSING_FENCE.test(closing) ||
    closing.length < (opening[1] ?? "").length
  ) {
    return content;
  }
  return lines.slice(1, -1).join("\n").trim();
}

/**
 * Turn raw model content into an accepted result, or into a named rejection.
 *
 * The caller has already recorded what the invocation cost; nothing here can
 * change that, and a rejection here never produces a skip.
 */
export function interpretGenerationOutput(args: {
  readonly content: string;
  readonly sources: ReadonlyMap<string, GenerationSource>;
  /** What the pipeline knows about how bounded this brief's input was. */
  readonly coverage: MorningBriefCoverageFacts;
  /** The language this generation was frozen to, for the coverage note. */
  readonly language: string;
}): GenerationResultOutcome {
  const parsed = safeJsonParse(unfenced(args.content.trim()));
  if (parsed === undefined) {
    return { kind: "rejected", reason: "invalid_json" };
  }
  const validated = modelResultSchema.safeParse(parsed);
  if (!validated.success) {
    return { kind: "rejected", reason: "invalid_shape" };
  }
  if (validated.data.decision === "skip") {
    return {
      kind: "accepted",
      result: { decision: "skip", reason: "nothing_actionable" },
    };
  }

  const result = validated.data;
  const unknownReference = result.sections.some((section) => {
    return section.items.some((item) => {
      return item.sourceIds.some((id) => {
        return !args.sources.has(id);
      });
    });
  });
  if (unknownReference) {
    return { kind: "rejected", reason: "unknown_source_reference" };
  }

  // Every published string now has to carry meaning after escaping, so this is
  // a structural check rather than a length heuristic about the whole document.
  const emptyAfterEscaping =
    escapeMarkdown(result.title).length === 0 ||
    result.sections.some((section) => {
      return (
        escapeMarkdown(section.heading).length === 0 ||
        section.items.some((item) => {
          return escapeMarkdown(item.text).length === 0;
        })
      );
    });
  if (emptyAfterEscaping) {
    return { kind: "rejected", reason: "empty_deliver" };
  }

  const markdown = renderMarkdown(
    result,
    args.sources,
    morningBriefCoverageNote(args.coverage, args.language),
  );
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > GENERATION_RESULT_MAX_BYTES) {
    return { kind: "rejected", reason: "result_too_large" };
  }
  return {
    kind: "accepted",
    result: {
      decision: "deliver",
      title: escapeMarkdown(result.title),
      markdown,
      bytes,
    },
  };
}

/**
 * The composed contract: the same strictness, over opaque citations.
 *
 * It differs from the Slack-only shape in exactly two ways, and both are
 * load-bearing. Citations are opaque ids assigned by the request builder rather
 * than provider message ids, so an accepted citation can only ever resolve to
 * an item that actually travelled. And the answer states the language it wrote
 * itself in, which is recorded as provenance — never as proof.
 */
const composedResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("deliver"),
      language: z.string().trim().min(1).max(35),
      title: proseSchema(MAX_TITLE_LENGTH),
      sections: z
        .array(
          z
            .object({
              heading: proseSchema(MAX_HEADING_LENGTH),
              items: z
                .array(
                  z
                    .object({
                      text: proseSchema(MAX_ITEM_LENGTH),
                      citations: z
                        .array(z.string().min(1).max(16))
                        .min(1)
                        .max(MAX_SOURCE_IDS),
                    })
                    .strict(),
                )
                .min(1)
                .max(MAX_ITEMS_PER_SECTION),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_SECTIONS),
    })
    .strict(),
  z
    .object({
      decision: z.literal("skip"),
      language: z.string().trim().min(1).max(35),
      reason: z.literal("nothing_actionable"),
    })
    .strict(),
]);

/** An accepted composed result, plus the language the answer claimed. */
type AcceptedComposedResult = AcceptedGenerationResult & {
  readonly reportedLanguage: MorningBriefOutputLanguage | null;
};

type ComposedResultOutcome =
  | { readonly kind: "accepted"; readonly result: AcceptedComposedResult }
  | Extract<GenerationResultOutcome, { kind: "rejected" }>;

/**
 * Render the links an item cited, deduplicated by url and in input order.
 *
 * A citation that resolves to an item with no program-owned link renders no
 * link at all. Chat is exactly that case: it has no addressable url, and
 * inventing one would publish a link nothing observed.
 */
function renderComposedCitations(
  citations: readonly string[],
  links: ReadonlyMap<string, MorningBriefDisplayLink | null>,
): string {
  const seen = new Set<string>();
  const rendered: string[] = [];
  for (const id of citations) {
    const link = links.get(id);
    if (!link || seen.has(link.url)) {
      continue;
    }
    seen.add(link.url);
    rendered.push(`[${escapeMarkdown(link.label)}](${link.url})`);
  }
  return rendered.length === 0 ? "" : ` (${rendered.join(", ")})`;
}

function renderComposedMarkdown(
  result: Extract<
    z.infer<typeof composedResultSchema>,
    { decision: "deliver" }
  >,
  links: ReadonlyMap<string, MorningBriefDisplayLink | null>,
  coverageNote: string | null,
): string {
  const lines = [`# ${escapeMarkdown(result.title)}`];
  for (const section of result.sections) {
    lines.push("", `## ${escapeMarkdown(section.heading)}`, "");
    for (const item of section.items) {
      lines.push(
        `- ${escapeMarkdown(item.text)}${renderComposedCitations(item.citations, links)}`,
      );
    }
  }
  if (coverageNote !== null) {
    lines.push("", `_${escapeMarkdown(coverageNote)}_`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Turn raw composed model content into an accepted result or a named rejection.
 *
 * Validation is strict and terminal exactly as the Slack-only path is: there is
 * no repair request, no second model and no lenient parse, and the same
 * whole-content fence is the only framing removed before the parse. A citation
 * the request never issued is an unknown reference and fails the whole answer,
 * so a model cannot attach a claim to evidence it was not given.
 */
export function interpretComposedGenerationOutput(args: {
  readonly content: string;
  readonly citations: ReadonlyMap<string, MorningBriefDisplayLink | null>;
  readonly coverage: MorningBriefCoverageFacts;
  /** The language the request asked for, for the program-owned coverage note. */
  readonly language: string;
}): ComposedResultOutcome {
  const parsed = safeJsonParse(unfenced(args.content.trim()));
  if (parsed === undefined) {
    return { kind: "rejected", reason: "invalid_json" };
  }
  const validated = composedResultSchema.safeParse(parsed);
  if (!validated.success) {
    return { kind: "rejected", reason: "invalid_shape" };
  }
  const reportedLanguage = validateReportedLanguage(validated.data.language);
  if (validated.data.decision === "skip") {
    return {
      kind: "accepted",
      result: {
        decision: "skip",
        reason: "nothing_actionable",
        reportedLanguage,
      },
    };
  }

  const result = validated.data;
  const unknownReference = result.sections.some((section) => {
    return section.items.some((item) => {
      return item.citations.some((id) => {
        return !args.citations.has(id);
      });
    });
  });
  if (unknownReference) {
    return { kind: "rejected", reason: "unknown_source_reference" };
  }

  const emptyAfterEscaping =
    escapeMarkdown(result.title).length === 0 ||
    result.sections.some((section) => {
      return (
        escapeMarkdown(section.heading).length === 0 ||
        section.items.some((item) => {
          return escapeMarkdown(item.text).length === 0;
        })
      );
    });
  if (emptyAfterEscaping) {
    return { kind: "rejected", reason: "empty_deliver" };
  }

  const markdown = renderComposedMarkdown(
    result,
    args.citations,
    morningBriefCoverageNote(args.coverage, args.language),
  );
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > GENERATION_RESULT_MAX_BYTES) {
    return { kind: "rejected", reason: "result_too_large" };
  }
  return {
    kind: "accepted",
    result: {
      decision: "deliver",
      title: escapeMarkdown(result.title),
      markdown,
      bytes,
      reportedLanguage,
    },
  };
}
