import { Hono } from "hono";
import { WORKER_ROUTE_MANIFEST } from "okou:worker-route-manifest";

interface ApiService {
  fetch(request: Request): Promise<Response>;
}

interface Bindings {
  readonly CORE: ApiService;
  readonly EXECUTION: ApiService;
  readonly INTEGRATIONS: ApiService;
  readonly DATA: ApiService;
}

const services = {
  core: "CORE",
  execution: "EXECUTION",
  integrations: "INTEGRATIONS",
  data: "DATA",
} as const;

const app = new Hono<{ Bindings: Bindings }>();

// Preserve the original Hono method/path precedence without importing schemas
// or handlers. The build derives this table from the same route registrations.
for (const route of WORKER_ROUTE_MANIFEST) {
  app.on(route.method, route.path, (context) => {
    return context.env[services[route.domain]].fetch(context.req.raw);
  });
}

// Core owns the common preflight, auth redirects, and unknown-route response.
// Forward the original request and response without buffering bodies or streams.
app.all("*", (context) => {
  return context.env.CORE.fetch(context.req.raw);
});

export default app;
