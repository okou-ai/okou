import ChatData
import OSLog
import SwiftUI
import WidgetKit

enum OkouWidgetKind {
  /// The App and the notification extension reload this kind when they change the snapshot.
  static let status = OkouWidgetSnapshot.widgetKind
}

struct OkouStatusEntry: TimelineEntry {
  let date: Date
  /// Nil while signed out: the widget asks the person to open Okou.
  let snapshot: OkouWidgetSnapshot?
}

struct OkouStatusProvider: TimelineProvider {
  private static let log = Logger(subsystem: "ai.okou.ios.widgets", category: "snapshot")
  /// While a chat is working, reload this often in case a widget push is dropped or delayed.
  private static let workingReload: TimeInterval = 15 * 60

  /// An unreadable snapshot is logged and shown as no snapshot; the App rewrites it on launch.
  private func storedSnapshot() -> OkouWidgetSnapshot? {
    guard let store = OkouWidgetSnapshotStore() else { return nil }
    do {
      return try store.read()
    } catch {
      Self.log.error(
        "Cannot read the widget snapshot: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  /// One refresh serves every widget this provider reloads at once.
  private let refresh = OkouWidgetRefresh()

  /// The stored snapshot with its chat states refreshed from the API when the session allows.
  @MainActor
  private func refreshedSnapshot() async -> OkouWidgetSnapshot? {
    guard let store = OkouWidgetSnapshotStore() else { return nil }
    return await refresh.run(store: store, session: NotificationExtensionSession.live())
  }

  func placeholder(in context: Context) -> OkouStatusEntry {
    OkouStatusEntry(date: .now, snapshot: .sample)
  }

  func getSnapshot(
    in context: Context, completion: @escaping @Sendable (OkouStatusEntry) -> Void
  ) {
    // The gallery shows what the widget is for, including a request waiting for approval.
    if context.isPreview {
      completion(OkouStatusEntry(date: .now, snapshot: .sample))
    } else {
      completion(OkouStatusEntry(date: .now, snapshot: storedSnapshot()))
    }
  }

  /// A reload comes from the App or the notification extension changing the snapshot, from a
  /// widget push when a chat starts, finishes or fails or is read elsewhere, or from this
  /// timeline's own policy. Between reloads only the part of the day moves, which changes the
  /// greeting and the mascot's mood.
  func getTimeline(
    in context: Context, completion: @escaping @Sendable (Timeline<OkouStatusEntry>) -> Void
  ) {
    Task { @MainActor in
      let snapshot = await refreshedSnapshot()
      let now = Date.now
      var entries = [OkouStatusEntry(date: now, snapshot: snapshot)]
      for boundary in OkouWidgetMoment.boundaries(after: now) {
        entries.append(OkouStatusEntry(date: boundary, snapshot: snapshot))
      }
      let working = snapshot?.chats.contains { $0.state == .working } == true
      completion(
        Timeline(
          entries: entries,
          policy: working ? .after(now.addingTimeInterval(Self.workingReload)) : .atEnd))
    }
  }
}

/// WidgetKit hands the widget push token to the extension. The App reads the same token from
/// `WidgetCenter.shared.currentPushInfo` and registers it with its own session whenever it
/// refreshes its push registration; the extension never registers devices itself.
struct OkouWidgetPushHandler: WidgetPushHandler {
  func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
    Logger(subsystem: "ai.okou.ios.widgets", category: "push")
      .info("Widget push token changed for \(widgets.count, privacy: .public) widgets")
  }
}

struct OkouStatusWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: OkouWidgetKind.status, provider: OkouStatusProvider()) { entry in
      OkouStatusWidgetView(entry: entry)
    }
    .pushHandler(OkouWidgetPushHandler.self)
    .configurationDisplayName("Okou")
    .description("What needs you, what's working, and what just finished.")
    .supportedFamilies([
      .systemSmall, .systemMedium, .systemLarge,
      .accessoryRectangular, .accessoryCircular, .accessoryInline,
    ])
  }
}
