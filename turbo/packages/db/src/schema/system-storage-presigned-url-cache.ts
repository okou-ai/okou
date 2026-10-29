import { index, pgTable, timestamp } from "drizzle-orm/pg-core";
import { systemStoragePresignedUrlCacheColumns } from "../columns/system-storage-presigned-url-cache";

export const systemStoragePresignedUrlCache = pgTable(
  "system_storage_presigned_url_cache",
  {
    ...systemStoragePresignedUrlCacheColumns(),
    // #34149 retired renewal. Outgoing API writers still populate this column
    // until a rollback floor excludes them; the runtime mapping never names it.
    refreshAfter: timestamp("refresh_after"),
  },
  (table) => {
    return [
      index("idx_system_storage_presigned_url_cache_refresh_after").on(
        table.refreshAfter,
      ),
      index("idx_system_storage_presigned_url_cache_last_requested_at").on(
        table.lastRequestedAt,
      ),
      index("idx_system_storage_presigned_url_cache_active_refresh").on(
        table.lastRequestedAt,
        table.refreshAfter,
      ),
      index("idx_system_storage_presigned_url_cache_scope_refresh_after").on(
        table.scope,
        table.refreshAfter,
      ),
      index("idx_system_storage_presigned_url_cache_scope_active_refresh").on(
        table.scope,
        table.lastRequestedAt,
        table.refreshAfter,
      ),
    ];
  },
);
