import { singleton } from "../../lib/singleton";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

export const MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS = 2;
export const MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS = 32;

interface Admission {
  readonly admitted: true;
  readonly principalOccupancy: number;
  readonly runtimeOccupancy: number;
  readonly release: () => void;
}

interface RejectedAdmission {
  readonly admitted: false;
  readonly principalOccupancy: number;
  readonly runtimeOccupancy: number;
}

interface WaiterState {
  readonly principalWaiters: Map<string, number>;
  runtimeWaiters: number;
}

const waiterState = singleton((): WaiterState => {
  return { principalWaiters: new Map(), runtimeWaiters: 0 };
});

function principalKey(principal: Principal): string {
  return `${principal.orgId}\0${principal.userId}`;
}

/** Admit finite request-owned waits without logging principal identifiers. */
export function admitMcpChatStatusWaiter(
  principal: Principal,
): Admission | RejectedAdmission {
  const state = waiterState();
  const key = principalKey(principal);
  const principalOccupancy = state.principalWaiters.get(key) ?? 0;
  if (
    principalOccupancy >= MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS ||
    state.runtimeWaiters >= MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS
  ) {
    return {
      admitted: false,
      principalOccupancy,
      runtimeOccupancy: state.runtimeWaiters,
    };
  }
  const admittedPrincipalOccupancy = principalOccupancy + 1;
  state.runtimeWaiters += 1;
  state.principalWaiters.set(key, admittedPrincipalOccupancy);
  let released = false;
  return {
    admitted: true,
    principalOccupancy: admittedPrincipalOccupancy,
    runtimeOccupancy: state.runtimeWaiters,
    release() {
      if (released) {
        return;
      }
      released = true;
      state.runtimeWaiters -= 1;
      const remaining = (state.principalWaiters.get(key) ?? 1) - 1;
      if (remaining === 0) {
        state.principalWaiters.delete(key);
      } else {
        state.principalWaiters.set(key, remaining);
      }
    },
  };
}
