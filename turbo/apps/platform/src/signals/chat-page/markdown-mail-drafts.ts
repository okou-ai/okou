import { command } from "ccstate";
import type { Root } from "hast";
import { SKIP, visit } from "unist-util-visit";

import {
  parseMailDraftUrl,
  type MailDraftCardSignalsRegistry,
} from "./mail-draft.ts";

/** Keep inline mail links in place while sharing the cards' draft resources. */
export const embedMarkdownMailDrafts$ = command(
  ({ set }, tree: Root, registry: MailDraftCardSignalsRegistry) => {
    visit(tree, "element", (node) => {
      if (node.data?.card) {
        return SKIP;
      }
      if (node.tagName !== "a" || typeof node.properties.href !== "string") {
        return undefined;
      }
      const descriptor = parseMailDraftUrl(node.properties.href);
      if (descriptor) {
        node.data = {
          ...node.data,
          card: {
            kind: "mail-draft",
            signals: set(registry.register$, descriptor),
          },
        };
      }
      return undefined;
    });
  },
);
