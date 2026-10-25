import type { JsonObject, JsonValue } from "./shared";

/** Historical request fields retained with their database owner. */
interface DataSearchRequest {
  readonly capability: string;
  readonly input: JsonObject;
  readonly limit: number;
}

export interface DataSearchJobRequest extends DataSearchRequest {
  readonly requestId: string;
  readonly maxCredits: number;
}
/** Historical persisted results; the Router owns new execution results. */
export interface DataSearchJobResult {
  readonly items: JsonValue[];
}
export interface DataSearchJobError {
  readonly code: string;
  readonly message: string;
}
/** Audited immutable routing snapshot, not a public provider passthrough. */
export interface DataSearchJobPlan {
  readonly capability: string;
  readonly vendor: "monid" | "firecrawl";
  readonly provider: string;
  readonly endpoint: string;
  readonly input: DataSearchRequest["input"];
  readonly limit: number;
  readonly request: DataSearchRequest;
  readonly sourceCostUsdMicrosPerCredit?: number;
}
