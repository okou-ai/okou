import type { ReactNode } from "react";
import { useGet, useLoadable, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@okouai/ui";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import { customConnectorMcpEnabled$ } from "../../signals/external/feature-switch.ts";
import { reloadConnectors$ } from "../../signals/external/connectors.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  connectorDirectoryCustomScope$,
  openConnectorDirectoryScope$,
  showCreatedDirectoryConnector$,
} from "../../signals/okou-page/settings/connector-directory-route.ts";
import {
  connectorsCategoryFilter$,
  connectorsSearch$,
} from "../../signals/okou-page/settings/connectors.ts";
import {
  openCustomConnectorCreateDialog$,
  retryCustomConnectors$,
} from "../../signals/okou-page/settings/custom-connectors.ts";
import { filteredDirectoryCustomConnectors$ } from "../../signals/okou-page/settings/connector-directory-custom.ts";
import { REMOTE_ACCESS_CATEGORY } from "../../signals/okou-page/settings/ssh-connector.ts";
import {
  CustomConnectorDirectoryDialogs,
  CustomConnectorGrid,
} from "./components/settings/custom-connectors-panel.tsx";

type SourceState = "loading" | "hasData" | "hasError";

export function NewCustomConnectorButton() {
  const { t } = useTranslation();
  const openCreate = useSet(openCustomConnectorCreateDialog$);
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0 gap-2"
      onClick={openCreate}
    >
      <Plus size={14} aria-hidden="true" />
      {t(($) => {
        return $.connectors.custom.create.title;
      })}
    </Button>
  );
}

function DirectoryLoadError({
  message,
  retry,
}: {
  readonly message: string;
  readonly retry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={retry}>
        {t(($) => {
          return $.connectors.catalog.directory.retry;
        })}
      </Button>
    </div>
  );
}

function DirectoryCustomSection({
  connectors,
  sourceState,
  isAdmin,
  customOnly,
  searching,
}: {
  readonly connectors: readonly CustomConnectorResponse[];
  readonly sourceState: SourceState;
  readonly isAdmin: boolean;
  readonly customOnly: boolean;
  readonly searching: boolean;
}) {
  const { t } = useTranslation();
  const retry = useSet(retryCustomConnectors$);
  const mcpEnabled = useGet(customConnectorMcpEnabled$);
  if (
    sourceState === "hasData" &&
    connectors.length === 0 &&
    !customOnly &&
    (searching || !isAdmin)
  ) {
    return null;
  }
  return (
    <section
      aria-label={t(($) => {
        return $.connectors.catalog.directory.custom;
      })}
      className="flex flex-col gap-3"
    >
      <h2 className="text-sm font-medium text-muted-foreground">
        {t(($) => {
          return $.connectors.catalog.directory.custom;
        })}
      </h2>
      {sourceState === "hasError" ? (
        <DirectoryLoadError
          message={t(($) => {
            return $.connectors.catalog.directory.customLoadFailed;
          })}
          retry={retry}
        />
      ) : sourceState === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.catalog.directory.loading;
          })}
        </p>
      ) : connectors.length > 0 ? (
        <CustomConnectorGrid
          connectors={connectors}
          isAdmin={isAdmin}
          mcpEnabled={mcpEnabled}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {searching
            ? t(($) => {
                return $.connectors.catalog.directory.noCustomMatches;
              })
            : isAdmin
              ? t(($) => {
                  return $.connectors.catalog.directory.emptyCustom;
                })
              : t(($) => {
                  return $.connectors.custom.emptyMember;
                })}
        </p>
      )}
    </section>
  );
}

function DirectoryEmpty({
  scoped,
  isAdmin,
}: {
  readonly scoped: boolean;
  readonly isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const search = useGet(connectorsSearch$);
  const openScope = useSet(openConnectorDirectoryScope$);
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
      <p>
        {scoped
          ? t(($) => {
              return $.connectors.catalog.directory.noCategoryMatches;
            })
          : t(
              ($) => {
                return $.connectors.catalog.empty.search;
              },
              { search: search.trim() },
            )}
      </p>
      {scoped ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            openScope({ kind: "all" });
          }}
        >
          {t(($) => {
            return $.connectors.catalog.directory.searchAll;
          })}
        </Button>
      ) : isAdmin ? (
        <NewCustomConnectorButton />
      ) : null}
    </div>
  );
}

export function ConnectorsDirectoryContent({
  builtin,
  builtinState,
  builtinCount,
  remote,
  remoteState,
  remoteCount,
}: {
  readonly builtin: ReactNode;
  readonly builtinState: SourceState;
  readonly builtinCount: number;
  readonly remote: ReactNode;
  readonly remoteState: SourceState;
  readonly remoteCount: number;
}) {
  const { t } = useTranslation();
  const search = useGet(connectorsSearch$).trim().toLowerCase();
  const category = useGet(connectorsCategoryFilter$);
  const customOnly = useGet(connectorDirectoryCustomScope$);
  const custom = useLoadable(filteredDirectoryCustomConnectors$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const showCreated = useSet(showCreatedDirectoryConnector$);
  const retryCatalog = useSet(reloadConnectors$);
  const connectors = custom.state === "hasData" ? custom.data : [];
  // Custom is its own scope now, so the catalog no longer carries it as a
  // trailing block. Browsing is scoped; searching is not, so a keyword still
  // reaches across and reports its custom matches in their own section.
  const showCustom = customOnly || (Boolean(search) && category === null);
  const showBuiltin = !customOnly && category !== REMOTE_ACCESS_CATEGORY;
  const showRemote =
    !customOnly && (category === null || category === REMOTE_ACCESS_CATEGORY);
  const sources = [
    { visible: showCustom, state: custom.state, count: connectors.length },
    { visible: showBuiltin, state: builtinState, count: builtinCount },
    { visible: showRemote, state: remoteState, count: remoteCount },
  ];
  const empty = sources.every((source) => {
    return (
      !source.visible || (source.state === "hasData" && source.count === 0)
    );
  });
  return (
    <>
      {showBuiltin &&
        (builtinState === "hasError" ? (
          <DirectoryLoadError
            message={t(($) => {
              return $.connectors.catalog.directory.builtinLoadFailed;
            })}
            retry={retryCatalog}
          />
        ) : search && category === null && builtinCount > 0 ? (
          <section
            aria-label={t(($) => {
              return $.connectors.catalog.directory.builtin;
            })}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium text-muted-foreground">
              {t(($) => {
                return $.connectors.catalog.directory.builtin;
              })}
            </h2>
            {builtin}
          </section>
        ) : (
          builtin
        ))}
      {showRemote && remote}
      {showCustom && (
        <DirectoryCustomSection
          connectors={connectors}
          sourceState={custom.state}
          isAdmin={isAdmin}
          customOnly={customOnly}
          searching={Boolean(search)}
        />
      )}
      {empty && !customOnly && (Boolean(search) || category !== null) && (
        <DirectoryEmpty scoped={category !== null} isAdmin={isAdmin} />
      )}
      <CustomConnectorDirectoryDialogs
        onCreated={(connector) => {
          showCreated(connector.id);
        }}
      />
    </>
  );
}
