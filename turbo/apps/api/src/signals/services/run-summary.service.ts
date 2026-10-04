import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import { logger } from "../../lib/log";
import { stripMarkdown } from "../../lib/strip-markdown";
import {
  AUXILIARY_TEXT_MAX_TOKENS,
  FAST_PATH_MODEL,
  generateTextWithUsage,
  openRouterTokenCounts,
} from "../external/openrouter";
import { tapError } from "../utils";
import {
  generateAuxiliary,
  type RecordAuxiliaryGenerationDetail,
} from "./auxiliary-generation.service";
import { writeRunMetadata$ } from "./agent-run-metadata-write.service";

const log = logger("run-summary");

function truncateSnippet(
  text: string,
  maxLines = 3,
  maxCharsPerLine = 80,
): string {
  return text
    .split("\n")
    .slice(0, maxLines)
    .map((line) => {
      return line.length > maxCharsPerLine
        ? `${line.slice(0, maxCharsPerLine)}...`
        : line;
    })
    .join("\n");
}

async function generateRunSummary(
  triggerSource: string,
  prompt: string,
  resultText: string,
  record: RecordAuxiliaryGenerationDetail,
  signal?: AbortSignal,
): Promise<string | null> {
  const promptSnippet = truncateSnippet(prompt);
  const resultSnippet = truncateSnippet(resultText);

  // A shortened summary still describes what the run produced, and the
  // alternative is a run with no summary at all.
  const generation = await generateTextWithUsage(
    FAST_PATH_MODEL,
    [
      {
        role: "system",
        content: `Summarize the result of this ${triggerSource} agent run in at most 50 words as plain text. No markdown, no quotes. Focus on what was accomplished or produced - the user's original request is provided only for context.`,
      },
      {
        role: "user",
        content: `Context (user request):\n${promptSnippet}\n\nResult:\n${resultSnippet}`,
      },
    ],
    AUXILIARY_TEXT_MAX_TOKENS,
    {
      reasoning: { effort: "low" },
      temperature: 0.3,
      acceptTruncatedText: true,
    },
    signal,
  );
  if (generation === null) {
    return null;
  }
  record({
    truncated: generation.truncated === true,
    tokens: openRouterTokenCounts(generation.usage),
  });
  return stripMarkdown(generation.text);
}

export const saveRunSummary$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly triggerSource: string;
      readonly prompt: string;
      readonly resultText: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const summary = await generateAuxiliary(
      {
        feature: "run_summary",
        generate: (record) => {
          return generateRunSummary(
            args.triggerSource,
            args.prompt,
            args.resultText,
            record,
            signal,
          );
        },
        usable: (value) => {
          return Boolean(value);
        },
        diagnosticContext: { runId: args.runId },
      },
      signal,
    );
    signal.throwIfAborted();
    if (!summary) {
      return;
    }

    await tapError(
      set(
        writeRunMetadata$,
        {
          patch: { summary },
          where: eq(agentRuns.id, args.runId),
        },
        signal,
      ),
      (error) => {
        log.warn("Failed to save run summary", {
          runId: args.runId,
          error,
        });
      },
    );
    signal.throwIfAborted();
  },
);
