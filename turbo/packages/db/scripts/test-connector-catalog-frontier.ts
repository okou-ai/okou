import { z } from "zod";

export type RequiredColumnPhase = "prepared" | "contracted";

const rawColumns = {
  hash: z.string(),
  slug: z.string(),
  label: z.string(),
  description: z.string(),
  category: z.string(),
  icon: z.json(),
  tags: z.array(z.string().nullable()),
  generation: z.array(z.string().nullable()),
  auth_methods: z.json(),
  mcp: z.json(),
  skill: z.json(),
  firewall: z.json(),
  permission_summary: z.json(),
  icon_sql_null: z.boolean(),
  auth_methods_sql_null: z.boolean(),
  mcp_sql_null: z.boolean(),
  skill_sql_null: z.boolean(),
  firewall_sql_null: z.boolean(),
  permission_summary_sql_null: z.boolean(),
};
export const contractedRequiredRows = z.array(z.strictObject(rawColumns));
export const preparedRequiredRows = z.array(
  z.strictObject({
    ...rawColumns,
    payload: z.json(),
    payload_sql_null: z.boolean(),
  }),
);
export const requiredPointers = z.array(
  z.strictObject({
    schema_version: z.int32(),
    hash: z.string(),
  }),
);
export const nativeIdentityRows = z.tuple([
  z.strictObject({
    database: z.string(),
    role: z.string(),
    session_role: z.string(),
    pid: z.int32(),
  }),
]);
export const nativeIdentitySql = `SELECT current_database() AS database,
  current_user::text AS role, session_user::text AS session_role,
  pg_backend_pid() AS pid`;

export function requiredRowsSql(phase: RequiredColumnPhase) {
  return `SELECT hash, slug, label, description, category, icon, tags, generation,
    auth_methods, mcp, skill, firewall, permission_summary${phase === "prepared" ? ", payload" : ""},
    icon IS NULL AS icon_sql_null, auth_methods IS NULL AS auth_methods_sql_null,
    mcp IS NULL AS mcp_sql_null, skill IS NULL AS skill_sql_null,
    firewall IS NULL AS firewall_sql_null,
    permission_summary IS NULL AS permission_summary_sql_null${phase === "prepared" ? ", payload IS NULL AS payload_sql_null" : ""}
    FROM connector_catalog_entries ORDER BY hash, slug`;
}

// These queries enumerate permissions and otherwise unexpected dependencies;
// an empty inventory is asserted, never silently filtered from comparison.
export const requiredPermissions = {
  namespace: {
    sql: `SELECT pg_get_userbyid(n.nspowner) AS owner, n.nspacl::text AS acl,
      has_schema_privilege(current_user,n.oid,'USAGE') AS can_use,
      has_schema_privilege(current_user,n.oid,'CREATE') AS can_create
      FROM pg_namespace n WHERE n.nspname=$1`,
    rows: z.tuple([
      z.strictObject({
        owner: z.string(),
        acl: z.string().nullable(),
        can_use: z.boolean(),
        can_create: z.boolean(),
      }),
    ]),
  },
  relations: {
    sql: `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
      c.relacl::text AS acl, c.relkind::text AS kind,
      c.relpersistence::text AS persistence, c.relrowsecurity AS rls,
      c.relforcerowsecurity AS force_rls,
      has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
      has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
      has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
      has_table_privilege(current_user,c.oid,'DELETE') AS can_delete
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`,
    rows: z.array(
      z.strictObject({
        relname: z.string(),
        owner: z.string(),
        acl: z.string().nullable(),
        kind: z.string(),
        persistence: z.string(),
        rls: z.boolean(),
        force_rls: z.boolean(),
        can_select: z.boolean(),
        can_insert: z.boolean(),
        can_update: z.boolean(),
        can_delete: z.boolean(),
      }),
    ),
  },
  attributes: {
    sql: `SELECT c.relname, a.attnum, a.attname, a.attisdropped, a.attacl::text AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname,a.attnum`,
    rows: z.array(
      z.strictObject({
        relname: z.string(),
        attnum: z.number().int(),
        attname: z.string(),
        attisdropped: z.boolean(),
        acl: z.string().nullable(),
      }),
    ),
  },
  policies: {
    sql: `SELECT c.relname, p.polname, p.polcmd::text AS command,
      p.polpermissive, p.polroles::text AS roles,
      pg_get_expr(p.polqual,p.polrelid) AS using_expression,
      pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,p.polname`,
    rows: z.array(
      z.strictObject({
        relname: z.string(),
        polname: z.string(),
        command: z.string(),
        polpermissive: z.boolean(),
        roles: z.string(),
        using_expression: z.string().nullable(),
        check_expression: z.string().nullable(),
      }),
    ),
  },
  rules: {
    sql: `SELECT c.relname, r.rulename, pg_get_ruledef(r.oid) AS definition
      FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,r.rulename`,
    rows: z.array(
      z.strictObject({
        relname: z.string(),
        rulename: z.string(),
        definition: z.string(),
      }),
    ),
  },
  inheritance: {
    sql: `SELECT c.relname AS child, pn.nspname AS parent_schema,
      pc.relname AS parent, i.inhseqno
      FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_class pc ON pc.oid=i.inhparent
      JOIN pg_namespace pn ON pn.oid=pc.relnamespace
      WHERE n.nspname=$1 OR pn.nspname=$1
      ORDER BY c.relname,pn.nspname,pc.relname,i.inhseqno`,
    rows: z.array(
      z.strictObject({
        child: z.string(),
        parent_schema: z.string(),
        parent: z.string(),
        inhseqno: z.number().int(),
      }),
    ),
  },
};

