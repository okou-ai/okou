function normalizedProviderValue(
  value: string | null | undefined,
): string | undefined {
  return value?.trim() || undefined;
}

export function githubAppBotUsername(appSlug: string): string {
  return `@${appSlug}[bot]`;
}

export function githubAppUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}`;
}

export function resolveGithubAppIdentity(args: {
  readonly configuredAppId: string | undefined;
  readonly configuredAppSlug: string | undefined;
  readonly installationAppId: string | null;
  readonly installationAppSlug: string | null;
}): {
  readonly appId: string | undefined;
  readonly appSlug: string | undefined;
} {
  const configuredAppId = normalizedProviderValue(args.configuredAppId);
  const configuredAppSlug = normalizedProviderValue(args.configuredAppSlug);
  const installationAppId = normalizedProviderValue(args.installationAppId);
  const installationAppSlug = normalizedProviderValue(args.installationAppSlug);
  // Historical rows written before the App identity columns were deployed have
  // no provider identity. Keep the configured official identity until #27750
  // reconciliation proves no active installation still has null App metadata;
  // user-managed rows remain keyed by their distinct provider App ID and never
  // take this branch.
  const isOfficialInstallation =
    installationAppId === undefined || installationAppId === configuredAppId;

  return {
    appId: installationAppId ?? configuredAppId,
    appSlug: isOfficialInstallation
      ? (configuredAppSlug ?? installationAppSlug)
      : installationAppSlug,
  };
}
