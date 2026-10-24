declare module "okou:worker-route-manifest" {
  export const WORKER_ROUTE_MANIFEST: readonly {
    readonly method: string;
    readonly path: string;
    readonly domain: "core" | "execution" | "integrations" | "data";
  }[];
}
