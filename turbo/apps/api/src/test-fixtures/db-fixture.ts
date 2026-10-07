export type DbFixture = <T>(
  scope: string,
  work: () => Promise<T>,
) => Promise<T>;
