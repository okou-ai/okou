// Worker project only: index.ts exports exact types without index.d.ts's
// ambient browser globals. Keep this declaration out of Node projects.
declare module "cloudflare:workers" {
  import { CloudflareWorkersModule } from "@cloudflare/workers-types";
  export = CloudflareWorkersModule;
}
