/**
 * Rehype plugin that replaces ```mermaid fenced code blocks with an empty
 * placeholder `div` whose Mermaid source rides on the node's `data`.
 *
 * It runs last in the shared Markdown pipeline, after raw HTML and attributes
 * have settled, so it can recognize the final fenced-code node without a view
 * component needing to inspect Markdown source.
 *
 * The placeholder must use a plain HTML tag name: react-markdown drops
 * elements whose tag name does not match `/^[A-Za-z0-9]+$/`.
 */

interface HastNode {
  data?: { mermaid?: { code: string } };
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Record<string, unknown>;
  children?: HastNode[];
}

export const MARKDOWN_MERMAID_FENCE_ATTRIBUTE =
  "data-okou-markdown-mermaid-fence";

const MARKDOWN_MERMAID_FENCE_PROPERTY = "dataOkouMarkdownMermaidFence";

interface TextTreeNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly TextTreeNode[];
}

export function collectText(node: TextTreeNode): string {
  if (node.type === "text") {
    return node.value ?? "";
  }
  return (node.children ?? []).map(collectText).join("");
}

function classNames(node: HastNode): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === "string";
    });
  }
  if (typeof value === "string") {
    return value.split(" ");
  }
  return [];
}

function mermaidCodeElement(node: HastNode): HastNode | undefined {
  if (node.type !== "element" || node.tagName !== "pre") {
    return undefined;
  }
  const code = (node.children ?? []).find((child) => {
    return child.type === "element" && child.tagName === "code";
  });
  if (!code || !classNames(code).includes("language-mermaid")) {
    return undefined;
  }
  return code;
}

/**
 * The diagram itself is a React component, so the tree only needs to say
 * "a diagram goes here". The payload rides on `data`, which `rehype-raw` cannot
 * produce — a message quoting the placeholder's markup therefore stays a plain
 * div instead of being swallowed by the renderer.
 */
function mermaidBlockNode(code: string): HastNode {
  return {
    type: "element",
    tagName: "div",
    properties: {},
    data: { mermaid: { code } },
    children: [],
  };
}

/**
 * Marked tags Markdown-origin fences before their HTML is parsed into hast.
 * A missing tag means this is already-complete raw HTML, which retains the
 * historical behavior of rendering a Mermaid `<pre><code>` as a diagram.
 */
function takeMarkdownFenceState(node: HastNode): "closed" | "open" | undefined {
  const properties = node.properties;
  if (!properties) {
    return undefined;
  }
  const state = properties[MARKDOWN_MERMAID_FENCE_PROPERTY];
  delete properties[MARKDOWN_MERMAID_FENCE_PROPERTY];
  if (state === "closed" || state === "open") {
    return state;
  }
  return undefined;
}

function replaceMermaidBlocks(node: HastNode): void {
  const children = node.children;
  if (!children) {
    return;
  }
  for (const [index, child] of children.entries()) {
    const code = mermaidCodeElement(child);
    if (code) {
      const markdownFenceState = takeMarkdownFenceState(child);
      if (markdownFenceState !== "open") {
        children[index] = mermaidBlockNode(
          collectText(code).replace(/\n$/, ""),
        );
      }
      continue;
    }
    replaceMermaidBlocks(child);
  }
}

export function rehypeMermaid() {
  return (tree: HastNode): void => {
    replaceMermaidBlocks(tree);
  };
}
