import ChatData
import Foundation
import OSLog

/// A widget push carries no data, so a timeline reload refreshes the snapshot's chat states from
/// the API with the session the App keeps in the shared Keychain. Signed out, offline or failing,
/// the widget keeps the last snapshot. The widget's timeline provider owns one instance.
@MainActor
final class OkouWidgetRefresh {
  /// A snapshot written this recently (by the App, the notification extension or an earlier
  /// refresh) is already current; this also bounds the widget's own API reads.
  static let freshness: TimeInterval = 5
  /// WidgetKit allows a reload only a short while; past this the widget keeps the last snapshot.
  static let deadline = Duration.seconds(12)

  private static let log = Logger(subsystem: "ai.okou.ios", category: "widgets")
  /// Every widget size and the Lock Screen reload together; one refresh serves them all.
  private var running: Task<OkouWidgetSnapshot?, Never>?

  nonisolated init() {}

  /// Cancels a refresh in flight; its widgets keep the last snapshot.
  func close() {
    running?.cancel()
    running = nil
  }

  isolated deinit { close() }

  func run(
    store: OkouWidgetSnapshotStore, session: NotificationExtensionSession?, now: Date = .now
  ) async -> OkouWidgetSnapshot? {
    if let running { return await running.value }
    let refresh = Task { await Self.refresh(store: store, session: session, now: now) }
    running = refresh
    let expiry = Task {
      try await Task.sleep(for: Self.deadline)
      refresh.cancel()
    }
    let snapshot = await refresh.value
    expiry.cancel()
    if running == refresh { running = nil }
    return snapshot
  }

  private static func refresh(
    store: OkouWidgetSnapshotStore, session: NotificationExtensionSession?, now: Date
  ) async -> OkouWidgetSnapshot? {
    let snapshot: OkouWidgetSnapshot?
    do {
      snapshot = try store.read()
    } catch {
      log.error(
        "Cannot read the widget snapshot: \(error.localizedDescription, privacy: .public)")
      return nil
    }
    // A snapshot from an older App names no account; the App rewrites it on its next launch.
    guard let snapshot, let userID = snapshot.userID, let session else { return snapshot }
    if let modified = store.modifiedAt(), now.timeIntervalSince(modified) < freshness {
      return snapshot
    }
    let workspaceID = snapshot.workspaceID
    do {
      let client = try await session.client(userID: userID, workspaceID: workspaceID)
      let feed = try await OkouWidgetFeed.read(for: snapshot, client: client, now: now)
      try Task.checkCancellation()
      // Apply to the latest file: the App may have rewritten it, or signed out, meanwhile.
      try store.update { current in
        current.belongs(toUser: userID, workspace: workspaceID)
          ? feed.apply(to: current, now: now) : nil
      }
      return try store.read()
    } catch {
      log.info(
        "Widget keeps its last snapshot: \(error.localizedDescription, privacy: .public)")
      return snapshot
    }
  }
}
