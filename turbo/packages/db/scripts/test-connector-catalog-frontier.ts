import {
  array,
  boolean,
  int32,
  json,
  number,
  strictObject,
  string,
  tuple,
} from "zod";

export type RequiredColumnPhase = "prepared" | "contracted";

const rawColumns = {
  hash: string(),
  slug: string(),
  label: string(),
  description: string(),
  category: string(),
  icon: json(),
  tags: array(string().nullable()),
  generation: array(string().nullable()),
  auth_methods: json(),
  mcp: json(),
  skill: json(),
  firewall: json(),
  permission_summary: json(),
  icon_sql_null: boolean(),
  auth_methods_sql_null: boolean(),
  mcp_sql_null: boolean(),
  skill_sql_null: boolean(),
  firewall_sql_null: boolean(),
  permission_summary_sql_null: boolean(),
};
export const contractedRequiredRows = array(strictObject(rawColumns));
export const preparedRequiredRows = array(
  strictObject({
    ...rawColumns,
    payload: json(),
    payload_sql_null: boolean(),
  }),
);
export const requiredPointers = array(
  strictObject({
    schema_version: int32(),
    hash: string(),
  }),
);
export const nativeIdentityRows = tuple([
  strictObject({
    database: string(),
    role: string(),
    session_role: string(),
    pid: int32(),
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
    rows: tuple([
      strictObject({
        owner: string(),
        acl: string().nullable(),
        can_use: boolean(),
        can_create: boolean(),
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
    rows: array(
      strictObject({
        relname: string(),
        owner: string(),
        acl: string().nullable(),
        kind: string(),
        persistence: string(),
        rls: boolean(),
        force_rls: boolean(),
        can_select: boolean(),
        can_insert: boolean(),
        can_update: boolean(),
        can_delete: boolean(),
      }),
    ),
  },
  attributes: {
    sql: `SELECT c.relname, a.attnum, a.attname, a.attisdropped, a.attacl::text AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname,a.attnum`,
    rows: array(
      strictObject({
        relname: string(),
        attnum: number().int(),
        attname: string(),
        attisdropped: boolean(),
        acl: string().nullable(),
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
    rows: array(
      strictObject({
        relname: string(),
        polname: string(),
        command: string(),
        polpermissive: boolean(),
        roles: string(),
        using_expression: string().nullable(),
        check_expression: string().nullable(),
      }),
    ),
  },
  rules: {
    sql: `SELECT c.relname, r.rulename, pg_get_ruledef(r.oid) AS definition
      FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,r.rulename`,
    rows: array(
      strictObject({
        relname: string(),
        rulename: string(),
        definition: string(),
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
    rows: array(
      strictObject({
        child: string(),
        parent_schema: string(),
        parent: string(),
        inhseqno: number().int(),
      }),
    ),
  },
};

// Keep every selected catalog field; result generics do not decode pg rows.
export const physicalCatalogRows = tuple([
  strictObject({
    catalog: strictObject({
      columns: array(
        strictObject({
          oid: string().regex(/^\d+$/u),
          table: string(),
          attnum: number().int().positive(),
          name: string(),
          type: string(),
          notNull: boolean(),
          default: string().nullable(),
          identity: string(),
          generated: string(),
          dropped: boolean(),
          collation: string().nullable(),
        }),
      ),
      constraints: array(
        strictObject({
          oid: string().regex(/^\d+$/u),
          name: string(),
          type: string(),
          validated: boolean(),
          deferrable: boolean(),
          deferred: boolean(),
          definition: string(),
        }),
      ),
      indexes: array(
        strictObject({
          table: string(),
          name: string(),
          definition: string(),
        }),
      ),
      tables: array(
        strictObject({
          name: string(),
          kind: string(),
          rls: boolean(),
        }),
      ),
      triggers: array(strictObject({ name: string(), definition: string() })),
      routines: array(
        strictObject({
          name: string(),
          kind: string(),
          body: string(),
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
export const catalogRowsSchema = array(
  strictObject({
    catalog: strictObject({
      columns: array(
        strictObject({
          table: string(),
          position: number().int(),
          name: string(),
          type: string(),
          notNull: boolean(),
          default: string().nullable(),
          identity: string(),
          generated: string(),
          dropped: boolean(),
          collation: string().nullable(),
        }),
      ),
      constraints: array(
        strictObject({
          name: string(),
          type: string(),
          validated: boolean(),
          deferrable: boolean(),
          deferred: boolean(),
          definition: string(),
        }),
      ),
      indexes: array(
        strictObject({
          table: string(),
          name: string(),
          definition: string(),
        }),
      ),
      relations: array(
        strictObject({
          name: string(),
          kind: string(),
          persistence: string(),
          rls: boolean(),
          forceRls: boolean(),
        }),
      ),
      triggers: array(strictObject({ name: string(), definition: string() })),
      routines: array(
        strictObject({
          name: string(),
          kind: string(),
          body: string(),
        }),
      ),
    }),
  }),
).length(1);
