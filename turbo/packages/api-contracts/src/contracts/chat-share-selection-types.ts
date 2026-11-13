export interface ChatShareSelection {
  messages: {
    eventId: string;
    role: "user" | "assistant";
    turnEventIds: string[];
  }[];
}
