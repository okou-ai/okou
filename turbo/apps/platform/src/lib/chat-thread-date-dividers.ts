import { nowDate } from "./time.ts";

export interface ChatDateDivider {
  readonly createdAt: string;
  readonly label: string | null;
}

/** Day boundaries for visible messages, using the viewer's local calendar. */
export function chatThreadDateDividers(
  events: readonly { readonly id: string; readonly createdAt: string }[],
  locale: string,
): ReadonlyMap<string, ChatDateDivider> {
  const today = nowDate();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const todayKey = today.toDateString();
  const yesterdayKey = yesterday.toDateString();
  const datedEvents = events.map((event) => {
    return { event, date: new Date(event.createdAt) };
  });
  const hasYesterday = datedEvents.some(({ date }) => {
    return date.toDateString() === yesterdayKey;
  });
  const relativeFormat = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
  });
  const dividers = new Map<string, ChatDateDivider>();
  let previousDay: string | undefined;

  for (const { event, date } of datedEvents) {
    const day = date.toDateString();
    if (day === previousDay) {
      continue;
    }
    previousDay = day;
    let label: string | null;
    if (day === todayKey && !hasYesterday) {
      label = null;
    } else if (day === todayKey || day === yesterdayKey) {
      const relative = relativeFormat.format(day === todayKey ? 0 : -1, "day");
      label = relative.charAt(0).toLocaleUpperCase(locale) + relative.slice(1);
    } else {
      label = new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() !== today.getFullYear()
          ? { year: "numeric" }
          : {}),
      }).format(date);
    }
    dividers.set(event.id, { createdAt: event.createdAt, label });
  }

  return dividers;
}
