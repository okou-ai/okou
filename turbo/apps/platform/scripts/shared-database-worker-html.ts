import type { Plugin } from "vite";

export const SHARED_DATABASE_WORKER_FILE_PATTERN =
  /^assets\/shared-database-worker-[^/]+\.js$/u;

const SHARED_DATABASE_WORKER_META_NAME = "okou-shared-database-worker";

/**
 * SharedWorkers must be same-origin, so the page loads the worker asset from
 * its own origin at the path the app worker proxies to static assets.
 */
export function sharedDatabaseWorkerPath(
  fileName: string,
  base: string,
): string {
  return new URL(fileName, new URL(base, "https://app.invalid/")).pathname;
}

/** Publishes the built worker path for the inline preload in `index.html`. */
export function sharedDatabaseWorkerHtmlPlugin(): Plugin {
  let base = "/";
  return {
    apply: "build",
    name: "platform-shared-database-worker-html",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const workerFiles = Object.keys(context.bundle ?? {}).filter(
          (fileName) => {
            return SHARED_DATABASE_WORKER_FILE_PATTERN.test(fileName);
          },
        );
        const [workerFile] = workerFiles;
        if (workerFiles.length !== 1 || !workerFile) {
          throw new Error(
            `Expected exactly one shared database worker asset, but found ${workerFiles.length}`,
          );
        }
        return [
          {
            tag: "meta",
            attrs: {
              name: SHARED_DATABASE_WORKER_META_NAME,
              content: sharedDatabaseWorkerPath(workerFile, base),
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}
