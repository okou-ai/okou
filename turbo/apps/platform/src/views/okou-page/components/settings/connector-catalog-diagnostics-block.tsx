import type {
  ConnectorCatalogCompatibilityReason,
  ConnectorCatalogDiagnostics,
  ConnectorCatalogSyncFailureCode,
} from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import { ChevronDown, ChevronUp, Plug } from "lucide-react";
import { useLoadable } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@okouai/ui";

import {
  formatLocalizedNumber,
  resolvedAppLocale,
} from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";
import { connectorCatalogDiagnostics$ } from "../../../../signals/okou-page/settings/connector-catalog-diagnostics.ts";

type DiagnosticEnumValue =
  | ConnectorCatalogDiagnostics["state"]
  | NonNullable<ConnectorCatalogDiagnostics["lastAttempt"]>["outcome"]
  | ConnectorCatalogSyncFailureCode
  | ConnectorCatalogCompatibilityReason;

function emptyValue(): string {
  return i18n.t(($) => {
    return $.connectors.providerSettings.catalogDiagnostics.none;
  });
}

const DIAGNOSTIC_ENUM_VALUE_TRANSLATIONS: Readonly<
  Record<DiagnosticEnumValue, () => string>
> = {
  "unsupported-generic-strategy": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .unsupportedGenericStrategy;
    });
  },
  accepted: () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values.accepted;
    });
  },
  current: () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values.current;
    });
  },
  "digest-mismatch": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .digestMismatch;
    });
  },
  "invalid-artifact": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .invalidArtifact;
    });
  },
  "invalid-compression": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .invalidCompression;
    });
  },
  "invalid-json": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .invalidJson;
    });
  },
  "invalid-pointer": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .invalidPointer;
    });
  },
  "invalid-reference": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .invalidReference;
    });
  },
  "missing-access-provider": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .missingAccessProvider;
    });
  },
  "missing-grant-provider": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .missingGrantProvider;
    });
  },
  "missing-platform-configuration": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .missingPlatformConfiguration;
    });
  },
  "missing-revoke-provider": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .missingRevokeProvider;
    });
  },
  "never-synced": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .neverSynced;
    });
  },
  "object-too-large": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .objectTooLarge;
    });
  },
  "provider-contract-mismatch": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .providerContractMismatch;
    });
  },
  "public-leakage": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .publicLeakage;
    });
  },
  rejected: () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values.rejected;
    });
  },
  "relationship-mismatch": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .relationshipMismatch;
    });
  },
  "source-unavailable": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .sourceUnavailable;
    });
  },
  stale: () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values.stale;
    });
  },
  unchanged: () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values.unchanged;
    });
  },
  "unsupported-schema": () => {
    return i18n.t(($) => {
      return $.connectors.providerSettings.catalogDiagnostics.values
        .unsupportedSchema;
    });
  },
};

