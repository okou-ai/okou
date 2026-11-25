/** Read the Vitest marker through globalThis so this also works in workers. */
export function isVitestEnvironment(): boolean {
  return Boolean(
    (globalThis as { __vitest_index__?: boolean }).__vitest_index__,
  );
}
