import { createHash, randomUUID } from "node:crypto";

const SNAPSHOT_OBJECT_PREFIX = "chat-thread-snapshots/v1";

function scopeDigest(userId: string, orgId: string): string {
  return createHash("sha256").update(`${userId}\0${orgId}`).digest("hex");
}

export function chatThreadSnapshotObjectPrefix(
  userId: string,
  orgId: string,
): string {
  return `${SNAPSHOT_OBJECT_PREFIX}/${scopeDigest(userId, orgId)}/`;
}

export function chatThreadSnapshotObjectKey(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  return `${chatThreadSnapshotObjectPrefix(args.userId, args.orgId)}${randomUUID()}.json.gz`;
}

export function isOwnedChatThreadSnapshotObjectKey(
  objectKey: string,
  userId: string,
  orgId: string,
): boolean {
  const prefix = chatThreadSnapshotObjectPrefix(userId, orgId);
  if (!objectKey.startsWith(prefix)) {
    return false;
  }
  return /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*[.]json[.]gz$/u.test(
    objectKey.slice(prefix.length),
  );
}
