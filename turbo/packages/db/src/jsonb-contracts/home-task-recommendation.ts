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
  /** The ranking model's 0-100 judgement of how ready this task is to run. */
  readonly actionability: number;
  readonly connectors: readonly string[];
}
export type HomeTaskRecommendationEntries =
  readonly HomeTaskRecommendationEntry[];
