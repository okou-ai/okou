import ChatDomain
import SwiftUI
import Textual

@MainActor
final class ConversationCollectionController<Content: View>: UIViewController,
  UICollectionViewDelegateFlowLayout, ConversationCollectionScrolling
{
  private typealias Measurement = ConversationMeasurementCache.Measurement
  private typealias Measurer = ConversationRowMeasurer<Content>

  private lazy var scrolling = ConversationCollectionPosition<Content>(
    input: { [weak self] in
      guard let self, let collection, let dataSource else { return nil }
      return ConversationPositionInput(
        source: source, collection: collection, dataSource: dataSource, layout: layout,
        displayedRows: displayedRows, displayedWidth: displayedWidth,
        displayedCategory: displayedCategory, traits: traitCollection, stopped: stopped)
    }, didEndScrolling: { [weak self] in self?.scrollingEnded() })
  private lazy var heightObservations = ConversationHeightObservations<Content>(
    readMeasurements: { [weak self] in self?.measurements ?? [:] },
    width: { [weak self] in self?.collection?.bounds.width },
    traits: { [weak self] in self?.traitCollection },
    isStopped: { [weak self] in self?.stopped != false },
    didSettle: { [weak self] in self?.applyObservedHeights() })

  private var keyboardTap: KeyboardDismissTap?
  private lazy var measurer = Measurer { [weak self] in
    guard let self else { return nil }
    return ConversationMeasurementInput(
      controller: self, source: source,
      defersHostedMeasurement: isScrolling && source.sendTransition?.isActive != true)
  }
  private lazy var content = ConversationCollectionContent<Content>(
    input: { [weak self] in self?.contentInput() },
    didObserveHeight: { [weak self] height, measurement in
      self?.observeHeight(
        height, row: measurement.row, width: measurement.width, category: measurement.category,
        environment: measurement.environment)
    })

  private func contentInput() -> ConversationContentInput<Content>? {
    guard let collection, let dataSource else { return nil }
    return ConversationContentInput(
      source: source, measurements: measurements, rows: displayedRows,
      visibleIndices: { [layout] in
        (layout.layoutAttributesForElements(in: collection.bounds) ?? []).compactMap {
          $0.representedElementCategory == .cell ? $0.indexPath.item : nil
        }
      }, itemIDs: { dataSource.snapshot().itemIdentifiers },
      view: view, collection: collection, dataSource: dataSource, displayedWidth: displayedWidth,
      displayedCategory: displayedCategory, traits: traitCollection, canPrefetch: canPrefetchContent
    )
  }

  private typealias PreparedRows = ConversationPreparedRows

  private let layout = UICollectionViewFlowLayout()
  private var collection: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private var source: ConversationCollectionView<Content>
  private var measurements: [String: Measurement] = [:]
  private var displayedRows: [String: ConversationCollectionRow] = [:]
  private var displayedWidth: CGFloat = 0
  private var displayedCategory = UIContentSizeCategory.unspecified
  private var preparation: Task<Void, Never>?
  private var preparationID = UUID()
  private var requestedRows: [ConversationCollectionRow] = []
  private var requestedWidth: CGFloat = 0
  private var requestedCategory = UIContentSizeCategory.unspecified
  private var requestedEnvironment: ConversationHeightDiskCache.Layout?
  private var preparedRows: PreparedRows?
  private var appliesRows = false
  private var lastViewportSize = CGSize.zero
  private var refreshTask: Task<Void, Never>?
  private var stopped = false
  /// The web's chat skeleton while the first messages load, not a spinner in an empty page.

  private lazy var loading = ConversationLoading(
    sleep: sleep, needsLoading: { [weak self] in self?.needsLoadingIndicator == true })
  private let sleep: @MainActor (Duration) async throws -> Void

  init(
    source: ConversationCollectionView<Content>,
    sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.source = source
    self.sleep = sleep
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    collection = ConversationAccessibilityCollection.configured(frame: view.bounds, layout: layout)
    keyboardTap = KeyboardDismissTap(on: collection)
    collection.selfSizingInvalidation = .disabled
    collection.register(MessageSelectionCell.self, forCellWithReuseIdentifier: "message")
    collection.delegate = self
    source.sendTransition?.attach(collection)
    source.sendTransition?.didBegin = { [weak self] in
      guard let self else { return }
      scrolling.pendingScroll = nil
      collection.stopScrollingAndZooming()
      scrolling.animatesScroll = false
      let insertion =
        dataSource.indexPath(for: "conversation-finished")
        ?? dataSource.indexPath(for: "conversation-bottom")
      if let insertion, let frame = collection.layoutAttributesForItem(at: insertion)?.frame {
        let lastContent = source.rows.last(where: { $0.isMessageContent })
        let spacing: CGFloat =
          lastContent == nil ? 20 : (lastContent?.message?.role == .user ? 8 : 24)
        let footerHeight = Measurer.footerHeight(
          state: .running, showsAvatar: true, traits: traitCollection)
        source.sendTransition?.projectFlight(
          insertionY: frame.minY, topSpacing: spacing, footerHeight: footerHeight)
      }
      source.phaseChanged(.animating)
    }
    source.sendTransition?.didFinish = { [weak self] in
      guard let self else { return }
      source.anchor.followBottom()
      scrollingEnded()
    }
    let accessibilityCollection = collection as? ConversationAccessibilityCollection
    accessibilityCollection?.beginsAccessibilityScroll = { [weak self] in
      guard let self else { return }
      source.sendTransition?.cancel()
      scrolling.pendingScroll = nil
      scrolling.animatesScroll = true
      source.phaseChanged(.interacting)
    }
    let refresh = UIRefreshControl()
    refresh.addTarget(self, action: #selector(refreshConversation), for: .valueChanged)
    collection.refreshControl = refresh
    view.addSubview(collection)
    dataSource = content.makeDataSource(in: collection)
    source.anchor.isPresentedMarker = { [weak self] marker in
      self?.isPresentedMarker(marker) ?? false
    }
    loading.install(in: self)
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLayoutDirection.self,
      UITraitLegibilityWeight.self, UITraitDisplayScale.self,
      UITraitUserInterfaceStyle.self
    ]) { (controller: ConversationCollectionController<Content>, _: UITraitCollection) in
      controller.publishViewportChange()
      controller.prepareRowsIfNeeded()
    }
    // Insets can synchronously lay out and commit cached rows. Finish installing the
    // data source and child views before allowing that first layout pass.
    updateContentInsets()
  }

  private var canPrefetchContent: Bool {
    !stopped && !isScrolling && !appliesRows && view.window != nil
      && collection.isUserInteractionEnabled && source.sendTransition?.isActive != true
  }

  override func didReceiveMemoryWarning() {
    super.didReceiveMemoryWarning()
    content.clearPrefetchedContent()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    loading.layout(in: view, topInset: collection.adjustedContentInset.top)
    if collection.bounds.size != lastViewportSize {
      lastViewportSize = collection.bounds.size
      publishViewportChange()
    }
    prepareRowsIfNeeded()
    source.sendTransition?.layoutDidChange()
    publishMetrics()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    publishViewportChange()
    source.sendTransition?.layoutDidChange()
    publishMetrics()
  }

  private func publishViewportChange() {
    scrolling.publishViewportChange()
  }

  func update(_ source: ConversationCollectionView<Content>) {
    self.source = source
    if isViewLoaded {
      updateContentInsets()
      prepareRowsIfNeeded()
    }
  }

  /// The header and composer heights are content insets, not safe area, so the soft top edge
  /// blurs only the status bar band; under the header's glass controls the text stays sharp.
  private func updateContentInsets() {
    let insets = UIEdgeInsets(
      top: source.contentInsets.top, left: source.contentInsets.leading,
      bottom: source.contentInsets.bottom, right: source.contentInsets.trailing)
    guard collection.contentInset != insets else { return }
    collection.contentInset = insets
    collection.verticalScrollIndicatorInsets = insets
    source.sendTransition?.layoutDidChange()
    publishViewportChange()
    publishMetrics()
  }

  func stop() {
    stopped = true
    content.stop()
    measurer.close()
    source.sendTransition?.cancel()
    source.sendTransition?.didBegin = nil
    source.sendTransition?.didFinish = nil
    loading.stop()
    preparation?.cancel()
    preparation = nil
    refreshTask?.cancel()
    refreshTask = nil
    heightObservations.close()
    source.scroll.detach(self)
    source.anchor.isPresentedMarker = nil
    collection?.delegate = nil
  }

  private func isPresentedMarker(_ marker: ConversationRowMarker) -> Bool {
    content.isPresentedMarker(marker)
  }

  private func prepareRowsIfNeeded() {
    defer { loading.update() }
    guard !stopped, collection.bounds.width > 0 else { return }
    let width = collection.bounds.width
    let category = traitCollection.preferredContentSizeCategory
    let environment = Measurer.diskLayout(width: width, traits: traitCollection)
    guard
      requestedRows != source.rows || requestedWidth != width || requestedCategory != category
        || requestedEnvironment != environment
    else { return }
    if requestedEnvironment != environment {
      content.clearPrefetchedContent()
    }
    requestedRows = source.rows
    requestedWidth = width
    requestedCategory = category
    requestedEnvironment = environment
    preparation?.cancel()
    preparation = nil
    let generation = UUID()
    preparationID = generation
    preparedRows = nil
    let rows = source.rows
    var preparedMeasurements: [String: Measurement] = [:]
    for row in rows {
      if let measured = measurements[row.id], measured.row.hasSameMeasuredLayout(as: row),
        measured.width == width, measured.category == category,
        measured.environment == environment
      {
        var updated = measured
        updated.row = row
        preparedMeasurements[row.id] = updated
      } else if let measured = source.measurements.measurement(
        for: row, width: width, category: category, environment: environment)
      {
        preparedMeasurements[row.id] = measured
      }
    }
    let missing = rows.filter { preparedMeasurements[$0.id] == nil }
    let validIDs = Set(rows.map(\.id)).subtracting(missing.map(\.id))
    heightObservations.prune(validIDs: validIDs)

    // Measure the outgoing literal text without mounting temporary SwiftUI trees
    // on the send's first animation frames. Other rows keep their hosted measurement.
    let measuresImmediately =
      source.sendTransition?.hidesBubbleID != nil
      && missing.allSatisfy { row in
        switch row.content {
        case .message(let message, _, _, let pendingRetry, _, _, _):
          message.id == source.sendTransition?.messageID
            && pendingRetry != true && message.role == .user && message.attachments.isEmpty
            && message.modelChange == nil && message.inputError == nil
            && message.userMessage?.parts.allSatisfy { $0.type == "text" } == true
        case .footer: true
        default: false
        }
      }
    if measuresImmediately {
      for (row, height) in zip(missing, measurer.measureImmediately(missing, width: width)) {
        preparedMeasurements[row.id] = Measurement(
          row: row, width: width, category: category, environment: environment, height: height)
      }
      preparedRows = PreparedRows(rows: rows, measurements: preparedMeasurements)
      applyPreparedRows()
      return
    }
    if missing.isEmpty {
      preparedRows = PreparedRows(rows: rows, measurements: preparedMeasurements)
      applyPreparedRows()
      return
    }
    let layout = ConversationMeasurementLayout(
      width: width, category: category, environment: environment)
    preparation = Task { [weak self] in
      guard let self else { return }
      await prepareMissingRows(
        missing, rows: rows, layout: layout, generation: generation,
        preparedMeasurements: preparedMeasurements)
    }
  }

  private func prepareMissingRows(
    _ missing: [ConversationCollectionRow], rows: [ConversationCollectionRow],
    layout: ConversationMeasurementLayout, generation: UUID,
    preparedMeasurements initial: [String: Measurement]
  ) async {
    guard
      let result = await measurer.prepareMissingRows(
        missing, source: source, layout: layout, preparedMeasurements: initial,
        isCurrent: { [weak self] in self?.preparationID == generation && self?.stopped == false })
    else { return }
    guard !Task.isCancelled, preparationID == generation, !stopped else { return }
    preparation = nil
    preparedRows = PreparedRows(rows: rows, measurements: result.measurements)
    applyPreparedRows()
    if !result.settledHeights.isEmpty {
      await ConversationHeightDiskCache.shared.store(result.settledHeights)
    }
  }

  private var needsLoadingIndicator: Bool {
    !stopped && !displayedRows.values.contains(where: \.isMessageContent)
      && (source.isLoadingHistory || source.rows.contains(where: \.isMessageContent))
  }

  private var isScrolling: Bool {
    // A send can accept measured updates and retarget its own animation.
    scrolling.animatesScroll || collection.isTracking || collection.isDragging
      || collection.isDecelerating
  }

  private func applyPreparedRows() {
    guard let prepared = preparedRows, !isScrolling, !appliesRows else { return }
    source.sendTransition?.prepareForSnapshot()
    preparedRows = nil
    appliesRows = true
    let rows = prepared.rows
    let ids = Set(rows.map(\.id))
    // Work summaries and follow-ups disappear in selection mode. An anchor for
    // one of those removed rows cannot override a surviving message's position.
    let preserved = source.anchor.preservedPosition.flatMap {
      ids.contains($0.messageID) ? $0 : nil
    }
    var position = preserved ?? captureReadingPosition(retaining: ids)
    if let current = position,
      let previous = displayedRows[current.messageID],
      let next = rows.first(where: { $0.id == current.messageID }),
      previous.isShareSelection != next.isShareSelection
    {
      position = ConversationReadingPosition(
        messageID: current.messageID,
        offset: current.offset + previous.sharingBodyInset - next.sharingBodyInset)
    }
    if !source.followsBottom, let position { source.anchor.preserve(position) }
    let oldIDs = Set(dataSource.snapshot().itemIdentifiers)
    var updatedMeasurements = prepared.measurements
    for row in rows {
      if let current = measurements[row.id], let prepared = updatedMeasurements[row.id],
        current.row.hasSameMeasuredLayout(as: prepared.row), current.width == prepared.width,
        current.category == prepared.category, current.environment == prepared.environment
      {
        var preserved = current
        preserved.row = prepared.row
        updatedMeasurements[row.id] = preserved
      }
    }
    let changed = rows.filter {
      oldIDs.contains($0.id)
        && (displayedRows[$0.id] != $0 || measurements[$0.id] != updatedMeasurements[$0.id])
    }.map(\.id)
    for row in rows { displayedRows[row.id] = row }
    measurements = updatedMeasurements
    for row in rows {
      if let measurement = measurements[row.id] { source.measurements.store(measurement) }
    }
    displayedWidth = requestedWidth
    displayedCategory = requestedCategory
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(rows.map(\.id))
    snapshot.reconfigureItems(changed)
    dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
      guard let self, !stopped else { return }
      appliesRows = false
      displayedRows = displayedRows.filter { ids.contains($0.key) }
      measurements = measurements.filter { ids.contains($0.key) }
      if scrolling.sharingTrailingSpace > 0, !rows.contains(where: \.isShareSelection) {
        setSharingTrailingSpace(0)
      }
      collection.layoutIfNeeded()
      loading.update()
      let firstItemID = rows.first(where: { $0.readingContentTopSpacing != nil })?.id
      DispatchQueue.main.async { [weak self] in
        guard let self, !stopped else { return }
        source.rowsPresented(firstItemID)
        measurer.prepareEarlierMarkdown()
        content.prefetchNearbyContent()
      }
      if isScrolling {
        publishMetrics()
        return
      }
      if source.sendTransition?.isActive == true {
        let messageID = source.sendTransition?.messageID
        let indexPath = messageID.flatMap { dataSource.indexPath(for: $0) }
        let cell = indexPath.flatMap { collection.cellForItem(at: $0) }
        var messageFrame = indexPath.flatMap { collection.layoutAttributesForItem(at: $0)?.frame }
        if let id = messageID, let spacing = displayedRows[id]?.readingContentTopSpacing {
          messageFrame?.origin.y += spacing
          messageFrame?.size.height -= spacing
        }
        source.sendTransition?.presentIfReady(
          in: ids, arrivingView: cell, messageFrame: messageFrame)
      } else if let pendingScroll = scrolling.pendingScroll {
        self.scrolling.pendingScroll = nil
        scrollTo(pendingScroll.id, anchor: pendingScroll.anchor, animated: pendingScroll.animated)
      } else if source.followsBottom {
        source.anchor.followBottom()
        scrollTo("conversation-bottom", anchor: .bottom, animated: false)
      } else if let position, ids.contains(position.messageID) {
        // Compensate before the next frame, even when SwiftUI row markers are not mounted yet.
        restoreReadingPosition(position)
        source.anchor.restore(position)
      }
      source.anchor.layoutDidChange()
      publishMetrics()
      applyPreparedRows()
      applyObservedHeights()
    }
  }

  func captureReadingPosition() -> ConversationReadingPosition? {
    return scrolling.captureReadingPosition(retaining: nil)
  }

  private func captureReadingPosition(retaining ids: Set<String>?) -> ConversationReadingPosition? {
    return scrolling.captureReadingPosition(retaining: ids)
  }

  private func restoreReadingPosition(_ position: ConversationReadingPosition) {
    scrolling.restoreReadingPosition(position)
  }

  private func setSharingTrailingSpace(_ height: CGFloat) {
    scrolling.setSharingTrailingSpace(height)
  }

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool) {
    guard source.sendTransition?.isActive != true else { return }
    scrolling.scrollTo(id, anchor: anchor, animated: animated)
  }

  func collectionView(
    _ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
    sizeForItemAt indexPath: IndexPath
  ) -> CGSize {
    guard let id = dataSource.itemIdentifier(for: indexPath), let measurement = measurements[id]
    else { preconditionFailure("Every collection item must have a measured conversation row") }
    return CGSize(width: collectionView.bounds.width, height: measurement.height)
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    content.cancelPrefetch()
    source.sendTransition?.cancel()
    scrolling.pendingScroll = nil
    scrolling.animatesScroll = false
    source.phaseChanged(.interacting)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    source.sendTransition?.preserveOffset()
    publishMetrics()
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if decelerate { source.phaseChanged(.decelerating) } else { scrollingEnded() }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { scrollingEnded() }
  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { scrollingEnded() }

  private func scrollingEnded() {
    scrolling.animatesScroll = false
    applyPreparedRows()
    applyObservedHeights()
    publishMetrics()
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped, source.sendTransition?.isActive != true else { return }
      source.phaseChanged(.idle)
      content.prefetchNearbyContent()
    }
  }

  private func publishMetrics() {
    scrolling.publishMetrics()
  }

  private func observeHeight(
    _ height: CGFloat, row: ConversationCollectionRow, width: CGFloat,
    category: UIContentSizeCategory, environment: ConversationHeightDiskCache.Layout
  ) {
    heightObservations.observeHeight(
      height, row: row, width: width, category: category, environment: environment)
  }

  private func applyObservedHeights() {
    guard !isScrolling, !appliesRows else { return }
    let atBottom =
      source.followsBottom
      || collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY <= 20
    let (changed, corrected) = heightObservations.correct(
      &measurements, cache: source.measurements, traits: traitCollection)
    guard !changed.isEmpty else { return }
    if !corrected.isEmpty {
      Task { await ConversationHeightDiskCache.shared.store(corrected) }
    }
    source.sendTransition?.prepareForSnapshot()
    // Capture the presented position after pausing any send animation.
    let position = source.anchor.preservedPosition ?? captureReadingPosition()
    if !atBottom, let position { source.anchor.preserve(position) }
    appliesRows = true
    var snapshot = dataSource.snapshot()
    snapshot.reconfigureItems(changed)
    layout.invalidateLayout()
    dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
      guard let self, !stopped else { return }
      appliesRows = false
      collection.layoutIfNeeded()
      if isScrolling {
        publishMetrics()
        return
      }
      if source.sendTransition?.isActive == true {
        source.sendTransition?.layoutDidChange()
      } else if atBottom {
        source.anchor.followBottom()
      } else if let position {
        restoreReadingPosition(position)
        source.anchor.restore(position)
      }
      publishMetrics()
      applyPreparedRows()
    }
  }

  @objc private func refreshConversation() {
    guard refreshTask == nil else { return }
    refreshTask = Task { [weak self] in
      guard let self else { return }
      await source.refresh()
      collection.refreshControl?.endRefreshing()
      refreshTask = nil
    }
  }
}
