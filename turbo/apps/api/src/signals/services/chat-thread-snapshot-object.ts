import { createHash } from "node:crypto";

const SNAPSHOT_OBJECT_PREFIX = "chat-thread-snapshots/v1";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeDigest(userId: string, orgId: string): string {
  return sha256(`${userId}\0${orgId}`);
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
  readonly latestSeqId: number | null;
  readonly body: Buffer;
}): string {
  return `${chatThreadSnapshotObjectPrefix(args.userId, args.orgId)}${(args.latestSeqId ?? 0).toString()}-${sha256(args.body)}.json.gz`;
}

export function isOwnedChatThreadSnapshotObjectKey(
  objectKey: string,
  userId: string,
  orgId: string,
  latestSeqId: number | null,
): boolean {
  const prefix = chatThreadSnapshotObjectPrefix(userId, orgId);
  if (!objectKey.startsWith(prefix)) {
    return false;
  }
  const match = /^([0-9]+)-[0-9a-f]{64}[.]json[.]gz$/u.exec(
    objectKey.slice(prefix.length),
  );
  return match?.[1] === (latestSeqId ?? 0).toString();
}
