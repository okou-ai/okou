import type { Root } from "hast";
import { SKIP, visit } from "unist-util-visit";
import { email } from "zod";

const emailAddressSchema = email();

export function emailQuoteAddress(href: string | undefined): string | null {
  if (!href?.toLowerCase().startsWith("mailto:")) {
    return null;
  }
  // Quote a single address, not a mailto compose template or recipient list.
  const address = href.slice("mailto:".length);
  const parsed = emailAddressSchema.safeParse(address);
  return parsed.success ? parsed.data : null;
}

declare module "hast" {
  interface Data {
    emailQuoteAddress?: string;
  }
}

export function markEmailQuoteAddresses(tree: Root): void {
  visit(tree, "element", (node) => {
    if (["pre", "code", "blockquote"].includes(node.tagName)) {
      return SKIP;
    }
    if (node.tagName !== "a") {
      return undefined;
    }
    const href = node.properties.href;
    const address = emailQuoteAddress(
      typeof href === "string" ? href : undefined,
    );
    if (address !== null) {
      node.data ??= {};
      node.data.emailQuoteAddress = address;
    }
    return undefined;
  });
}
