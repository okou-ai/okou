import type { SkillImportLimits } from "@okouai/api-contracts/contracts/skill-import";

/**
 * The prompt a user pastes into their own Codex or Claude Code session so that
 * agent can copy the user's local skills into Okou.
 *
 * The browser cannot read a skill directory, so the import runs where the
 * skills already are. The prompt carries the session token and states the same
 * limits the upload route enforces, so the agent can prepare a request that
 * will be accepted instead of discovering each limit through a failure.
 */
export interface SkillImportPromptInput {
  readonly uploadUrl: string;
  readonly token: string;
  readonly limits: SkillImportLimits;
}

/**
 * Extensions the agent may attach. Text-only v1: anything outside this list is
 * skipped rather than guessed at.
 */
const TEXT_FILE_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".tsv",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".php",
  ".html",
  ".css",
  ".scss",
  ".xml",
] as const;

/** Never upload anything matching these, whatever its extension. */
const SECRET_FILE_PATTERNS = [
  ".env",
  ".env.*",
  ".npmrc",
  ".netrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  "*credential*",
  "*secret*",
  "*token*",
  "*password*",
] as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${String(bytes / (1024 * 1024))} MB (${String(bytes)} bytes)`;
  }
  return `${String(bytes / 1024)} KB (${String(bytes)} bytes)`;
}

function quotedList(values: readonly string[]): string {
  return values
    .map((value) => {
      return `\`${value}\``;
    })
    .join(", ");
}

export function buildSkillImportPrompt(input: SkillImportPromptInput): string {
  const { limits } = input;

  return `Import my local skills into Okou.

Do this yourself, in this session, using the shell and file tools you already
have. Everything below is scoped to a single import session that expires; if it
expires, stop and ask me for a fresh link.

## 1. Find the skills

Look for a \`SKILL.md\` in each immediate subdirectory of:

- \`~/.claude/skills/*/SKILL.md\`
- \`~/.codex/skills/*/SKILL.md\`
- \`.claude/skills/*/SKILL.md\` in the current project

Skip a directory that has no \`SKILL.md\`. If the same skill name appears in
more than one location, import the project copy first and treat the others as
duplicates.

## 2. Read each skill

- The YAML frontmatter at the top of \`SKILL.md\` gives \`name\` and
  \`description\`. If \`name\` is missing, use the directory name.
- Everything after the frontmatter is the \`instruction\`. Send it unchanged;
  do not summarize, translate, or reformat it.
- Never upload \`SKILL.md\` itself as a file. Okou regenerates it from the
  name, description, and instruction.

## 3. Choose the files to attach

Attach the skill directory's other files, with paths relative to the skill
directory and no \`..\` segments. Include a file only when all of these hold:

- Its extension is one of ${quotedList(TEXT_FILE_EXTENSIONS)}.
- Its content contains no NUL byte (\`grep -qI\` or an equivalent check); a
  file that fails this check is binary and is skipped in this version.
- It is not a credential. Skip anything matching ${quotedList(
    SECRET_FILE_PATTERNS,
  )}, and skip any file whose content contains a private key block, an API key,
  or an access token. When unsure, skip the file and report it.

Never include this session's token, any environment variable value, or any
other credential in an instruction or file you upload.

## 4. Upload one skill per request

\`\`\`bash
curl -sS -X POST '${input.uploadUrl}' \\
  -H 'Authorization: Bearer ${input.token}' \\
  -H 'Content-Type: application/json' \\
  -w '\\n%{http_code}\\n' \\
  --data-binary @payload.json
\`\`\`

\`payload.json\` holds exactly one skill:

\`\`\`json
{
  "name": "my-skill",
  "displayName": "My Skill",
  "description": "What the skill is for",
  "instruction": "The SKILL.md body",
  "files": [{ "path": "reference.md", "content": "..." }]
}
\`\`\`

\`displayName\`, \`description\`, and \`files\` are optional. Build the JSON with
a tool (\`jq\`, Python, Node) rather than by hand so the content is escaped
correctly.

## 5. Stay inside the limits

- At most ${String(limits.maxSkillsPerSession)} skills in this session.
- \`name\`: Okou normalizes it to a slug, so \`My Skill\` arrives as
  \`my-skill\`.
- \`displayName\`: at most 256 characters. \`description\`: at most 1024
  characters. Trim a longer value rather than sending it.
- \`instruction\`: at most ${formatBytes(limits.maxInstructionBytes)}.
- \`files\`: at most ${String(limits.maxFilesPerSkill)} files, each at most
  ${formatBytes(limits.maxFileBytes)}, ${formatBytes(
    limits.maxTotalFileBytes,
  )} in total.
- The whole request body: at most ${formatBytes(limits.maxRequestBytes)}.

Drop the largest attachments before sending anything that would exceed a limit.

## 6. Handle the response

- \`201\`: imported. Continue with the next skill.
- \`200\`: a skill with that name is already there. Count it as skipped and
  continue; do not retry or rename it.
- \`409\`: the name is taken by something else. Retry that skill once with
  \`-imported\` appended to the name. If it fails again, count it as failed.
- \`413\`: too large. Retry that skill once without \`files\`. If it fails
  again, count it as failed.
- \`429\`: the session limit is reached. Stop, and report the remaining skills
  as not imported.
- \`401\`: the session has expired or is invalid. Stop immediately, do not
  retry, and ask me for a fresh import link.
- \`400\` or any other status: count that skill as failed, report the message,
  and continue with the next skill.

## 7. Report

When you are done, print one summary listing imported, skipped, and failed
skills by name, with the reason for each skipped or failed skill.
`;
}
