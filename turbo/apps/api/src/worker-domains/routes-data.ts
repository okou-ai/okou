// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../signals/route-entry";
import { cronCleanupXResourceReadsRoutes } from "../signals/routes/cron-cleanup-x-resource-reads";
import { cronReconcileSocialKitDownloadRoutes } from "../signals/routes/cron-reconcile-socialkit-downloads";
import { financeRoutes } from "../signals/routes/finance";
import { seoRoutes } from "../signals/routes/seo";
import { commerceRoutes } from "../signals/routes/commerce";
import { cronReconcileCommerceJobRoutes } from "../signals/routes/cron-reconcile-commerce-jobs";
import { mapsRoutes } from "../signals/routes/maps";
import { weatherRoutes } from "../signals/routes/weather";
import { scrapeRoutes } from "../signals/routes/scrape";
import { peopleSearchRoutes } from "../signals/routes/people-search";
import { webSearchRoutes } from "../signals/routes/web-search";
import { socialRoutes } from "../signals/routes/social";
import { socialDataRoutes } from "../signals/routes/social-data";
import { dataSearchRoutes } from "../signals/routes/data-search";

export const DATA_ROUTES: readonly RouteEntry[] = [
  ...cronCleanupXResourceReadsRoutes,
  ...cronReconcileSocialKitDownloadRoutes,
  ...financeRoutes,
  ...seoRoutes,
  ...commerceRoutes,
  ...cronReconcileCommerceJobRoutes,
  ...mapsRoutes,
  ...weatherRoutes,
  ...scrapeRoutes,
  ...peopleSearchRoutes,
  ...webSearchRoutes,
  ...socialRoutes,
  ...socialDataRoutes,
  ...dataSearchRoutes,
];
