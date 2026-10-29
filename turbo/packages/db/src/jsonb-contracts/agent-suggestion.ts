import type { Suggestion } from "@okouai/api-contracts/contracts/suggestions";

export type AgentSuggestionContent = Pick<
  Suggestion,
  "title" | "rationale" | "feedbackScope" | "options" | "customOption"
>;
export type AgentSuggestionFeedbacks =
  readonly Suggestion["feedbacks"][number][];
