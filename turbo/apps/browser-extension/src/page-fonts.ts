// Browser Use's native font preferences can disagree with its rendered font
// inventory. Keep the page's choices first and supply an installed last choice.
const supplementalFamily = '"Arial Unicode MS"';
const supplementalPattern = /(?:^|,)\s*["']?Arial Unicode MS["']?\s*(?:,|$)/i;
// Letters, rather than whole Unicode blocks, leave icon PUA and emoji alone.
const nonLatinLetter = /(?=\p{Letter})\P{Script_Extensions=Latin}/u;
const stylesheetSelector = 'style, link[rel~="stylesheet"]';
const overrides = new WeakMap<
  HTMLElement,
  {
    original: string;
    priority: string;
    applied: string;
    appliedPriority: string;
  }
>();
const observed = new WeakSet<Node>();
const pending = new Map<Node, boolean>();
const previousStyle = document.createElement("span").style;
let scheduled = false;

function ownsFont(element: HTMLElement): boolean {
  const owned = overrides.get(element);
  return (
    owned !== undefined &&
    element.style.getPropertyValue("font-family") === owned.applied &&
    element.style.getPropertyPriority("font-family") === owned.appliedPriority
  );
}

function inlineFontChanged(
  element: HTMLElement,
  before: string | null,
): boolean {
  previousStyle.cssText = before ?? "";
  // A custom property can change inherited typography even while our own
  // font-family declaration is unchanged. Do not mistake it for our write.
  const variableChanged = [
    ...Array.from(previousStyle),
    ...Array.from(element.style),
  ].some((property) => {
    return (
      property.startsWith("--") &&
      (previousStyle.getPropertyValue(property) !==
        element.style.getPropertyValue(property) ||
        previousStyle.getPropertyPriority(property) !==
          element.style.getPropertyPriority(property))
    );
  });
  if (variableChanged) return true;
  if (ownsFont(element)) return false;
  // System shorthands such as `font: caption` expose an empty fontFamily.
  return (
    previousStyle.fontFamily !== element.style.fontFamily ||
    previousStyle.getPropertyPriority("font-family") !==
      element.style.getPropertyPriority("font-family") ||
    (previousStyle.fontFamily === "" &&
      previousStyle.font !== element.style.font)
  );
}

function needsFont(element: HTMLElement): boolean {
  if (element.matches("script, style, noscript")) return false;
  // Do not inspect control values, including passwords. Their existing faces
  // still render Latin text; the tail is available when the user enters a script.
  if (element instanceof HTMLInputElement) {
    return ![
      "hidden",
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "image",
      "password",
    ].includes(element.type);
  }
  if (element.matches("textarea, select")) return true;
  return Array.from(element.childNodes).some((node) => {
    return node instanceof Text && nonLatinLetter.test(node.data);
  });
}

function enqueue(node: Node, subtree: boolean): void {
  pending.set(node, subtree || pending.get(node) === true);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(flush);
}

const observer = new MutationObserver((records) => {
  for (const record of records) {
    const element =
      record.target instanceof Element
        ? record.target
        : record.target.parentElement;
    const stylesheetChange =
      element?.closest("style") ||
      element?.matches(stylesheetSelector) ||
      (record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].some((node) => {
          return (
            node instanceof Element &&
            (node.matches(stylesheetSelector) ||
              node.querySelector(stylesheetSelector) !== null)
          );
        }));
    if (stylesheetChange) {
      enqueue(document, true);
      continue;
    }
    if (record.type === "attributes") {
      if (
        record.attributeName === "style" &&
        record.target instanceof HTMLElement
      ) {
        // Transforms/opacity often change every animation frame. They do not
        // invalidate font inheritance or require walking their descendants.
        if (!inlineFontChanged(record.target, record.oldValue)) continue;
      }
      enqueue(record.target, true);
    } else if (record.type === "characterData") {
      if (element) enqueue(element, false);
    } else {
      enqueue(record.target, false);
      for (const node of record.addedNodes) enqueue(node, true);
    }
  }
});

function observe(root: Document | ShadowRoot): void {
  if (observed.has(root)) return;
  observed.add(root);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
  });
}

function collect(
  node: Node,
  subtree: boolean,
  elements: Set<HTMLElement>,
): void {
  if (!node.isConnected) return;
  function add(candidate: Node): void {
    if (!(candidate instanceof HTMLElement)) return;
    elements.add(candidate);
    if (candidate.shadowRoot) {
      observe(candidate.shadowRoot);
      collect(candidate.shadowRoot, true, elements);
    }
  }
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement) add(node.parentElement);
    return;
  }
  add(node);
  if (!subtree) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
  for (let child = walker.nextNode(); child; child = walker.nextNode())
    add(child);
}

function flush(): void {
  scheduled = false;
  const elements = new Set<HTMLElement>();
  for (const [node, subtree] of pending) collect(node, subtree, elements);
  pending.clear();

  // Release our declarations before reading the cascade, including inherited
  // changes. A site's newer inline declaration belongs to the site, not to us.
  for (const element of elements) {
    const owned = overrides.get(element);
    if (!owned) continue;
    if (ownsFont(element)) {
      if (owned.original) {
        element.style.setProperty(
          "font-family",
          owned.original,
          owned.priority,
        );
      } else element.style.removeProperty("font-family");
    }
    overrides.delete(element);
  }

  // Separate reads from writes to avoid recascading after each element.
  const additions = [];
  for (const element of elements) {
    if (!needsFont(element)) continue;
    // Pending/system inline shorthands can own font-family while exposing no
    // serializable value. Overwriting it would make restoration destructive.
    if (
      element.style.fontFamily === "" &&
      Array.from(element.style).includes("font-family")
    )
      continue;
    const family = getComputedStyle(element).fontFamily;
    if (supplementalPattern.test(family)) continue;
    additions.push({
      element,
      family,
      original: element.style.getPropertyValue("font-family"),
      priority: element.style.getPropertyPriority("font-family"),
    });
  }
  for (const { element, family, original, priority } of additions) {
    element.style.setProperty(
      "font-family",
      `${family}, ${supplementalFamily}`,
      priority,
    );
    overrides.set(element, {
      original,
      priority,
      applied: element.style.getPropertyValue("font-family"),
      appliedPriority: priority,
    });
  }
  // A site's !important font still stays at the front; only the tail needs the
  // same cascade strength. All other font properties remain site-owned.
  const important = additions.filter(({ element }) => {
    return !supplementalPattern.test(getComputedStyle(element).fontFamily);
  });
  for (const { element } of important) {
    const owned = overrides.get(element);
    if (!owned) continue;
    element.style.setProperty("font-family", owned.applied, "important");
    owned.appliedPriority = "important";
  }
}

observe(document);
enqueue(document, true);
document.addEventListener(
  "load",
  (event) => {
    if (
      event.target instanceof HTMLLinkElement &&
      event.target.relList.contains("stylesheet")
    ) {
      enqueue(document, true);
    }
  },
  true,
);
addEventListener("resize", () => {
  enqueue(document, true);
});
