/**
 * One generated home page task card.
 *
 * Disposable derived suggestion, never conversation content: the row is
 * replaced on every refresh and the card carries no provider message, no link
 * and no identifier the user did not already own.
 */
export interface HomeTaskRecommendationEntry {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly rationale: string;
  /** Jev's normalized 0-100 judgement of how ready this task is to start. */
  readonly actionability: number;
  readonly target:
    | { readonly kind: "new-thread" }
    | { readonly kind: "existing-thread"; readonly threadId: string };
  readonly connectors: readonly string[];
}
export type HomeTaskRecommendationEntries =
  readonly HomeTaskRecommendationEntry[];
