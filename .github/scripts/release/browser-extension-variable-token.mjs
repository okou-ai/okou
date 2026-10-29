/** Repository-scoped Variables token; the pinned App-token action lacks this permission input. */
import { sign } from "node:crypto";
import { appendFile } from "node:fs/promises";

try {
  const origin = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new Error("Invalid GitHub API origin");
  if (process.argv.includes("--revoke")) {
    const token = process.env.GITHUB_VARIABLES_TOKEN;
    if (!token) throw new Error("Missing repository Variables token");
    const response = await fetch(new URL("/installation/token", origin), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error("Could not revoke repository Variables token");
  } else {
    const {
      GITHUB_REPOSITORY: repository,
      GITHUB_REPOSITORY_ID: repositoryId,
      OKOU_CI_APP_ID: appId,
      OKOU_CI_APP_PRIVATE_KEY: privateKey,
      GITHUB_OUTPUT: output,
    } = process.env;
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
      !/^\d+$/.test(repositoryId ?? "") ||
      !/^\d+$/.test(appId ?? "") ||
      !privateKey ||
      !output
    )
      throw new Error("Missing repository App-token inputs");
    const timestamp = Math.floor(Date.now() / 1000);
    const unsigned = [
      { alg: "RS256", typ: "JWT" },
      { iat: timestamp - 60, exp: timestamp + 540, iss: appId },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey.replaceAll("\\n", "\n")).toString("base64url")}`;
    async function request(path, body) {
      const response = await fetch(new URL(path, origin), {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(
          "CI App requires Variables write access to this repository",
        );
      return response.json();
    }
    const installation = await request(`/repos/${repository}/installation`);
    if (!Number.isSafeInteger(installation.id))
      throw new Error("Invalid CI App installation");
    const access = await request(
      `/app/installations/${installation.id}/access_tokens`,
      {
        repository_ids: [Number(repositoryId)],
        permissions: { variables: "write" },
      },
    );
    if (
      typeof access.token !== "string" ||
      !access.token ||
      /[\r\n]/.test(access.token) ||
      access.permissions?.variables !== "write"
    ) {
      throw new Error("CI App did not grant repository Variables write access");
    }
    console.log(`::add-mask::${access.token}`);
    await appendFile(output, `token=${access.token}\n`);
  }
} catch {
  console.error(
    "Could not manage the repository Variables token; check the CI App installation and Variables write permission",
  );
  process.exitCode = 1;
}
