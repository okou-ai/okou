import SwiftUI

/// Sizes from a settled offscreen host can replace unchanged units in later measurement hosts.
@MainActor
final class MessageUnitMeasurements {
  private struct Key: Hashable {
    let layout: ConversationHeightDiskCache.Layout
    let unit: MessageRenderPlan.SizeKey
  }

  private var sizes: [Key: CGSize] = [:]
  private var order: [Key] = []
  private var generation = UUID()

  func clear() {
    generation = UUID()
    sizes.removeAll()
    order.removeAll()
  }

  @MainActor
  final class Session {
    private let cache: MessageUnitMeasurements
    private let layout: ConversationHeightDiskCache.Layout
    private let generation: UUID
    private var observed: [Key: CGSize] = [:]

    init(cache: MessageUnitMeasurements, layout: ConversationHeightDiskCache.Layout) {
      self.cache = cache
      self.layout = layout
      generation = cache.generation
    }

    func size(for unit: MessageRenderPlan.SizeKey) -> CGSize? {
      guard generation == cache.generation else { return nil }
      return cache.sizes[Key(layout: layout, unit: unit)]
    }

    func observe(_ size: CGSize, for unit: MessageRenderPlan.SizeKey) {
      guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else {
        return
      }
      observed[Key(layout: layout, unit: unit)] = size
    }

    func commit() {
      guard generation == cache.generation else { return }
      for (key, size) in observed {
        if cache.sizes.updateValue(size, forKey: key) == nil { cache.order.append(key) }
      }
      while cache.order.count > 128 { cache.sizes.removeValue(forKey: cache.order.removeFirst()) }
    }
  }
}

extension EnvironmentValues {
  @Entry var messageUnitMeasurement: MessageUnitMeasurements.Session? = nil
}
