import type { githubInstallations } from "@okouai/db/schema/github-installation";

import { optionalEnv } from "../../lib/env";
import { getGithubInstallationAccessToken } from "./github-app.service";

type ActiveGithubInstallation = typeof githubInstallations.$inferSelect;

export async function getGithubIntegrationAccessToken(
  args: {
    readonly installation: ActiveGithubInstallation;
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (!args.installation.installationId) {
    return null;
  }

  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials are not configured");
  }

  const { token } = await getGithubInstallationAccessToken(
    {
      appId,
      privateKey,
      installationId: args.installation.installationId,
    },
    signal,
  );
  return token;
}
