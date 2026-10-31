import { command } from "ccstate";

// Only for roles whose bundle cannot reach completion dispatch or internal callbacks.
// The Worker build checks that reachability before accepting this initializer.
export const initializeNoServices$ = command((): void => {});
