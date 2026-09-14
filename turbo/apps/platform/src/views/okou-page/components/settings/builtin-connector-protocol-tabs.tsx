import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@okouai/ui/components/ui/tabs";
import { builtinConnectorMcpEnabled$ } from "../../../../signals/external/connectors.ts";

export function BuiltinConnectorProtocolTabs({
  value,
  onChange,
}: {
  readonly value: "http" | "mcp";
  readonly onChange: (value: "http" | "mcp") => void;
}) {
  const enabled = useGet(builtinConnectorMcpEnabled$);
  const { t } = useTranslation();
  if (!enabled) {
    return null;
  }
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        onChange(next === "mcp" ? "mcp" : "http");
      }}
    >
      <TabsList
        aria-label={t(($) => {
          return $.connectors.catalog.protocolLabel;
        })}
      >
        <TabsTrigger value="http">
          {t(($) => {
            return $.connectors.custom.create.httpType;
          })}
        </TabsTrigger>
        <TabsTrigger value="mcp">
          {t(($) => {
            return $.connectors.custom.mcpType;
          })}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
