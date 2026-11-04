/** The Pi route classes `run_model_catalog.pi_route_class` may hold. */
export const PI_ROUTE_CLASSES = ["gpt-codex"] as const;

export type PiRouteClass = (typeof PI_ROUTE_CLASSES)[number];

export function isPiRouteClass(value: unknown): value is PiRouteClass {
  return PI_ROUTE_CLASSES.some((routeClass) => {
    return routeClass === value;
  });
}
