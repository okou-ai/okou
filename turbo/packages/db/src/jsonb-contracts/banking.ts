import type { JsonObject } from "./shared";

export type BankingOperationScope =
  "accounts.read" | "balances.read" | "transactions.read";

export type BankingConnectionAuditMetadata = JsonObject;
export type BankingAccountMetadata = JsonObject;
export type BankingAccountProviderIds = string[];
export type BankingOperationScopes = BankingOperationScope[];
export type BankingAccessAuditMetadata = JsonObject;
