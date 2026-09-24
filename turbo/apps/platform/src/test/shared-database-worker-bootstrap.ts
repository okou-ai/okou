import indexHtml from "../../index.html?raw";

const page = new DOMParser().parseFromString(indexHtml, "text/html");
const source = page.querySelector(
  "[data-okou-shared-database-worker-bootstrap]",
)?.textContent;
if (!source) {
  throw new Error("index.html is missing the shared worker bootstrap");
}
const runBootstrap = new Function(source) as () => void;

/** Runs the deployed HTML script, with document disposal owned by the test. */
export function installSharedDatabaseWorkerBootstrap(
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  // Tests may replace the global window; clean up the one that was installed.
  const platformWindow = window;
  runBootstrap();
  signal.addEventListener(
    "abort",
    () => {
      delete platformWindow.__okouSharedDatabaseWorkerBootstrap;
    },
    { once: true },
  );
}
