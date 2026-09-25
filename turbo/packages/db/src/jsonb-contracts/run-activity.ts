/** Disposable, normalized public evidence; never a conversation history. */
export interface RunActivityEntry {
  readonly sequence: number;
  readonly index: number;
  readonly kind: "message" | "tool" | "result";
  readonly name: string;
  readonly callId: string;
  readonly excerpt: string;
}
export type RunActivityEntries = readonly RunActivityEntry[];
