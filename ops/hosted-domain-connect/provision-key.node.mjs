import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Execute only on reviewed main in the trusted production job. Private key
// material never reaches the sandbox, workflow output, or uploaded artifacts.
if (
  process.env.GITHUB_REF !== "refs/heads/main" ||
  process.env.GITHUB_REPOSITORY_ID !== "1096175506"
) {
  throw new Error("Domain Connect key provisioning requires trusted main");
}
async function request(url, token, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `Domain Connect provisioning request failed (${response.status})`,
    );
  }
  return await response.json();
}
const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
if (
  oidcUrl.protocol !== "https:" ||
  !oidcUrl.hostname.endsWith(".actions.githubusercontent.com")
) {
  throw new Error("Invalid GitHub OIDC endpoint");
}
oidcUrl.searchParams.set("audience", "https://github.com/okou-ai");
const oidc = await request(oidcUrl, process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
const auth = await request("https://api.doppler.com/v3/auth/oidc", "", {
  identity: process.env.DOPPLER_SERVICE_IDENTITY_ID,
  token: oidc.value,
});
const endpoint = "https://api.doppler.com/v3/configs/config/secrets";
const privateName = "HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64";
const hostName = "HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST";
const keyHost = "sites-v1";
const read = async () => {
  return Object.fromEntries(
    await Promise.all(
      [privateName, hostName].map(async (name) => {
        const result = await request(
          `https://api.doppler.com/v3/configs/config/secret?project=vm0&config=prd&name=${name}`,
          auth.token,
        );
        return [name, result.value];
      }),
    ),
  );
};
const current = await read();
let privateKeyBase64 = current[privateName]?.computed;
if (privateKeyBase64 || current[hostName]?.computed) {
  if (!privateKeyBase64 || current[hostName]?.computed !== keyHost) {
    throw new Error(
      "Existing Domain Connect configuration requires operator review",
    );
  }
} else {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyBase64 = keys.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  await request(endpoint, auth.token, {
    project: "vm0",
    config: "prd",
    change_requests: [
      [privateName, privateKeyBase64],
      [hostName, keyHost],
    ].map(([name, value]) => ({
      name,
      originalName: current[name] ? name : null,
      originalValue: current[name]?.raw ?? null,
      value,
      visibility: "masked",
    })),
  });
  const stored = await read();
  if (
    stored[privateName]?.computed !== privateKeyBase64 ||
    stored[hostName]?.computed !== keyHost
  ) {
    throw new Error(
      "Domain Connect key readback failed; inspect before retrying",
    );
  }
}
const privateKey = createPrivateKey({
  key: Buffer.from(privateKeyBase64, "base64"),
  format: "der",
  type: "pkcs8",
});
if (privateKey.asymmetricKeyType !== "rsa") {
  throw new Error("Domain Connect requires an RSA signing key");
}
const publicKey = createPublicKey(privateKey)
  .export({ format: "der", type: "spki" })
  .toString("base64");
const parts = publicKey.match(/.{1,200}/gu);
const records = parts.map((part, index) => ({
  type: "TXT",
  name: `${keyHost}.domainconnect.okou.ai`,
  content: `p=${index + 1},d=${part},a=RS256,t=x509`,
  ttl: 300,
}));
await writeFile(
  join(process.env.RUNNER_TEMP, "hosted-domain-connect-public-key.json"),
  JSON.stringify({ records }, null, 2) + "\n",
);
console.log(
  "Production signing key stored in Doppler; public DNS records retained.",
);
