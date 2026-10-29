import type {
  Suggestion,
  SuggestionReceipt,
} from "@okouai/api-contracts/contracts/suggestions";

export type AgentSuggestionEntries = readonly (
  Suggestion | SuggestionReceipt
)[];

export type AgentSuggestionContent = Pick<
  Suggestion,
  "title" | "rationale" | "feedbackScope" | "options" | "customOption"
>;
export type AgentSuggestionFeedbacks =
  readonly Suggestion["feedbacks"][number][];
