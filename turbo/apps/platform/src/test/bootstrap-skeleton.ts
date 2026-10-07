import indexHtml from "../../index.html?raw";

const APP_BOOTSTRAP_SKELETON_ID = "app-bootstrap-skeleton";

function readDeployedSkeleton(): HTMLElement {
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const element = page.getElementById(APP_BOOTSTRAP_SKELETON_ID);
  if (!element) {
    throw new Error("index.html is missing the bootstrap skeleton");
  }
  return element;
}

const skeleton = readDeployedSkeleton();

/** Mounts the deployed first-paint skeleton, with document disposal owned by the test. */
export function installBootstrapSkeleton(signal: AbortSignal): void {
  signal.throwIfAborted();
  const element = document.importNode(skeleton, true);
  document.body.appendChild(element);
  signal.addEventListener(
    "abort",
    () => {
      element.remove();
    },
    { once: true },
  );
}

export function queryBootstrapSkeleton(): HTMLElement | null {
  return document.getElementById(APP_BOOTSTRAP_SKELETON_ID);
}

export function bootstrapSkeleton(): HTMLElement {
  const element = queryBootstrapSkeleton();
  if (!element) {
    throw new Error("The bootstrap skeleton is not mounted");
  }
  return element;
}
