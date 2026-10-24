import type {
  DataSearchCreateRequest,
  DataSearchRequest,
} from "@okouai/api-contracts/contracts/data-search";

export type DataSearchJobRequest = DataSearchCreateRequest;
/** Historical persisted results; the Router owns new execution results. */
export interface DataSearchJobResult {
  readonly items: DataSearchRequest["input"][string][];
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
