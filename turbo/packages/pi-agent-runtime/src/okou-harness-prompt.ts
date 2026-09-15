/**
 * Okou Harness base system prompt for the Pi loop.
 *
 * The official base prompt names its own harness and links its own
 * documentation tree, neither of which describes the runtime Okou presents to
 * users. The loop replaces that base through the official resource loader's
 * `systemPrompt` input instead of appending to it, so the official builder
 * still contributes the append blocks, project context, skills, and the
 * working-directory line around this text.
 *
 * The tool sections are derived from the session's own active tool
 * definitions rather than restated here, so a tool whose snippet or guidelines
 * change upstream cannot silently drift out of the prompt.
 */

/** One active tool's contribution to the base prompt's tool sections. */
export interface OkouHarnessToolPrompt {
  readonly name: string;
  readonly snippet?: string | undefined;
  readonly guidelines?: readonly string[] | undefined;
}

const OKOU_HARNESS_IDENTITY = `You are an agent running on Okou Harness, Okou's agent runtime. You act on the user's behalf by reading and writing files, running commands, calling the Okou CLI and connected services, and producing finished, verifiable deliverables.

Your work is not limited to software engineering. Depending on the task you may do research, analysis, marketing and content work, data and reporting, media generation, or operational work, as well as writing and editing code. Take each task on its own terms rather than assuming it is a coding task.

Refer to your runtime as Okou Harness. Implementation details you may observe in the sandbox, such as package names, file paths, and environment variables, are not your identity; do not present them as such.`;

const CUSTOM_TOOL_NOTE =
  "In addition to the tools above, you may have access to other custom tools depending on the project.";

/**
 * Retained from the official guidelines because the loop activates no
 * dedicated search or listing tool, so the shell is the only way to run them.
 */
const SHELL_FILE_OPERATION_GUIDELINE =
  "Use bash for file operations like ls, rg, find";

const FILE_PATH_GUIDELINE = "Show file paths clearly when working with files";

/** Tools whose presence would make the shell file-operation guideline wrong. */
const FILE_SEARCH_TOOL_NAMES = ["grep", "find", "ls"];

function toolsSection(tools: readonly OkouHarnessToolPrompt[]): string {
  const entries = tools
    .filter((tool) => {
      return tool.snippet !== undefined && tool.snippet.length > 0;
    })
    .map((tool) => {
      return `- ${tool.name}: ${tool.snippet}`;
    });
  return `Available tools:\n${entries.length > 0 ? entries.join("\n") : "(none)"}`;
}

function guidelinesSection(tools: readonly OkouHarnessToolPrompt[]): string {
  const activeNames = new Set(
    tools.map((tool) => {
      return tool.name;
    }),
  );
  const collected: string[] = [];
  const seen = new Set<string>();
  const add = (guideline: string): void => {
    const normalized = guideline.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    collected.push(normalized);
  };

  if (
    activeNames.has("bash") &&
    !FILE_SEARCH_TOOL_NAMES.some((name) => {
      return activeNames.has(name);
    })
  ) {
    add(SHELL_FILE_OPERATION_GUIDELINE);
  }
  for (const tool of tools) {
    for (const guideline of tool.guidelines ?? []) {
      add(guideline);
    }
  }
  add(FILE_PATH_GUIDELINE);

  return `Guidelines:\n${collected
    .map((guideline) => {
      return `- ${guideline}`;
    })
    .join("\n")}`;
}

/**
 * Build the Okou Harness base prompt for one session's active tools.
 *
 * Callers pass the tools in the order the session activates them so the
 * rendered sections match the session's own tool ordering.
 */
export function buildOkouHarnessSystemPrompt(
  tools: readonly OkouHarnessToolPrompt[],
): string {
  return [
    OKOU_HARNESS_IDENTITY,
    toolsSection(tools),
    CUSTOM_TOOL_NOTE,
    guidelinesSection(tools),
  ].join("\n\n");
}
