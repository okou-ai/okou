import { enum as zEnum, number, object, type infer as zInfer } from "zod";

export const STARTING_PROMPT_MAX_LENGTH = 1000;

export const ONBOARDING_OUTPUT_FORMATS = [
  "image",
  "presentation",
  "website",
  "report",
  "research",
  "people",
] as const;

export type OnboardingOutputFormat = (typeof ONBOARDING_OUTPUT_FORMATS)[number];

export const startingPromptOutputSchema = object({
  format: zEnum(ONBOARDING_OUTPUT_FORMATS),
  start: number().int().min(0).max(STARTING_PROMPT_MAX_LENGTH),
  end: number().int().min(0).max(STARTING_PROMPT_MAX_LENGTH),
});

export type StartingPromptOutput = zInfer<typeof startingPromptOutputSchema>;

/** Keep ownership of the appended paragraph as the user edits the full prompt. */
export function editedStartingPromptOutput(
  previous: string,
  next: string,
  output: StartingPromptOutput | null,
): StartingPromptOutput | null {
  if (output === null || previous === next) {
    return output;
  }
  let from = 0;
  while (
    from < previous.length &&
    from < next.length &&
    previous[from] === next[from]
  ) {
    from++;
  }
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (
    oldEnd > from &&
    newEnd > from &&
    previous[oldEnd - 1] === next[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  // An edit spanning the task and the output paragraph gives ownership back
  // to the user. A select-all replacement can still share a prefix or suffix.
  if (next.length === 0 || (from <= output.start && oldEnd > output.start)) {
    return null;
  }
  const delta = next.length - previous.length;
  if (oldEnd <= output.start) {
    return { ...output, start: output.start + delta, end: output.end + delta };
  }
  if (from >= output.end) {
    return output;
  }
  const start = Math.min(output.start, from);
  const end = Math.max(output.end + delta, newEnd);
  return start === end ? null : { ...output, start, end };
}

export function withStartingPromptOutput(
  text: string,
  output: StartingPromptOutput | null,
  instruction: string,
): { readonly text: string; readonly start: number; readonly end: number } {
  const start = output?.start ?? text.length;
  const end = output?.end ?? text.length;
  const addition = instruction ? `\n\n${instruction}` : "";
  return {
    text: text.slice(0, start) + addition + text.slice(end),
    start,
    end: start + addition.length,
  };
}
