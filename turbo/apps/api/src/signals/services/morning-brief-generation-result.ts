import type { MorningBriefGenerationFailureReason } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { z } from "zod";

import { safeJsonParse } from "../utils";
import type { GenerationSource } from "./morning-brief-generation-prompt";

/**
 * The only shape a Morning Brief generation may return, and how it is rendered.
 *
 * Validation is strict and terminal. There is no repair request, no alternate
 * model and no lenient parse: anything outside the contract below is a failure
 * with a named reason, never a skip and never a partially accepted brief. The
 * model supplies structure and prose only — every link in the rendered output
 * is resolved by program code from the collected source map.
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
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => {
      return !LINK_SHAPED.test(value);
    });
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
  return `${lines.join("\n")}\n`;
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
}): GenerationResultOutcome {
  const parsed = safeJsonParse(args.content.trim());
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

  const markdown = renderMarkdown(result, args.sources);
  const bytes = Buffer.byteLength(markdown, "utf8");
  // A deliver decision has to carry a brief. The schema already rejects empty
  // sections and items, so this catches a body that escaping emptied out.
  if (markdown.trim().length <= result.title.length + 2) {
    return { kind: "rejected", reason: "empty_deliver" };
  }
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
