export type PermissionActionOwner = {
  readonly kind: "member";
  readonly orgId: string;
  readonly userId: string;
};

export function memberPermissionOwner(
  params: URLSearchParams,
): PermissionActionOwner | null {
  const orgIds = params.getAll("orgId");
  const userIds = params.getAll("userId");
  const orgId = orgIds[0];
  const userId = userIds[0];
  if (
    orgIds.length !== 1 ||
    userIds.length !== 1 ||
    !orgId ||
    orgId !== orgId.trim() ||
    !userId ||
    userId !== userId.trim()
  ) {
    return null;
  }
  return { kind: "member", orgId, userId };
}
