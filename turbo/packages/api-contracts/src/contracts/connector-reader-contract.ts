import type { AppRoute } from "./trpc-contract";

// Recompute the reader's response types instead of intersecting them with
// the serving route's phantom types. Runtime request/route properties survive.
// #41699 removes these client-only views with the retired server fields.
export function connectorReaderRouteSpec<T extends AppRoute>(
  route: T,
): Omit<T, "__types"> {
  const { __types: _types, ...spec } = route;
  return spec;
}
