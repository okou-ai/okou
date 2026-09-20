interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

export const MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS = 2;
export const MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS = 32;

interface Admission {
  readonly principalOccupancy: number;
  readonly runtimeOccupancy: number;
  readonly release: () => void;
}

const principalWaiters = new Map<string, number>();
let runtimeWaiters = 0;

function principalKey(principal: Principal): string {
  return `${principal.orgId}\0${principal.userId}`;
}

/** Admit finite request-owned waits without logging principal identifiers. */
export function admitMcpChatStatusWaiter(
  principal: Principal,
): Admission | null {
  const key = principalKey(principal);
  const principalOccupancy = principalWaiters.get(key) ?? 0;
  if (
    principalOccupancy >= MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS ||
    runtimeWaiters >= MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS
  ) {
    return null;
  }
  const admittedPrincipalOccupancy = principalOccupancy + 1;
  runtimeWaiters += 1;
  principalWaiters.set(key, admittedPrincipalOccupancy);
  let released = false;
  return {
    principalOccupancy: admittedPrincipalOccupancy,
    runtimeOccupancy: runtimeWaiters,
    release() {
      if (released) {
        return;
      }
      released = true;
      runtimeWaiters -= 1;
      const remaining = (principalWaiters.get(key) ?? 1) - 1;
      if (remaining === 0) {
        principalWaiters.delete(key);
      } else {
        principalWaiters.set(key, remaining);
      }
    },
  };
}
