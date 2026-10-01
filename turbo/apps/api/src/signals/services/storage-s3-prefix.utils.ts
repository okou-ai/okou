import { randomUUID } from "node:crypto";

/**
 * Identity and S3 prefix for a new storage row: `{orgId}/{storageId}`.
 *
 * The storage id goes into the prefix because it is the only immutable,
 * globally unique attribute of a storage row. Prefixes that encode mutable
 * or shared attributes went stale twice already: org slugs broke on rename
 * (#7186), and `{orgId}/{type}/{name}` collides across users because the
 * per-user ownership model landed after the user segment was dropped from
 * the path (#22148). Several historical prefix formats coexist in
 * production, so a prefix must always be read from `storages.s3_prefix`
 * and never derived from other columns.
 */
export function newStorageS3Location(
  orgId: string,
  storageId: string = randomUUID(),
): {
  readonly storageId: string;
  readonly s3Prefix: string;
} {
  return { storageId, s3Prefix: `${orgId}/${storageId}` };
}
