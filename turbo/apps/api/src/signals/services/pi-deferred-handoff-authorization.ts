interface DeferredPiHandoffAuth {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly piSandbox?: {
    readonly ownerEpoch: number;
    readonly generation: number;
  };
}

interface DeferredPiHandoffOwner {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly runStatus: string;
  readonly phase: string | undefined;
  readonly ownerEpoch: number | undefined;
  readonly generation: number | undefined;
  readonly leaseState: string | undefined;
}

/** Match the authenticated Guest control claim to the exact claimed lease. */
export function hasDeferredPiHandoffAuthority(
  auth: DeferredPiHandoffAuth,
  owner: DeferredPiHandoffOwner,
): boolean {
  return (
    auth.piSandbox !== undefined &&
    auth.runId === owner.runId &&
    auth.userId === owner.userId &&
    auth.orgId === owner.orgId &&
    owner.runStatus === "running" &&
    owner.phase === "sandbox_running" &&
    owner.ownerEpoch === auth.piSandbox.ownerEpoch &&
    owner.generation === auth.piSandbox.generation &&
    owner.leaseState === "claimed"
  );
}
