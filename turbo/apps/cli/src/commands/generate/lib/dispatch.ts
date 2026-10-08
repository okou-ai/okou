import { readFileSync } from "node:fs";
import { printConnectorGuidance } from "./connector-guidance";
import { runLister } from "./lister";
import type { GenerationType } from "./generation-type";

interface DispatchOptions {
  readonly generationType: GenerationType;
  readonly provider?: string;
  readonly prompt?: string;
  readonly all?: boolean;
  readonly listOnMissingPrompt?: boolean;
  readonly missingPromptError?: string;
  readonly requireExecutionFor?: string;
}

/**
 * Resolve the dispatch for `okou generate <type>`.
 *
 * Returns `"execute"` when the caller should run the built-in pipeline.
 * Otherwise prints the appropriate output (lister or connector guidance)
 * and returns `"handled"`.
 *
 * The dispatcher consumes any piped stdin used to satisfy the prompt and
 * places the resolved text on `options.prompt` for the caller to use.
 */
export async function dispatchGenerate(
  options: DispatchOptions,
): Promise<{ outcome: "handled" } | { outcome: "execute"; prompt: string }> {
  const provider = options.provider?.trim();

  if (provider && provider !== "built-in") {
    if (options.requireExecutionFor) {
      throw new Error(
        `${options.requireExecutionFor} is only available for direct built-in generation`,
      );
    }
    await printConnectorGuidance(options.generationType, provider);
    return { outcome: "handled" };
  }

  const resolvedPrompt = resolvePrompt(options.prompt);

  if (resolvedPrompt === null) {
    if (options.requireExecutionFor) {
      throw new Error(
        `${options.requireExecutionFor} is only available for direct built-in generation`,
      );
    }
    if (options.listOnMissingPrompt === false) {
      throw new Error(options.missingPromptError ?? "Prompt is required");
    }
    await runLister(options.generationType, {
      all: options.all,
    });
    return { outcome: "handled" };
  }

  return { outcome: "execute", prompt: resolvedPrompt };
}

function resolvePrompt(prompt: string | undefined): string | null {
  if (prompt?.trim()) {
    return prompt.trim();
  }

  if (!process.stdin.isTTY) {
    try {
      const piped = readFileSync("/dev/stdin", "utf8").trim();
      if (piped.length > 0) {
        return piped;
      }
    } catch {
      // stdin not readable (e.g. test runner with no piped input);
      // treat as no piped prompt and fall through to lister.
    }
  }

  return null;
}