// Keep every selected catalog field; result generics do not decode pg rows.
export const physicalCatalogRows = z.tuple([
  z.strictObject({
    catalog: z.strictObject({
      columns: z.array(
        z.strictObject({
          oid: z.string().regex(/^\d+$/u),
          table: z.string(),
          attnum: z.number().int().positive(),
          name: z.string(),
          type: z.string(),
          notNull: z.boolean(),
          default: z.string().nullable(),
          identity: z.string(),
          generated: z.string(),
          dropped: z.boolean(),
          collation: z.string().nullable(),
        }),
      ),
      constraints: z.array(
        z.strictObject({
          oid: z.string().regex(/^\d+$/u),
          name: z.string(),
          type: z.string(),
          validated: z.boolean(),
          deferrable: z.boolean(),
          deferred: z.boolean(),
          definition: z.string(),
        }),
      ),
      indexes: z.array(
        z.strictObject({
          table: z.string(),
          name: z.string(),
          definition: z.string(),
        }),
      ),
      tables: z.array(
        z.strictObject({
          name: z.string(),
          kind: z.string(),
          rls: z.boolean(),
        }),
      ),
      triggers: z.array(
        z.strictObject({ name: z.string(), definition: z.string() }),
      ),
      routines: z.array(
        z.strictObject({
          name: z.string(),
          kind: z.string(),
          body: z.string(),
        }),
      ),
    }),
  }),
]);

export const physicalCatalogSql = `SELECT jsonb_build_object(
 'columns', (SELECT coalesce(jsonb_agg(jsonb_build_object('oid',c.oid,'table',c.relname,'attnum',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'dropped',a.attisdropped,'collation',co.collname) ORDER BY c.relname,a.attnum),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE n.nspname=$1 AND c.relkind='r'),
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname),'[]'::jsonb) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1),
 'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef) ORDER BY indexname),'[]'::jsonb) FROM pg_indexes WHERE schemaname=$1),
 'tables',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity) ORDER BY c.relname),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','v','m','S','f')),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal),
 'routines',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',r.proname,'kind',r.prokind,'body',r.prosrc) ORDER BY r.proname),'[]'::jsonb) FROM pg_proc r JOIN pg_namespace n ON n.oid=r.pronamespace WHERE n.nspname=$1)
 ) AS catalog`;

// Compare physical contracts across namespaces without comparing allocated OIDs
// or the private namespace prefix. Keep dropped attributes in the frontier.
export const catalogFrontierSql = `SELECT jsonb_build_object(
  'columns', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'table', c.relname, 'position', a.attnum, 'name', a.attname,
    'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
    'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity,
    'generated', a.attgenerated, 'dropped', a.attisdropped,
    'collation', co.collname) ORDER BY c.relname, a.attnum), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation
    WHERE n.nspname = $1 AND c.relkind = 'r'),
  'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', c.conname, 'type', c.contype, 'validated', c.convalidated,
    'deferrable', c.condeferrable, 'deferred', c.condeferred,
    'definition', pg_get_constraintdef(c.oid)) ORDER BY c.conname), '[]'::jsonb)
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = $1),
  'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'table', tablename, 'name', indexname,
    'definition', replace(indexdef, quote_ident($1) || '.', ''))
    ORDER BY indexname), '[]'::jsonb)
    FROM pg_indexes WHERE schemaname = $1),
  'relations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', c.relname, 'kind', c.relkind, 'persistence', c.relpersistence,
    'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity)
    ORDER BY c.relname), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1),
  'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', t.tgname, 'definition', pg_get_triggerdef(t.oid))
    ORDER BY t.tgname), '[]'::jsonb)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal),
  'routines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', r.proname, 'kind', r.prokind, 'body', r.prosrc)
    ORDER BY r.proname), '[]'::jsonb)
    FROM pg_proc r JOIN pg_namespace n ON n.oid = r.pronamespace
    WHERE n.nspname = $1)
) AS catalog`;
export const catalogRowsSchema = z
  .array(
    z.strictObject({
      catalog: z.strictObject({
        columns: z.array(
          z.strictObject({
            table: z.string(),
            position: z.number().int(),
            name: z.string(),
            type: z.string(),
            notNull: z.boolean(),
            default: z.string().nullable(),
            identity: z.string(),
            generated: z.string(),
            dropped: z.boolean(),
            collation: z.string().nullable(),
          }),
        ),
        constraints: z.array(
          z.strictObject({
            name: z.string(),
            type: z.string(),
            validated: z.boolean(),
            deferrable: z.boolean(),
            deferred: z.boolean(),
            definition: z.string(),
          }),
        ),
        indexes: z.array(
          z.strictObject({
            table: z.string(),
            name: z.string(),
            definition: z.string(),
          }),
        ),
        relations: z.array(
          z.strictObject({
            name: z.string(),
            kind: z.string(),
            persistence: z.string(),
            rls: z.boolean(),
            forceRls: z.boolean(),
          }),
        ),
        triggers: z.array(
          z.strictObject({ name: z.string(), definition: z.string() }),
        ),
        routines: z.array(
          z.strictObject({
            name: z.string(),
            kind: z.string(),
            body: z.string(),
          }),
        ),
      }),
    }),
  )
  .length(1);