function formatEnumValue(value: DiagnosticEnumValue): string {
  return DIAGNOSTIC_ENUM_VALUE_TRANSLATIONS[value]();
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return emptyValue();
  }
  return new Intl.DateTimeFormat(resolvedAppLocale(), {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatRejectedAttemptCacheUse(
  lastAttempt: ConnectorCatalogDiagnostics["lastAttempt"],
): string {
  if (!lastAttempt || lastAttempt.outcome !== "rejected") {
    return emptyValue();
  }
  return lastAttempt.reusedCachedRejection
    ? i18n.t(($) => {
        return $.connectors.providerSettings.catalogDiagnostics.reused;
      })
    : i18n.t(($) => {
        return $.connectors.providerSettings.catalogDiagnostics.notReused;
      });
}

function DiagnosticField({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly code?: boolean;
}) {
  const Value = code ? "code" : "div";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Value
        className={
          code
            ? "min-w-0 break-all text-xs leading-5 text-foreground"
            : "min-w-0 break-words text-sm font-medium text-foreground"
        }
      >
        {value}
      </Value>
    </div>
  );
}

function CatalogDiagnosticsSummary({
  diagnostics,
}: {
  readonly diagnostics: ConnectorCatalogDiagnostics;
}) {
  const activeVersion = diagnostics.active?.catalogVersion ?? emptyValue();
  const lastAttempt = diagnostics.lastAttempt
    ? formatEnumValue(diagnostics.lastAttempt.outcome)
    : emptyValue();
  const evaluation = formatEnumValue(
    diagnostics.filtering.stale ? "stale" : "current",
  );

  return (
    <summary className="flex w-full cursor-pointer list-none items-start gap-4 p-4 text-left transition-colors hover:bg-state-hover [&::-webkit-details-marker]:hidden">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <Plug size={22} className="text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span
          id="connector-catalog-diagnostics-title"
          className="text-sm font-medium text-foreground"
        >
          {i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.title;
          })}
        </span>
        <span className="flex min-w-0 flex-wrap gap-1.5 font-mono text-[11px] text-foreground">
          <Badge className="max-w-full break-all">
            {i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .syncState;
            })}
            : {formatEnumValue(diagnostics.state)}
          </Badge>
          <Badge className="max-w-full break-all">
            {i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .activeVersion;
            })}
            : {activeVersion}
          </Badge>
          <Badge className="max-w-full break-all">
            {i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .lastAttempt;
            })}
            : {lastAttempt}
          </Badge>
          <Badge className="max-w-full break-all">
            {i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .evaluation;
            })}
            : {evaluation}
          </Badge>
        </span>
      </span>
      <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground group-open:hidden" />
      <ChevronUp className="mt-1 hidden h-4 w-4 shrink-0 text-muted-foreground group-open:block" />
    </summary>
  );
}

function RejectedCandidateDiagnostics({
  candidate,
}: {
  readonly candidate: NonNullable<
    ConnectorCatalogDiagnostics["rejectedCandidate"]
  >;
}) {
  return (
    <div className="border-t border-border/60 pt-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {i18n.t(($) => {
          return $.connectors.providerSettings.catalogDiagnostics.sections
            .rejectedCandidate;
        })}
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .rejectedVersion;
          })}
          value={candidate.catalogVersion ?? emptyValue()}
          code={candidate.catalogVersion !== null}
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .rejectingBackend;
          })}
          value={candidate.backendVersion}
          code
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .rejectionFailure;
          })}
          value={formatEnumValue(candidate.failureCode)}
        />
      </div>
      <div className="mt-4">
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .rejectedCatalogDigest;
          })}
          value={candidate.catalogDigest ?? emptyValue()}
          code={candidate.catalogDigest !== null}
        />
      </div>
    </div>
  );
}

function CatalogSyncDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: ConnectorCatalogDiagnostics;
}) {
  const active = diagnostics.active;
  const lastAttempt = diagnostics.lastAttempt;
  return (
    <>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .syncState;
          })}
          value={formatEnumValue(diagnostics.state)}
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .lastAttempt;
          })}
          value={
            lastAttempt ? formatEnumValue(lastAttempt.outcome) : emptyValue()
          }
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .activeVersion;
          })}
          value={active?.catalogVersion ?? emptyValue()}
          code={active !== null}
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .activated;
          })}
          value={formatTimestamp(active?.activatedAt ?? null)}
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .lastAttemptAt;
          })}
          value={formatTimestamp(lastAttempt?.at ?? null)}
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .lastSuccess;
          })}
          value={formatTimestamp(diagnostics.lastSuccessAt)}
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .failureCode;
          })}
          value={
            lastAttempt?.failureCode
              ? formatEnumValue(lastAttempt.failureCode)
              : emptyValue()
          }
        />
        <DiagnosticField
          label={i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.fields
              .rejectionCache;
          })}
          value={formatRejectedAttemptCacheUse(lastAttempt)}
        />
      </div>

      <DiagnosticField
        label={i18n.t(($) => {
          return $.connectors.providerSettings.catalogDiagnostics.fields
            .activeCatalogDigest;
        })}
        value={active?.catalogDigest ?? emptyValue()}
        code={active !== null}
      />

      {diagnostics.rejectedCandidate ? (
        <RejectedCandidateDiagnostics
          candidate={diagnostics.rejectedCandidate}
        />
      ) : null}
    </>
  );
}

