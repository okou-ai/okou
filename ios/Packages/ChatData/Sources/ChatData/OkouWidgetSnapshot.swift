import ChatDomain
import Foundation

/// What the Home Screen and Lock Screen widgets show, kept in the shared App Group. The App
/// publishes it from its confirmed chat list while it runs; the notification extension marks a
/// finished chat; and the widget refreshes its states from the API when a widget push arrives.
public struct OkouWidgetSnapshot: Codable, Equatable, Sendable {
  public struct Chat: Codable, Equatable, Sendable, Identifiable {
    /// The sidebar's states. `needsYou` is reserved for a run waiting on the user's approval;
    /// the chat list does not report it yet, so nothing writes it.
    public enum State: String, Codable, Sendable {
      case needsYou, working, finished, draft, idle
    }

    public let id: String
    public let title: String
    /// The status emoji the agent put at the front of the title, as the sidebar shows it.
    public let emoji: String?
    public var state: State
    public let isPinned: Bool
    /// The chat's sort time: when its latest run started or last changed.
    public var activityAt: Date

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

  /// The status widget's kind: whoever changes the snapshot reloads this widget's timelines.
  public static let widgetKind = "ai.okou.widgets.status"

  /// How many chats the snapshot keeps: the large widget's rows and then some.
  public static let chatLimit = 12

  /// The signed-in account. Nil in a snapshot an older App wrote; nothing refreshes it then.
  public let userID: String?
  public let workspaceID: String
  public let greetings: Greetings
  /// Finished and working chats first, then pinned and recent ones, newest first in each.
  public let chats: [Chat]

  public init(userID: String?, workspaceID: String, greetings: Greetings, chats: [Chat]) {
    self.userID = userID
    self.workspaceID = workspaceID
    self.greetings = greetings
    self.chats = Self.ordered(chats)
  }

  /// Unread results and working chats lead, then pinned ones, then the most recent of the rest,
  /// newest first within each group.
  public static func ordered(_ chats: [Chat]) -> [Chat] {
    let recent = chats.enumerated()
      .sorted { ($0.element.activityAt, $1.offset) > ($1.element.activityAt, $0.offset) }
      .map(\.element)
    func rank(_ chat: Chat) -> Int {
      switch chat.state {
      case .needsYou: 0
      case .finished: 1
      case .working: 2
      case .draft, .idle: chat.isPinned ? 3 : 4
      }
    }
    let ranked = recent.enumerated()
      .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
      .map(\.element)
    return Array(ranked.prefix(chatLimit))
  }

  /// Whether this snapshot belongs to the account and workspace a push or session names.
  public func belongs(toUser userID: String, workspace workspaceID: String) -> Bool {
    self.userID == userID && self.workspaceID == workspaceID
  }

  /// A finished-run alert arrived for this chat: it now waits to be read. Nil when the snapshot
  /// does not list the chat or already shows it finished; the widget's own refresh adds it.
  public func markingFinished(threadID: String, at date: Date) -> OkouWidgetSnapshot? {
    guard let index = chats.firstIndex(where: { $0.id == threadID }),
      chats[index].state != .finished
    else { return nil }
    var chats = chats
    chats[index].state = .finished
    chats[index].activityAt = max(chats[index].activityAt, date)
    return OkouWidgetSnapshot(
      userID: userID, workspaceID: workspaceID, greetings: greetings, chats: chats)
  }

