import { command, computed, state } from "ccstate";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";

const builtinVersion$ = state(0);
const customVersion$ = state(0);

export const builtinConnectorAccountProjectionVersion$ = computed((get) => {
  return get(builtinVersion$);
});

export const customConnectorAccountProjectionVersion$ = computed((get) => {
  return get(customVersion$);
});

/** Account mutations invalidate only the matching visible catalog projection. */
export const invalidateConnectorAccountProjection$ = command(
  ({ set }, target: ConnectorAccountTarget) => {
    set(
      target.kind === "builtin" ? builtinVersion$ : customVersion$,
      (version) => {
        return version + 1;
      },
    );
  },
);
