import { useTranslation } from "react-i18next";

export function AgentUnreadIndicator() {
  const { t } = useTranslation("agents");

  return (
    <span
      role="img"
      aria-label={t(($) => {
        return $.status.unread;
      })}
      className="h-2 w-2 rounded-full bg-sky-600"
    />
  );
}
