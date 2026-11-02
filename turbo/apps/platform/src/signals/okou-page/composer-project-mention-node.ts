import { inlineReferenceVariants } from "@okouai/ui";
import { Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { PROJECT_MENTION_NODE_NAME } from "./user-message-document-codec.ts";
import { projectMentionSchema } from "@okouai/api-contracts/validators/project-message";
export function projectMentionText(node: ProseMirrorNode) {
  const p = projectMentionSchema.parse({
    type: "project",
    projectId: node.attrs.projectId,
    nameSnapshot: node.attrs.name,
  });
  return `[${p.nameSnapshot.replace(/[\\[\]]/g, String.raw`\$&`)}](/projects/${p.projectId})`;
}
export function createProjectMentionNode() {
  return Node.create({
    name: PROJECT_MENTION_NODE_NAME,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
      return { projectId: { default: "" }, name: { default: "" } };
    },
    parseHTML() {
      return [
        {
          tag: "span[data-project-mention]",
          getAttrs(element) {
            return {
              projectId: element.dataset.projectMention,
              name: element.dataset.projectName,
            };
          },
        },
      ];
    },
    renderHTML({ node }) {
      return [
        "span",
        {
          "data-project-mention": node.attrs.projectId,
          "data-project-name": node.attrs.name,
          class: inlineReferenceVariants({
            selectable: true,
            className: "max-w-full select-none whitespace-nowrap",
          }),
        },
        node.attrs.name,
      ];
    },
    renderText({ node }) {
      return projectMentionText(node);
    },
  });
}
