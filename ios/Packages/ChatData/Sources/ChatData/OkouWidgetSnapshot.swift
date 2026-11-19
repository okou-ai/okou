import Foundation

/// What the Home Screen and Lock Screen widgets show, written by the App into the shared App
/// Group and read by the widget extension. The widget never signs in or calls the API: the App
/// owns the confirmed chat list and republishes this snapshot whenever that list changes.
public struct OkouWidgetSnapshot: Codable, Equatable, Sendable {
  public struct Chat: Codable, Equatable, Sendable, Identifiable {
    /// The sidebar's states. `needsYou` is reserved for a run waiting on the user's approval;
    /// the chat list does not report it yet, so the App never writes it.
    public enum State: String, Codable, Sendable {
      case needsYou, working, finished, draft, idle
    }

    public let id: String
    public let title: String
    /// The status emoji the agent put at the front of the title, as the sidebar shows it.
    public let emoji: String?
    public let state: State
    public let isPinned: Bool
    /// The chat's sort time: when its latest run started or last changed.
    public let activityAt: Date

    public init(
      id: String, title: String, emoji: String?, state: State, isPinned: Bool, activityAt: Date
    ) {
      self.id = id
      self.title = title
      self.emoji = emoji
      self.state = state
      self.isPinned = isPinned
      self.activityAt = activityAt
    }
  }

  /// The new-chat taglines the widget greets with, already localized by the App.
  public struct Greetings: Codable, Equatable, Sendable {
    public let morning: String
    public let day: String
    public let evening: String
    public let night: String

    public init(morning: String, day: String, evening: String, night: String) {
      self.morning = morning
      self.day = day
      self.evening = evening
      self.night = night
    }
  }

  public let workspaceID: String
  public let greetings: Greetings
  /// Working and finished chats first, then pinned and recent ones, newest first in each.
  public let chats: [Chat]

  public init(workspaceID: String, greetings: Greetings, chats: [Chat]) {
    self.workspaceID = workspaceID
    self.greetings = greetings
    self.chats = chats
  }
}

/// The snapshot's one file in the App Group container.
public struct OkouWidgetSnapshotStore: Sendable {
  public static let appGroup = "group.ai.okou.ios"
  private let url: URL

  public init?(appGroup: String = Self.appGroup) {
    guard
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup)
    else { return nil }
    url = container.appendingPathComponent("okou-widget-snapshot.json")
  }

  /// Nil when the App has not published a snapshot (signed out, or never opened).
  public func read() throws -> OkouWidgetSnapshot? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(OkouWidgetSnapshot.self, from: data)
  }

  public func write(_ snapshot: OkouWidgetSnapshot) throws {
    let data = try JSONEncoder().encode(snapshot)
    try data.write(
      to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  /// Signing out leaves no chat titles behind for the widget to show.
  public func clear() throws {
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    try FileManager.default.removeItem(at: url)
  }
}
