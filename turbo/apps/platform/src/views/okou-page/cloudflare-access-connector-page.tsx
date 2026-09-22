import { Cloud, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";
import {
  CloudflareAccessConfigs,
  CloudflareAccessDialog,
} from "./cloudflare-access.tsx";

export function CloudflareAccessConnectorPage() {
  const { t } = useTranslation();
  return (
    <DetailPageShell>
      <DetailPageBreadcrumbBar>
        <Link
          pathname={ROUTES.connectors}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-inherit no-underline transition-colors hover:bg-state-hover hover:text-foreground"
        >
          <Plug size={14} className="shrink-0" aria-hidden="true" />
          {t(($) => {
            return $.appShell.sidebar.navigation.connectors;
          })}
        </Link>
        <span className="select-none text-muted-foreground/40">/</span>
        <span
          aria-current="page"
          className="min-w-0 truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
        >
          {t(($) => {
            return $.cloudflareAccess.title;
          })}
        </span>
      </DetailPageBreadcrumbBar>
      <DetailPageHeader>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gray-50 text-muted-foreground sm:h-16 sm:w-16">
            <Cloud size={28} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t(($) => {
                return $.cloudflareAccess.title;
              })}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t(($) => {
                return $.cloudflareAccess.description;
              })}
            </p>
          </div>
        </div>
      </DetailPageHeader>
      <DetailPageMain constrainContent>
        <CloudflareAccessConfigs />
        <CloudflareAccessDialog />
      </DetailPageMain>
    </DetailPageShell>
  );
}
