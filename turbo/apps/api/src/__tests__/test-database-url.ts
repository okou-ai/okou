export function apiTestDatabaseUrl(
  configuredUrl: string | undefined,
  inheritedOptions: string | undefined,
): URL {
  const url = new URL(
    configuredUrl ?? "postgresql://postgres:postgres@localhost:5432/vm0_test",
  );
  // Match pg's last-value URL precedence and fallback to PGOPTIONS when empty.
  const options =
    url.searchParams.getAll("options").at(-1) || inheritedOptions || "";
  // Startup options cover every physical connection, including pool replacements.
  url.searchParams.set(
    "options",
    options ? `${options} -c timezone=UTC` : "-c timezone=UTC",
  );
  return url;
}
