import indexHtml from "../../index.html?raw";

const APP_BOOTSTRAP_SKELETON_ID = "app-bootstrap-skeleton";

function readDeployedElement(id: string): HTMLElement {
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const element = page.getElementById(id);
  if (!element) {
    throw new Error(`index.html is missing #${id}`);
  }
  return element;
}

const skeleton = readDeployedElement(APP_BOOTSTRAP_SKELETON_ID);
const root = readDeployedElement("root");

/** Preserve the deployed root's startup interaction boundary in page tests. */
export function createBootstrapRoot(): HTMLElement {
  return document.importNode(root, true);
}

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
