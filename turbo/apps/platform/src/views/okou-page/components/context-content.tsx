import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@okouai/ui";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { useTranslation } from "react-i18next";

export function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="rounded-md border bg-muted/50 p-3 text-xs leading-relaxed overflow-auto max-h-80 whitespace-pre-wrap break-words">
      {value}
    </pre>
  );
}

export function KeyValueTable({
  data,
  keyLabel,
  valueLabel,
}: {
  data: Record<string, string>;
  keyLabel?: string;
  valueLabel?: string;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.activity.context.none;
        })}
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-1/3">
            {keyLabel ??
              t(($) => {
                return $.activity.context.name;
              })}
          </TableHead>
          <TableHead>
            {valueLabel ??
              t(($) => {
                return $.activity.context.value;
              })}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([key, value]) => {
          return (
            <TableRow key={key}>
              <TableCell className="font-mono text-xs">{key}</TableCell>
              <TableCell className="font-mono text-xs break-all">
                {value}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function StorageTable({
  items,
}: {
  items: RunContextResponse["storageMounts"];
}) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.activity.context.none;
        })}
      </p>
    );
  }
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead>
            {t(($) => {
              return $.activity.context.storageName;
            })}
          </TableHead>
          <TableHead>
            {t(($) => {
              return $.activity.context.mountPath;
            })}
          </TableHead>
          <TableHead>
            {t(($) => {
              return $.activity.context.version;
            })}
          </TableHead>
          <TableHead>
            {t(($) => {
              return $.activity.context.access;
            })}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          return (
            <TableRow
              key={`${item.mountPath}-${item.name}-${item.version}-${item.writeback}`}
            >
              <TableCell className="font-mono text-xs break-all">
                {item.name}
              </TableCell>
              <TableCell className="font-mono text-xs break-all">
                {item.mountPath}
              </TableCell>
              <TableCell className="font-mono text-xs break-all">
                {item.version}
              </TableCell>
              <TableCell className="font-mono text-xs break-all">
                {item.writeback
                  ? t(($) => {
                      return $.activity.context.readWrite;
                    })
                  : t(($) => {
                      return $.activity.context.readOnly;
                    })}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function FeatureFlagsSection({
  flags,
}: {
  flags: Record<string, boolean> | null | undefined;
}) {
  const { t } = useTranslation();
  if (!flags || Object.keys(flags).length === 0) {
    return null;
  }
  const sorted = Object.entries(flags).sort(([, a], [, b]) => {
    return a === b ? 0 : a ? -1 : 1;
  });
  return (
    <section>
      <SectionHeader
        title={t(($) => {
          return $.activity.context.featureFlags;
        })}
      />
      <div className="flex flex-wrap gap-1.5">
        {sorted.map(([name, enabled]) => {
          return (
            <span
              key={name}
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono ${
                enabled
                  ? "bg-muted/50"
                  : "bg-transparent text-muted-foreground line-through"
              }`}
            >
              {name}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function StorageSection({ context }: { context: RunContextResponse }) {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeader
        title={t(($) => {
          return $.activity.context.storageMounts;
        })}
      />
      <StorageTable items={context.storageMounts} />
    </section>
  );
}

export function ContextContent({ context }: { context: RunContextResponse }) {
  const { t } = useTranslation();
  const none = t(($) => {
    return $.activity.context.none;
  });

  return (
    <div className="flex flex-col gap-6 pb-8">
      <section>
        <SectionHeader
          title={t(($) => {
            return $.activity.context.prompt;
          })}
        />
        <CodeBlock value={context.prompt} />
      </section>

      {context.appendSystemPrompt && (
        <section>
          <SectionHeader
            title={t(($) => {
              return $.activity.context.systemPrompt;
            })}
          />
          <CodeBlock value={context.appendSystemPrompt} />
        </section>
      )}

      <section>
        <SectionHeader
          title={t(($) => {
            return $.activity.context.runId;
          })}
        />
        <p className="text-sm font-mono text-muted-foreground">
          {context.runId}
        </p>
      </section>

      {context.sessionId && (
        <section>
          <SectionHeader
            title={t(($) => {
              return $.activity.context.session;
            })}
          />
          <p className="text-sm font-mono text-muted-foreground">
            {context.sessionId}
          </p>
        </section>
      )}

      {/* Feature Flags */}
      <FeatureFlagsSection flags={context.featureFlags} />

      {/* Secrets */}
      <section>
        <SectionHeader
          title={t(($) => {
            return $.activity.context.secrets;
          })}
        />
        {context.secretNames.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {context.secretNames.map((name) => {
              return (
                <span
                  key={name}
                  className="inline-flex items-center rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-mono"
                >
                  {name}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{none}</p>
        )}
      </section>

      {/* Variables */}
      <section>
        <SectionHeader
          title={t(($) => {
            return $.activity.context.variables;
          })}
        />
        {context.vars ? (
          <KeyValueTable data={context.vars} />
        ) : (
          <p className="text-sm text-muted-foreground">{none}</p>
        )}
      </section>

      {/* Environment Mapping */}
      <section>
        <SectionHeader
          title={t(($) => {
            return $.activity.context.environmentMapping;
          })}
        />
        <KeyValueTable data={context.environment} />
      </section>

      {/* Firewalls */}
      <section>
        <SectionHeader
          title={t(($) => {
            return $.activity.context.firewalls;
          })}
        />
        {context.firewalls.length > 0 ? (
          <CodeBlock value={JSON.stringify(context.firewalls, null, 2)} />
        ) : (
          <p className="text-sm text-muted-foreground">{none}</p>
        )}
      </section>

      {/* Network Policies */}
      {context.networkPolicies &&
        Object.keys(context.networkPolicies).length > 0 && (
          <section>
            <SectionHeader
              title={t(($) => {
                return $.activity.context.networkPolicies;
              })}
            />
            <CodeBlock
              value={JSON.stringify(context.networkPolicies, null, 2)}
            />
          </section>
        )}

      <StorageSection context={context} />
    </div>
  );
}
