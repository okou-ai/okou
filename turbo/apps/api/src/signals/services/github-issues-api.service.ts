const GITHUB_API_BASE = "https://api.github.com";

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...GITHUB_HEADERS,
  };
}

export async function postGithubIssueComment(
  args: {
    readonly token: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly body: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${args.repo}/issues/${args.issueNumber}/comments`,
    {
      method: "POST",
      headers: authHeaders(args.token),
      body: JSON.stringify({ body: args.body }),
      signal,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to post GitHub comment: ${response.status} ${body}`,
    );
  }

  const data = (await response.json()) as { readonly id: number };
  return String(data.id);
}
