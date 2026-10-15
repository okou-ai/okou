import type { SshConnectionResponse } from "@okouai/api-contracts/contracts/ssh-connections";

export function credentialBackedSshHost(connection: SshConnectionResponse) {
  if (!("credentialId" in connection)) {
    throw new Error("Expected a credential-backed SSH test host");
  }
  return connection;
}
export function sshCredentialId(connection: SshConnectionResponse) {
  return credentialBackedSshHost(connection).credentialId;
}

/** Canonical inline named credential used by owner API fixtures. */
export function inlineSshKey(
  username: string,
  privateKey: string,
  passphrase: string | null = null,
) {
  return {
    create: {
      name: `${username} login`,
      username,
      authentication: {
        method: "private_key" as const,
        privateKey,
        passphrase,
      },
    },
  };
}
