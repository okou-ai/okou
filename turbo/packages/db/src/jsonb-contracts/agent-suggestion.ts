import type {
  Suggestion,
  SuggestionReceipt,
} from "@okouai/api-contracts/contracts/suggestions";

export type AgentSuggestionEntries = readonly (
  Suggestion | SuggestionReceipt
)[];
