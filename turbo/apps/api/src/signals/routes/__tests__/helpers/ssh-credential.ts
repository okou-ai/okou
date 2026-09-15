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
