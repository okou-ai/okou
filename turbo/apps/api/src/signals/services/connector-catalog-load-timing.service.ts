import {
  measureApiDispatchTiming,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";

type AcceptedConnectorCatalogCacheOutcome = "hit" | "miss" | "in_flight";
type AcceptedConnectorCatalogCacheMissReason =
  "process_empty" | "catalog_identity_changed" | "capability_identity_changed";
type ConnectorRuntimeSnapshotCacheOutcome = "hit" | "miss";
type ConnectorCatalogValidationResult =
  | { readonly outcome: "attested" }
  | {
      readonly outcome: "full_fallback";
      readonly fallbackReason:
        "missing_authority" | "different_authority" | "missing_compatibility";
    }
  | { readonly outcome: "not_run" };

type ConnectorCatalogCountBucket =
  "0" | "1" | "2_4" | "5_8" | "9_16" | "17_plus";
type ConnectorCatalogRawSizeBucket =
  | "0_255_kib"
  | "256_511_kib"
  | "512_1023_kib"
  | "1_2_mib"
  | "2_4_mib"
  | "4_8_mib"
  | "8_16_mib"
  | "16_32_mib"
  | "32_64_mib";
type ConnectorCatalogCompressedSizeBucket =
  ConnectorCatalogRawSizeBucket | "64_128_mib";
type ConnectorCatalogResolvedConnectorFractionBucket =
  | "not_applicable"
  | "none"
  | "up_to_25_percent"
  | "26_50_percent"
  | "51_75_percent"
  | "76_99_percent"
  | "all";

function countBucket(count: number): ConnectorCatalogCountBucket {
  if (count === 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function rawSizeBucket(size: number): ConnectorCatalogRawSizeBucket {
  if (size < 256 * 1024) {
    return "0_255_kib";
  }
  if (size < 512 * 1024) {
    return "256_511_kib";
  }
  if (size < 1024 * 1024) {
    return "512_1023_kib";
  }
  if (size < 2 * 1024 * 1024) {
    return "1_2_mib";
  }
  if (size < 4 * 1024 * 1024) {
    return "2_4_mib";
  }
  if (size < 8 * 1024 * 1024) {
    return "4_8_mib";
  }
  if (size < 16 * 1024 * 1024) {
    return "8_16_mib";
  }
  if (size < 32 * 1024 * 1024) {
    return "16_32_mib";
  }
  return "32_64_mib";
}

function compressedSizeBucket(
  size: number,
): ConnectorCatalogCompressedSizeBucket {
  return size < 64 * 1024 * 1024 ? rawSizeBucket(size) : "64_128_mib";
}

function resolvedConnectorFractionBucket(
  resolvedConnectorCount: number | undefined,
  connectorCount: number,
): ConnectorCatalogResolvedConnectorFractionBucket {
  if (resolvedConnectorCount === undefined) {
    return "not_applicable";
  }
  if (resolvedConnectorCount === 0) {
    return "none";
  }
  if (resolvedConnectorCount === connectorCount) {
    return "all";
  }
  if (resolvedConnectorCount * 4 <= connectorCount) {
    return "up_to_25_percent";
  }
  if (resolvedConnectorCount * 2 <= connectorCount) {
    return "26_50_percent";
  }
  if (resolvedConnectorCount * 4 <= connectorCount * 3) {
    return "51_75_percent";
  }
  return "76_99_percent";
}

function acceptedCacheOutcomeRank(
  outcome: AcceptedConnectorCatalogCacheOutcome,
): number {
  switch (outcome) {
    case "hit": {
      return 0;
    }
    case "in_flight": {
      return 1;
    }
    case "miss": {
      return 2;
    }
  }
}

export class ConnectorCatalogLoadTiming {
  private acceptedCacheOutcome:
    AcceptedConnectorCatalogCacheOutcome | undefined;
  private acceptedCacheMissReason:
    AcceptedConnectorCatalogCacheMissReason | undefined;
  private runtimeCacheOutcome: ConnectorRuntimeSnapshotCacheOutcome | undefined;
  private validationResult: ConnectorCatalogValidationResult | undefined;
  private catalogRawSize: number | undefined;
  private catalogCompressedSize: number | undefined;
  private connectorCount: number | undefined;
  private resolvedConnectorCount: number | undefined;
  private materializedConnectorCount: number | undefined;

  constructor(
    private readonly collector: ApiDispatchTimingCollector | undefined,
    private requestedConnectorCount: number | undefined,
    private metadataConnectorCount: number | undefined = undefined,
  ) {}

  recordRequestedConnectorCounts(args: {
    readonly requestedConnectorCount: number;
    readonly metadataConnectorCount: number;
  }): void {
    this.requestedConnectorCount = args.requestedConnectorCount;
    this.metadataConnectorCount = args.metadataConnectorCount;
  }

  recordAcceptedCacheOutcome(
    outcome: AcceptedConnectorCatalogCacheOutcome,
  ): void {
    if (
      this.acceptedCacheOutcome === undefined ||
      acceptedCacheOutcomeRank(outcome) >
        acceptedCacheOutcomeRank(this.acceptedCacheOutcome)
    ) {
      this.acceptedCacheOutcome = outcome;
    }
  }

  recordAcceptedCacheMissReason(
    reason: AcceptedConnectorCatalogCacheMissReason,
  ): void {
    this.acceptedCacheMissReason ??= reason;
  }

  recordRuntimeCacheOutcome(
    outcome: ConnectorRuntimeSnapshotCacheOutcome,
  ): void {
    this.runtimeCacheOutcome = outcome;
  }

  recordValidationResult(result: ConnectorCatalogValidationResult): void {
    this.validationResult = result;
  }

  recordCatalogFacts(args: {
    readonly rawSize: number;
    readonly compressedSize: number;
    readonly connectorCount: number;
    readonly resolvedConnectorCount: number | undefined;
  }): void {
    this.catalogRawSize = args.rawSize;
    this.catalogCompressedSize = args.compressedSize;
    this.connectorCount = args.connectorCount;
    this.resolvedConnectorCount = args.resolvedConnectorCount;
  }

  recordMaterializedConnectorCount(count: number): void {
    this.materializedConnectorCount = count;
  }

  async measure<T>(
    actionType: ApiDispatchTimingActionType,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return await measureApiDispatchTiming(
      this.collector,
      actionType,
      "nested",
      operation,
    );
  }

  measureSync<T>(
    actionType: ApiDispatchTimingActionType,
    operation: () => T,
  ): T {
    if (!this.collector) {
      return operation();
    }
    return this.collector.measureSync(actionType, "nested", operation);
  }

  async measureComplete<T>(operation: () => T | Promise<T>): Promise<T> {
    return await measureApiDispatchTiming(
      this.collector,
      "api_dispatch_connector_catalog_load_runtime_snapshot",
      "nested",
      operation,
      () => {
        return this.completeDimensions();
      },
    );
  }

  private completeDimensions(): ApiDispatchTimingDimensions {
    return {
      ...(this.acceptedCacheOutcome === undefined
        ? {}
        : {
            connector_catalog_accepted_cache_outcome: this.acceptedCacheOutcome,
          }),
      ...(this.acceptedCacheMissReason === undefined
        ? {}
        : {
            connector_catalog_accepted_cache_miss_reason:
              this.acceptedCacheMissReason,
          }),
      ...(this.runtimeCacheOutcome === undefined
        ? {}
        : {
            connector_catalog_runtime_cache_outcome: this.runtimeCacheOutcome,
          }),
      ...(this.validationResult === undefined
        ? {}
        : {
            connector_catalog_validation_outcome: this.validationResult.outcome,
            ...(this.validationResult.outcome === "full_fallback"
              ? {
                  connector_catalog_validation_fallback_reason:
                    this.validationResult.fallbackReason,
                }
              : {}),
          }),
      ...(this.catalogRawSize === undefined
        ? {}
        : {
            connector_catalog_raw_size_bucket: rawSizeBucket(
              this.catalogRawSize,
            ),
          }),
      ...(this.catalogCompressedSize === undefined
        ? {}
        : {
            connector_catalog_compressed_size_bucket: compressedSizeBucket(
              this.catalogCompressedSize,
            ),
          }),
      ...(this.connectorCount === undefined
        ? {}
        : {
            connector_catalog_connector_count_bucket: countBucket(
              this.connectorCount,
            ),
            connector_catalog_resolved_connector_fraction_bucket:
              resolvedConnectorFractionBucket(
                this.resolvedConnectorCount,
                this.connectorCount,
              ),
          }),
      connector_catalog_requested_connector_count_bucket:
        this.requestedConnectorCount === undefined
          ? "not_applicable"
          : countBucket(this.requestedConnectorCount),
      connector_catalog_metadata_connector_count_bucket:
        this.metadataConnectorCount === undefined
          ? "not_applicable"
          : countBucket(this.metadataConnectorCount),
      ...(this.materializedConnectorCount === undefined
        ? {}
        : {
            connector_catalog_materialized_connector_count_bucket: countBucket(
              this.materializedConnectorCount,
            ),
          }),
    };
  }
}
