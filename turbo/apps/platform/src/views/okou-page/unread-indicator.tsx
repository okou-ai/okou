import { useTranslation } from "react-i18next";

export function UnreadIndicator() {
  const { t } = useTranslation("common");

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
