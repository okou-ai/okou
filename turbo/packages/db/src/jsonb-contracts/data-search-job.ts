import type {
  DataSearchCreateRequest,
  DataSearchRequest,
  DataSearchJobResponse,
} from "@okouai/api-contracts/contracts/data-search";

export type DataSearchJobRequest = DataSearchCreateRequest;
export type DataSearchJobResult = NonNullable<DataSearchJobResponse["data"]>;
export type DataSearchJobError = NonNullable<DataSearchJobResponse["error"]>;
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
