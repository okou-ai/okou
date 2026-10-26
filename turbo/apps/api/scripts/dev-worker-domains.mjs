import { spawn } from "node:child_process";
import process from "node:process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { apiRoot } from "./worker-build-options.mjs";
import { serializeWorkerDevVars } from "./worker-dev-env.mjs";

function createProcessOwner() {
  let active;
  let stopped = false;
  const stop = (signal) => {
    const childSignal = stopped ? "SIGKILL" : signal;
    stopped = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    if (!active?.pid) {
      return;
    }
    if (process.platform === "win32") {
      active.kill(childSignal);
    } else {
      // Include Wrangler's build shell and workerd children. A second Ctrl-C
      // terminates the entire group if graceful shutdown has stalled.
      try {
        process.kill(-active.pid, childSignal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  };
  const interrupt = () => {
    return stop("SIGINT");
  };
  const terminate = () => {
    return stop("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  function run(command, args) {
    if (stopped) {
      return Promise.resolve(false);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: apiRoot,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      active = child;
      child.once("error", reject);
      child.once("close", (code, signal) => {
        active = undefined;
        if (
          signal === "SIGINT" ||
          signal === "SIGTERM" ||
          code === 130 ||
          code === 143
        ) {
          stopped = true;
          process.exitCode = signal === "SIGINT" || code === 130 ? 130 : 143;
        }
        if (stopped) {
          resolve(false);
        } else if (code === 0) {
          resolve(true);
        } else {
          reject(
            new Error(
              `Worker development subprocess exited with ${code ?? signal}`,
            ),
          );
        }
      });
    });
  }

  return {
    run,
    stopped: () => {
      return stopped;
    },
    dispose: () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    },
  };
}

async function developWorkers() {
  const require = createRequire(import.meta.url);
  const apiEnv = parseEnv(
    await readFile(resolve(apiRoot, ".env.local"), "utf8"),
  );
  if (apiEnv.ENV !== "development") {
    throw new Error(
      "Worker development requires ENV=development in API .env.local",
    );
  }
  if (!apiEnv.DATABASE_URL) {
    throw new Error("API .env.local requires the development DATABASE_URL");
  }
  const domain = process.argv[2];
  if (!["core", "execution", "integrations", "data"].includes(domain)) {
    throw new Error("Choose a domain: core, execution, integrations, or data");
  }
  const workers = [domain];
  const runtimeRoot = resolve(apiRoot, ".wrangler");
  await mkdir(runtimeRoot, { recursive: true });
  const directory = await mkdtemp(resolve(runtimeRoot, "domain-dev-"));
  const owner = createProcessOwner();

  try {
    if (
      !(await owner.run(process.execPath, [
        resolve(apiRoot, "scripts/build-worker-domains.mjs"),
      ]))
    ) {
      return;
    }
    const configs = [];
    for (const name of workers) {
      if (owner.stopped()) {
        return;
      }
      const folder = resolve(directory, name);
      await mkdir(folder, { mode: 0o700 });
      const config = JSON.parse(
        await readFile(
          resolve(apiRoot, `dist-worker-domains/${name}/wrangler.json`),
          "utf8",
        ),
      );
      config.main = resolve(apiRoot, `dist-worker-domains/${name}/worker.js`);
      if (config.hyperdrive) {
        config.hyperdrive[0].localConnectionString = apiEnv.DATABASE_URL;
        // Wrangler treats .dev.vars as secrets and hides them from binding logs.
        await writeFile(
          resolve(folder, ".dev.vars"),
          serializeWorkerDevVars(apiEnv),
          { mode: 0o600 },
        );
      }
      config.build = {
        command: "node scripts/build-worker-domains.mjs",
        cwd: apiRoot,
        watch_dir: [
          resolve(apiRoot, "src"),
          resolve(apiRoot, "scripts"),
          resolve(apiRoot, "../../packages"),
        ],
      };
      const path = resolve(folder, "wrangler.json");
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      });
      configs.push("-c", path);
    }
    // run() checks the stop state again so cancellation between preparation and
    // spawn cannot start a new long-lived process.
    await owner.run(process.execPath, [
      resolve(dirname(require.resolve("wrangler")), "../bin/wrangler.js"),
      "dev",
      ...configs,
      "--local",
      "--port",
      "3001",
    ]);
  } finally {
    owner.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv.includes("--help")) {
  process.stdout.write(
    "Usage: pnpm dev:worker-domains <core|execution|integrations|data>\nRuns the selected domain directly at http://localhost:3001, using API .env.local and its local PostgreSQL URL. Watches API/shared-package sources. No Cloudflare deployment.\n",
  );
} else {
  await developWorkers();
}