  /// The server's active and unread chats applied to this snapshot. `added` holds the chats
  /// the snapshot did not list yet, already filtered to visible ones. A chat that is neither
  /// active nor unread anymore returns to its draft or idle state.
  public func refreshed(
    indicators: [String: ChatIndicator], unreadAt: [String: Date], added: [Chat], now: Date
  ) -> OkouWidgetSnapshot {
    func state(_ id: String, otherwise: Chat.State) -> Chat.State {
      switch indicators[id] {
      case .active: .working
      case .unread: .finished
      case nil: otherwise
      }
    }
    var refreshed: [Chat] = []
    for var chat in chats {
      let resting: Chat.State =
        chat.state == .draft ? .draft : (chat.state == .needsYou ? .needsYou : .idle)
      let next = state(chat.id, otherwise: resting)
      if next != chat.state, next == .working || next == .finished {
        chat.activityAt = max(chat.activityAt, unreadAt[chat.id] ?? now)
      }
      chat.state = next
      refreshed.append(chat)
    }
    for var chat in added where !refreshed.contains(where: { $0.id == chat.id }) {
      chat.state = state(chat.id, otherwise: .idle)
      refreshed.append(chat)
    }
    return OkouWidgetSnapshot(
      userID: userID, workspaceID: workspaceID, greetings: greetings, chats: refreshed)
  }

  private enum CodingKeys: String, CodingKey {
    case userID, workspaceID, greetings, chats
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    userID = try container.decodeIfPresent(String.self, forKey: .userID)
    workspaceID = try container.decode(String.self, forKey: .workspaceID)
    greetings = try container.decode(Greetings.self, forKey: .greetings)
    chats = try container.decode([Chat].self, forKey: .chats)
  }
}

/// The snapshot's one file in the App Group container. The App, the notification extension and
/// the widget write it from separate processes, so every write is file-coordinated and every
/// change re-reads the latest file inside the same coordination.
public struct OkouWidgetSnapshotStore: Sendable {
  public static let appGroup = "group.ai.okou.ios"
  private let url: URL

  public init?(appGroup: String = Self.appGroup) {
    guard
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup)
    else { return nil }
    self.init(url: container.appendingPathComponent("okou-widget-snapshot.json"))
  }

  public init(url: URL) {
    self.url = url
  }

  /// Nil when the App has not published a snapshot (signed out, or never opened).
  public func read() throws -> OkouWidgetSnapshot? {
    try coordinate(writing: false) { try load($0) }
  }

  public func write(_ snapshot: OkouWidgetSnapshot) throws {
    try coordinate(writing: true) { try save(snapshot, to: $0) }
  }

  /// Applies `change` to the latest snapshot and saves its result. Returns the saved snapshot,
  /// or nil when there was no snapshot or `change` made none.
  @discardableResult
  public func update(
    _ change: (OkouWidgetSnapshot) throws -> OkouWidgetSnapshot?
  ) throws -> OkouWidgetSnapshot? {
    try coordinate(writing: true) { url in
      guard let current = try load(url), let next = try change(current), next != current
      else { return nil }
      try save(next, to: url)
      return next
    }
  }

  /// When any process last wrote the snapshot.
  public func modifiedAt() -> Date? {
    try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
  }

  /// Signing out leaves no chat titles behind for the widget to show.
  public func clear() throws {
    try coordinate(writing: true) { url in
      guard FileManager.default.fileExists(atPath: url.path) else { return }
      try FileManager.default.removeItem(at: url)
    }
  }

  private func load(_ url: URL) throws -> OkouWidgetSnapshot? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(OkouWidgetSnapshot.self, from: Data(contentsOf: url))
  }

  private func save(_ snapshot: OkouWidgetSnapshot, to url: URL) throws {
    let data = try JSONEncoder().encode(snapshot)
    try data.write(
      to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  private func coordinate<Result>(
    writing: Bool, _ body: (URL) throws -> Result
  ) throws -> Result {
    let coordinator = NSFileCoordinator()
    var coordinationError: NSError?
    var outcome: Swift.Result<Result, any Error>?
    if writing {
      coordinator.coordinate(writingItemAt: url, options: [], error: &coordinationError) { url in
        outcome = Swift.Result { try body(url) }
      }
    } else {
      coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { url in
        outcome = Swift.Result { try body(url) }
      }
    }
    if let coordinationError { throw coordinationError }
    guard let outcome else { throw CocoaError(.fileWriteUnknown) }
    return try outcome.get()
  }
}
