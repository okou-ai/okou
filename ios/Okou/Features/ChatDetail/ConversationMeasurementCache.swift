import SwiftUI

/// Disposable, conversation-owned sizes survive rebuilding the native list.
@MainActor
final class ConversationMeasurementCache {
  struct Measurement: Equatable {
    let row: ConversationCollectionRow
    let width: CGFloat
    let category: UIContentSizeCategory
    let environment: ConversationHeightDiskCache.Layout
    var height: CGFloat
    var diskKey: ConversationHeightDiskCache.Key? = nil
  }

  let namespace: [String]?

  init(namespace: [String]? = nil) {
    self.namespace = namespace
  }

  private var entries: [String: Measurement] = [:]
  private var order: [String] = []
  private let limit = 256

  func measurement(
    for row: ConversationCollectionRow, width: CGFloat, category: UIContentSizeCategory,
    environment: ConversationHeightDiskCache.Layout
  ) -> Measurement? {
    guard let value = entries[row.id], value.row == row, value.width == width,
      value.category == category, value.environment == environment
    else { return nil }
    return value
  }

  func store(_ measurement: Measurement) {
    let id = measurement.row.id
    order.removeAll { $0 == id }
    order.append(id)
    entries[id] = measurement
    while order.count > limit { entries.removeValue(forKey: order.removeFirst()) }
  }

  func clear() {
    entries.removeAll()
    order.removeAll()
  }
}
