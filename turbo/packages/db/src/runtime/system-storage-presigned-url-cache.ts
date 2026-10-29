import { pgTable } from "drizzle-orm/pg-core";
import { systemStoragePresignedUrlCacheColumns } from "../columns/system-storage-presigned-url-cache";

/** Application mapping without the retired renewal deadline. */
export const systemStoragePresignedUrlCache = pgTable(
  "system_storage_presigned_url_cache",
  systemStoragePresignedUrlCacheColumns(),
);
