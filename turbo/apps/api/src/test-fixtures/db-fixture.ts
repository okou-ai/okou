export type DbFixture = <T>(
  scope: string,
  work: () => Promise<T>,
) => Promise<T>;

/** Fixture queries own their rows by business scope; there is no lock namespace. */
export async function usageEventCompactionDbFixture<T>(
  _scope: string,
  work: () => Promise<T>,
): Promise<T> {
  return await work();
}
