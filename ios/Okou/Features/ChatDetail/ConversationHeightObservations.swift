import ChatDomain
import SwiftUI

@MainActor
final class ConversationHeightObservations<Content: View> {
  private typealias Measurer = ConversationRowMeasurer<Content>
  private typealias Measurement = ConversationMeasurementCache.Measurement
  private typealias ObservedHeight = ConversationObservedHeight
  private let readMeasurements: @MainActor () -> [String: ConversationMeasurementCache.Measurement]
  private let width: @MainActor () -> CGFloat?
  private let traits: @MainActor () -> UITraitCollection?
  private let isStopped: @MainActor () -> Bool
  private let didSettle: @MainActor () -> Void
  private var resizeTasks: [String: Task<Void, Never>] = [:]
  private var resizeIDs: [String: UUID] = [:]
  private var observedHeights: [String: ObservedHeight] = [:]
  private var measurements: [String: Measurement] { readMeasurements() }
  private var stopped: Bool { isStopped() }
  init(
    readMeasurements: @escaping @MainActor () -> [String: ConversationMeasurementCache.Measurement],
    width: @escaping @MainActor () -> CGFloat?,
    traits: @escaping @MainActor () -> UITraitCollection?,
    isStopped: @escaping @MainActor () -> Bool, didSettle: @escaping @MainActor () -> Void
  ) {
    self.readMeasurements = readMeasurements
    self.width = width
    self.traits = traits
    self.isStopped = isStopped
    self.didSettle = didSettle
  }
  private func applyObservedHeights() { didSettle() }

  func observeHeight(
    _ height: CGFloat, row: ConversationCollectionRow, width: CGFloat,
    category: UIContentSizeCategory, environment: ConversationHeightDiskCache.Layout
  ) {
    guard !stopped, height.isFinite, height > 0, width == self.width(), let traits = self.traits(),
      let measurement = measurements[row.id], measurement.row == row, measurement.width == width,
      measurement.category == category, measurement.environment == environment
    else { return }
    let renderedHeight = Measurer.pixelHeight(height, scale: traits.displayScale)
    if abs(measurement.height - renderedHeight) <= 0.5 {
      observedHeights.removeValue(forKey: row.id)
      resizeIDs.removeValue(forKey: row.id)
      resizeTasks.removeValue(forKey: row.id)?.cancel()
      return
    }
    observedHeights[row.id] = ObservedHeight(
      row: row, width: width, category: measurement.category, height: renderedHeight)
    guard resizeTasks[row.id] == nil else { return }
    let generation = UUID()
    resizeIDs[row.id] = generation
    resizeTasks[row.id] = Task { [weak self] in
      guard let self else { return }
      defer {
        if resizeIDs[row.id] == generation {
          resizeTasks[row.id] = nil
          resizeIDs[row.id] = nil
        }
      }
      var previous: CGFloat?
      var stableFrames = 0
      for _ in 0..<30 {
        await conversationLayoutFrame()
        guard !Task.isCancelled, !stopped else { return }
        let current = observedHeights[row.id]?.height
        stableFrames = current == previous ? stableFrames + 1 : 0
        previous = current
        if stableFrames >= 2 { break }
      }
      guard resizeIDs[row.id] == generation, measurements[row.id]?.row == row,
        measurements[row.id]?.width == width
      else { return }
      resizeTasks[row.id] = nil
      applyObservedHeights()
    }
  }
  func correct(
    _ measurements: inout [String: ConversationMeasurementCache.Measurement],
    cache: ConversationMeasurementCache, traits: UITraitCollection
  )
    -> ([String], [ConversationHeightDiskCache.Key: Double])
  {
    var changed: [String] = []
    var corrected: [ConversationHeightDiskCache.Key: Double] = [:]
    for (id, observed) in observedHeights where resizeTasks[id] == nil {
      if let previous = measurements[id], previous.row == observed.row,
        previous.width == observed.width, previous.category == observed.category,
        abs(previous.height - observed.height) > 0.5
      {
        measurements[id]?.height = observed.height
        if let measurement = measurements[id] {
          cache.store(measurement)
          if let key = measurement.diskKey,
            key.layout == Measurer.diskLayout(width: measurement.width, traits: traits)
          {
            corrected[key] = measurement.height
          }
        }
        changed.append(id)
      }
    }
    return (changed, corrected)
  }
  func prune(validIDs: Set<String>) {
    for id in resizeTasks.keys where !validIDs.contains(id) {
      resizeTasks.removeValue(forKey: id)?.cancel()
      resizeIDs.removeValue(forKey: id)
    }
    observedHeights = observedHeights.filter { validIDs.contains($0.key) }
  }
  func close() {
    for task in resizeTasks.values { task.cancel() }
    resizeTasks.removeAll()
    resizeIDs.removeAll()
    observedHeights.removeAll()
  }

}
