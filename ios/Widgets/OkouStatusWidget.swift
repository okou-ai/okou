import ChatData
import OSLog
import SwiftUI
import WidgetKit

enum OkouWidgetKind {
  /// Matches `OkouWidgetPublishing.kind` in the App, which reloads this widget.
  static let status = "ai.okou.widgets.status"
}

struct OkouStatusEntry: TimelineEntry {
  let date: Date
  /// Nil while signed out: the widget asks the person to open Okou.
  let snapshot: OkouWidgetSnapshot?
}

struct OkouStatusProvider: TimelineProvider {
  private static let log = Logger(subsystem: "ai.okou.ios.widgets", category: "snapshot")

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

  func placeholder(in context: Context) -> OkouStatusEntry {
    OkouStatusEntry(date: .now, snapshot: .sample)
  }

  func getSnapshot(in context: Context, completion: @escaping (OkouStatusEntry) -> Void) {
    // The gallery shows what the widget is for, including a request waiting for approval.
    if context.isPreview {
      completion(OkouStatusEntry(date: .now, snapshot: .sample))
    } else {
      completion(OkouStatusEntry(date: .now, snapshot: storedSnapshot()))
    }
  }

  /// The App reloads the timeline whenever the chat list changes. Between reloads the only thing
  /// that moves is the part of the day, which changes the greeting and the mascot's mood.
  func getTimeline(in context: Context, completion: @escaping (Timeline<OkouStatusEntry>) -> Void) {
    let snapshot = storedSnapshot()
    let now = Date.now
    var entries = [OkouStatusEntry(date: now, snapshot: snapshot)]
    for boundary in OkouWidgetMoment.boundaries(after: now) {
      entries.append(OkouStatusEntry(date: boundary, snapshot: snapshot))
    }
    completion(Timeline(entries: entries, policy: .atEnd))
  }
}

struct OkouStatusWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: OkouWidgetKind.status, provider: OkouStatusProvider()) { entry in
      OkouStatusWidgetView(entry: entry)
    }
    .configurationDisplayName("Okou")
    .description("What needs you, what's working, and what just finished.")
    .supportedFamilies([
      .systemSmall, .systemMedium, .systemLarge,
      .accessoryRectangular, .accessoryCircular, .accessoryInline,
    ])
  }
}
