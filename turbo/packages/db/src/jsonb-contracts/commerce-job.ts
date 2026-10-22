/** DB-owned persisted Commerce shapes; transport-only flags are not stored. */
export type CommerceJobMarketplace =
  | "amazon.com"
  | "amazon.co.uk"
  | "amazon.de"
  | "amazon.fr"
  | "amazon.it"
  | "amazon.es"
  | "amazon.ca"
  | "amazon.co.jp"
  | "amazon.in";

export type CommerceJobOperation = "search" | "inspect";
export type CommerceJobStatus = "pending" | "running" | "completed" | "failed";

export type CommerceJobRequest =
  | {
      operation: "search";
      body: {
        query: string;
        marketplace: CommerceJobMarketplace;
        limit: number;
      };
    }
  | {
      operation: "inspect";
      body: {
        target: string;
        marketplace?: CommerceJobMarketplace;
      };
    };

export interface CommerceJobResult {
  operation: CommerceJobOperation;
  provider: "dataforseo";
  marketplace: CommerceJobMarketplace;
  billingCategory: "provider_cost_usd_micros";
  billingQuantity: number;
  providerCostUsd: number;
  creditsCharged: number | null;
  result: {
    items: unknown[];
    source: unknown;
  };
}

export interface CommerceJobError {
  code: string;
  message: string;
}
