export function sortByName<Item>(
  items: readonly Item[],
  locale: string,
  describe: (item: Item) => { readonly name: string; readonly id: string },
): Item[] {
  const collator = new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
  });
  return items
    .map((item) => {
      return { item, ...describe(item) };
    })
    .sort((left, right) => {
      return (
        collator.compare(left.name, right.name) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      );
    })
    .map(({ item }) => {
      return item;
    });
}

type RemoteHost = { readonly displayName: string } & (
  { readonly id: string } | { readonly connectionId: string }
);

export function sortRemoteHosts<Host extends RemoteHost>(
  hosts: readonly Host[],
  locale: string,
): Host[] {
  return sortByName(hosts, locale, (host) => {
    return {
      name: host.displayName,
      id: "connectionId" in host ? host.connectionId : host.id,
    };
  });
}