function DiagnosticsContent({
  diagnostics,
}: {
  readonly diagnostics: ConnectorCatalogDiagnostics;
}) {
  const filteredAuthMethods = diagnostics.filtering.filteredAuthMethods;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <CatalogSyncDiagnostics diagnostics={diagnostics} />

      <div className="border-t border-border/60 pt-4">
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.sections
              .compatibility;
          })}
        </div>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <DiagnosticField
            label={i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .evaluation;
            })}
            value={formatEnumValue(
              diagnostics.filtering.stale ? "stale" : "current",
            )}
          />
          <DiagnosticField
            label={i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .evaluated;
            })}
            value={formatTimestamp(diagnostics.filtering.evaluatedAt)}
          />
        </div>
        <div className="mt-4">
          <DiagnosticField
            label={i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .executableCapabilityDigest;
            })}
            value={diagnostics.filtering.capabilityDigest}
            code
          />
        </div>
        <div className="mt-4 flex min-w-0 flex-col gap-2">
          <div className="text-xs text-muted-foreground">
            {i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .filteredAuthMethods;
            })}
          </div>
          {filteredAuthMethods.length === 0 ? (
            <div className="text-sm font-medium text-foreground">
              {emptyValue()}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-2">
              {filteredAuthMethods.map((method) => {
                return (
                  <div
                    key={`${method.connectorSlug}:${method.authMethodId}`}
                    className="min-w-0 rounded-lg bg-muted/40 px-3 py-2"
                  >
                    <code className="block break-all text-xs font-medium text-foreground">
                      {method.connectorSlug} / {method.authMethodId}
                    </code>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {method.reasons.map(formatEnumValue).join(", ")}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/60 pt-4">
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {i18n.t(($) => {
            return $.connectors.providerSettings.catalogDiagnostics.sections
              .credentialStorage;
          })}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <DiagnosticField
            label={i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .missingVersions;
            })}
            value={formatLocalizedNumber(
              diagnostics.credentialStorage.missingConnectorVersions,
            )}
          />
          <DiagnosticField
            label={i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .unownedSecrets;
            })}
            value={formatLocalizedNumber(
              diagnostics.credentialStorage.unownedConnectorSecrets,
            )}
          />
          <DiagnosticField
            label={i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .unownedVariables;
            })}
            value={formatLocalizedNumber(
              diagnostics.credentialStorage.unownedConnectorVariables,
            )}
          />
          <DiagnosticField
            label={i18n.t(($) => {
              return $.connectors.providerSettings.catalogDiagnostics.fields
                .unresolvedBridgeCredentials;
            })}
            value={formatLocalizedNumber(
              diagnostics.credentialStorage.unresolvedBridgeCredentials,
            )}
          />
        </div>
      </div>
    </div>
  );
}

export function ConnectorCatalogDiagnosticsBlock() {
  const { t } = useTranslation();
  const diagnosticsLoadable = useLoadable(connectorCatalogDiagnostics$);
  const loading = diagnosticsLoadable.state === "loading";
  const diagnostics =
    diagnosticsLoadable.state === "hasData" ? diagnosticsLoadable.data : null;

  return (
    <section
      aria-labelledby="connector-catalog-diagnostics-title"
      className="overflow-hidden rounded-xl bg-card border border-surface-border"
    >
      {diagnostics ? (
        <details className="group">
          <CatalogDiagnosticsSummary diagnostics={diagnostics} />
          <div className="border-t border-border/60 p-4">
            <DiagnosticsContent diagnostics={diagnostics} />
          </div>
        </details>
      ) : (
        <div className="flex items-start gap-4 p-4">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Plug size={22} className="text-muted-foreground" />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div
              id="connector-catalog-diagnostics-title"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.connectors.providerSettings.catalogDiagnostics.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">
              {loading
                ? t(($) => {
                    return $.connectors.providerSettings.catalogDiagnostics
                      .loading;
                  })
                : t(($) => {
                    return $.connectors.providerSettings.catalogDiagnostics
                      .unavailable;
                  })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
