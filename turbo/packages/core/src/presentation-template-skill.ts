import {
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID,
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH,
} from "./presentation-reverse-template-resource";

const PRESENTATION_TEMPLATE_RESOURCE_DIR = "./generated/resources";

/**
 * Tell a run how to reach one authoritative guide.
 *
 * This concise instruction rides in the standing agent-tools prompt so any
 * deck reaches these instructions — dropped in the chat box, picked through
 * the import dialog, or asked for in words — without a user-visible message
 * having to spell the pull out.
 */
export function presentationTemplateSkillInstruction(): string {
  const skillPath = `${PRESENTATION_TEMPLATE_RESOURCE_DIR}/${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH}/SKILL.md`;
  return [
    `Turning an uploaded deck (.pptx, .ppt, or .pdf) into a reusable presentation template normally follows the ${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH} guide, which is not mounted as a skill.`,
    `When the user designates an exact 40-hex commit under \`https://github.com/maxandzoe/Template-artifact/tree/<commit>/${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH}\` as authoritative, read that pinned official guide and its referenced assets directly; do not pull or compare the registry copy.`,
    `Otherwise, pull the guide first with \`okou resource pull ${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID} --dir ${PRESENTATION_TEMPLATE_RESOURCE_DIR}\`, read \`${skillPath}\`, and follow it exactly, including its page-rendering and publish steps.`,
  ].join(" ");
}
