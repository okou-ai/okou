/**
 * GitHub URL parsing utilities
 *
 * Provides parsing for GitHub tree URLs used in skills and other resources.
 */

export interface ParsedGitHubTreeUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  /** Last segment of path (used for mount directory name) */
  skillName: string;
  /** Full path after github.com/ (unique identifier) */
  fullPath: string;
}

/**
 * Parse a GitHub tree URL into its components
 * Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 *
 * Note: Branch names containing slashes (e.g., feature/foo) may not parse correctly.
 * The fullPath field is always correct and used for unique storage naming.
 *
 * @param url - GitHub tree URL
 * @returns Parsed URL components, or null if URL format is invalid
 */
export function parseGitHubTreeUrl(url: string): ParsedGitHubTreeUrl | null {
  // Normalize: strip trailing slashes for consistent matching
  let normalizedUrl = url;
  while (normalizedUrl.endsWith("/")) {
    normalizedUrl = normalizedUrl.slice(0, -1);
  }

  // First, extract the full path after github.com/ (always correct)
  const fullPathMatch = normalizedUrl.match(/^https:\/\/github\.com\/(.+)$/);
  if (!fullPathMatch) {
    return null;
  }
  const fullPath = fullPathMatch[1]!;

  // Parse components (may be incorrect for branches with slashes)
  const regex =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/;
  const match = normalizedUrl.match(regex);

  if (!match) {
    return null;
  }

  const [, owner, repo, branch, pathPart] = match;
  const resolvedPath = pathPart ?? "";
  const pathSegments = resolvedPath.split("/").filter(Boolean);
  const skillName = pathSegments[pathSegments.length - 1] || repo!;

  return {
    owner: owner!,
    repo: repo!,
    branch: branch!,
    path: resolvedPath,
    skillName,
    fullPath,
  };
}

/**
 * Get skill name from path (last segment)
 */
export function getSkillNameFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] || path;
}

/**
 * Parsed GitHub URL supporting multiple formats
 */
export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Branch name, or null if not specified (use default branch) */
  branch: string | null;
  /** Path within repo, or null if root directory */
  path: string | null;
  /** Full path after github.com/ (unique identifier) */
  fullPath: string;
}

/**
 * Parse any GitHub repository URL into components.
 * Supports multiple URL formats:
 * - https://github.com/owner/repo (plain repo, uses default branch)
 * - https://github.com/owner/repo/tree/branch (root directory with branch)
 * - https://github.com/owner/repo/tree/branch/path (subdirectory)
 *
 * Note: Branch names containing slashes (e.g., feature/foo) may not parse correctly.
 *
 * @param url - GitHub URL
 * @returns Parsed URL components, or null if URL format is invalid
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  // Normalize: strip trailing slashes for consistent matching
  let normalizedUrl = url;
  while (normalizedUrl.endsWith("/")) {
    normalizedUrl = normalizedUrl.slice(0, -1);
  }

  // Extract full path after github.com/
  const fullPathMatch = normalizedUrl.match(/^https:\/\/github\.com\/(.+)$/);
  if (!fullPathMatch) {
    return null;
  }
  const fullPath = fullPathMatch[1]!;

  // Pattern 1: Plain repo URL (https://github.com/owner/repo)
  const plainMatch = normalizedUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/,
  );
  if (plainMatch) {
    return {
      owner: plainMatch[1]!,
      repo: plainMatch[2]!,
      branch: null,
      path: null,
      fullPath,
    };
  }

  // Pattern 2: Tree URL with optional path
  // https://github.com/owner/repo/tree/branch or https://github.com/owner/repo/tree/branch/path
  const treeMatch = normalizedUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/,
  );
  if (treeMatch) {
    return {
      owner: treeMatch[1]!,
      repo: treeMatch[2]!,
      branch: treeMatch[3]!,
      path: treeMatch[4] ?? null,
      fullPath,
    };
  }

  return null;
}

/** Default owner for bare skill name resolution */
export const DEFAULT_SKILLS_OWNER = "okou-ai";
/** Default repository for bare skill name resolution */
export const DEFAULT_SKILLS_REPO = "okou-skills";
/** Default branch for bare skill name resolution */
export const DEFAULT_SKILLS_BRANCH = "main";

/**
 * Resolve a skill reference to a full GitHub tree URL.
 *
 * Supports two formats:
 * - **Bare name** (no `/` and no `https://`): e.g. `"slack"` →
 *   `https://github.com/okou-ai/okou-skills/tree/main/slack`
 * - **Full GitHub URL**: validated by `parseGitHubUrl()` and returned as-is.
 *
 * @param input - Bare skill name or full GitHub URL
 * @returns Canonical full GitHub URL
 * @throws Error if input is empty or not a valid GitHub URL
 */
export function resolveSkillRef(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Skill reference cannot be empty");
  }

  // Bare name: no "/" and no "https://"
  if (!trimmed.includes("/") && !trimmed.startsWith("https://")) {
    return `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${trimmed}`;
  }

  // Full GitHub URL: validate with flexible parser
  const parsed = parseGitHubUrl(trimmed);
  if (!parsed) {
    throw new Error(
      `Invalid skill URL: ${trimmed}. Expected a bare skill name (e.g. "slack") or a GitHub URL (https://github.com/{owner}/{repo}[/tree/{branch}[/path]])`,
    );
  }

  // Plain repo URL (no branch): normalize to tree URL with default branch
  if (!parsed.branch) {
    return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${DEFAULT_SKILLS_BRANCH}`;
  }

  return trimmed;
}
