import { Command } from "commander";

import { runBrowserProxyWorker } from "./browser/proxy/worker";

export const browserProxyCommand = new Command()
  .name("__browser-proxy")
  .description("Internal scoped Browser CDP proxy")
  .action(async () => {
    await runBrowserProxyWorker();
  });
