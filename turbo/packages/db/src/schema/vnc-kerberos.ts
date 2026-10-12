import { sql, type SQLWrapper } from "drizzle-orm";

/** Permanent structural identity budgets, independent of credential crypto. */
export function kerberosPrincipalCheck(value: SQLWrapper, service = false) {
  const realm = sql`${value}->>'realm'`;
  const components = [
    sql`${value}->'components'->>0`,
    sql`${value}->'components'->>1`,
    sql`${value}->'components'->>2`,
    sql`${value}->'components'->>3`,
    sql`${value}->'components'->>4`,
    sql`${value}->'components'->>5`,
    sql`${value}->'components'->>6`,
    sql`${value}->'components'->>7`,
  ];
  const bounded = [realm, ...components].map((part) => {
    return sql`(${part} IS NULL OR (octet_length(${part}) BETWEEN 1 AND 255 AND ${part} !~ '[[:cntrl:]]'))`;
  });
  const total = sql.join(
    [realm, ...components].map((part) => {
      return sql`coalesce(octet_length(${part}), 0)`;
    }),
    sql` + `,
  );
  return sql`CASE WHEN ${value} IS NULL THEN true
    WHEN jsonb_typeof(${value}) = 'object'
      AND jsonb_typeof(${value}->'realm') = 'string'
      AND jsonb_typeof(${value}->'components') = 'array'
    THEN (${value} - 'realm' - 'components' = '{}'::jsonb
      AND jsonb_array_length(${value}->'components') BETWEEN 1 AND 8
      AND NOT jsonb_path_exists(${value}, '$.components[*] ? (@.type() != "string" || @ == "")')
      AND ${sql.join(bounded, sql` AND `)} AND (${total}) <= 1024
      ${service ? sql`AND jsonb_array_length(${value}->'components') = 2 AND ${value}->'components'->>0 = 'vnc'` : sql.empty()})
    ELSE false END`;
}
