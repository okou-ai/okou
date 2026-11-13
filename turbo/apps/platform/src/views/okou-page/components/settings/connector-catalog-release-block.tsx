import { LoadingSkeleton } from "../../../components/loading-skeleton.tsx";
import { useLoadable } from "ccstate-react";
import { Plug } from "lucide-react";
import { useTranslation } from "react-i18next";

import { connectorCatalogRelease$ } from "../../../../signals/okou-page/settings/connector-catalog-release.ts";

export function ConnectorCatalogReleaseBlock() {
  const { t } = useTranslation();
  const release = useLoadable(connectorCatalogRelease$);
  const catalog = release.state === "hasData" ? release.data : null;
  const unavailable = t(($) => {
    return $.settings.buildInfo.unavailable;
  });
  const placeholder =
    release.state === "loading" ? (
      <LoadingSkeleton
        variant="text"
        label={t(($) => {
          return $.settings.buildInfo.loading;
        })}
      />
    ) : (
      unavailable
    );

  return (
    <section
      aria-labelledby="connector-catalog-release-title"
      className="flex items-start gap-4 rounded-xl bg-card p-4 border border-surface-border"
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center">
        <Plug size={22} className="text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3
          id="connector-catalog-release-title"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.settings.connectorCatalog.title;
          })}
        </h3>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.connectorCatalog.version;
              })}
            </dt>
            <dd className="break-all font-mono text-sm text-foreground">
              {catalog?.catalogVersion ?? placeholder}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.connectorCatalog.schemaVersion;
              })}
            </dt>
            <dd className="font-mono text-sm text-foreground">
              {catalog?.schemaVersion ?? placeholder}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.connectorCatalog.hash;
              })}
            </dt>
            <dd className="break-all rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-4 text-foreground">
              {catalog?.catalogDigest ?? placeholder}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
