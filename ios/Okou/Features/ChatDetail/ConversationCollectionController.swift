import ChatDomain
import SwiftUI
import Textual

@MainActor
final class ConversationCollectionController<Content: View>: UIViewController,
  UICollectionViewDelegateFlowLayout, ConversationCollectionScrolling
{
  private typealias Measurement = ConversationMeasurementCache.Measurement
  private typealias Measurer = ConversationRowMeasurer<Content>
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
      view: view, collection: collection, canPrefetch: canPrefetchContent)
  }

  private typealias PreparedRows = ConversationPreparedRows

  private typealias ObservedHeight = ConversationObservedHeight

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
  private var pendingScroll: (String, UnitPoint, Bool)?
  private var sharingTrailingSpace: CGFloat = 0
  private var lastMetrics: ConversationCollectionMetrics?
  private var publishesMetrics = false
  private var lastViewportSize = CGSize.zero
  private var publishesViewport = false
  private var resizeTasks: [String: Task<Void, Never>] = [:]
  private var resizeIDs: [String: UUID] = [:]
  private var observedHeights: [String: ObservedHeight] = [:]
  private var refreshTask: Task<Void, Never>?
  private var stopped = false
  private var animatesScroll = false
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
    layout.minimumLineSpacing = 0
    layout.minimumInteritemSpacing = 0
    layout.estimatedItemSize = .zero
    collection = ConversationAccessibilityCollection(
      frame: view.bounds, collectionViewLayout: layout)
    collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collection.backgroundColor = .clear
    collection.alwaysBounceVertical = true
    // The top is the system's soft edge, the progressive blur ChatGPT and Manus draw:
    // strongest at the screen's edge, clearing toward the content, with no colour of its own.
    // It follows the safe area, so its reach is the status bar band (updateContentInsets).
    // The bottom has none, as everywhere in the app: messages pass plainly under the
    // composer's glass.
    collection.topEdgeEffect.style = .soft
    collection.bottomEdgeEffect.isHidden = true
    collection.keyboardDismissMode = .interactive
    keyboardTap = KeyboardDismissTap(on: collection)
    collection.selfSizingInvalidation = .disabled
    collection.register(MessageSelectionCell.self, forCellWithReuseIdentifier: "message")
    collection.delegate = self
    source.sendTransition?.attach(collection)
    source.sendTransition?.didBegin = { [weak self] in
      guard let self else { return }
      pendingScroll = nil
      collection.stopScrollingAndZooming()
      animatesScroll = false
      if let footer = dataSource.indexPath(for: "conversation-bottom"),
        let frame = collection.layoutAttributesForItem(at: footer)?.frame
      {
        let lastContent = source.rows.last(where: { $0.isMessageContent })
        let spacing: CGFloat =
          lastContent == nil ? 20 : (lastContent?.message?.role == .user ? 8 : 24)
        source.sendTransition?.projectFlight(insertionY: frame.minY, topSpacing: spacing)
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
      pendingScroll = nil
      animatesScroll = true
      source.phaseChanged(.interacting)
    }
    let refresh = UIRefreshControl()
    refresh.addTarget(self, action: #selector(refreshConversation), for: .valueChanged)
    collection.refreshControl = refresh
    view.addSubview(collection)
    dataSource = UICollectionViewDiffableDataSource<Int, String>(
      collectionView: collection
    ) { [weak self] collection, index, id in
      guard let self else { return nil }
      guard
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "message", for: index)
          as? MessageSelectionCell
      else { preconditionFailure("Expected a message cell") }
      guard let row = self.displayedRows[id], let measurement = self.measurements[id] else {
        preconditionFailure("Every displayed conversation row must have a measurement")
      }
      content.configure(cell, row: row, measurement: measurement)
      return cell
    }
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
    guard !publishesViewport else { return }
    publishesViewport = true
    source.anchor.layoutDidChange()
    // Preserve intent before a width/font snapshot can replace its geometry.
    // This callback only updates the non-observable anchor, not SwiftUI state.
    if !isScrolling { source.anchor.viewportDidChange?() }
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped else { return }
      publishesViewport = false
    }
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
    for task in resizeTasks.values { task.cancel() }
    resizeTasks.removeAll()
    resizeIDs.removeAll()
    observedHeights.removeAll()
    source.scroll.detach(self)
    source.anchor.isPresentedMarker = nil
    collection?.delegate = nil
  }

  private func isPresentedMarker(_ marker: ConversationRowMarker) -> Bool {
    // Marker readiness must honor the same measurement boundary as scroll metrics.
    guard displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory
    else { return false }
    guard let index = dataSource.indexPath(for: marker.messageID),
      let cell = collection.cellForItem(at: index)
    else { return false }
    // Reconfiguration can retain a previous hosting tree. Only the native
    // cell for this message and content inside its clipping bounds can anchor it.
    return marker.isPresented(in: cell, scale: traitCollection.displayScale)
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
      if let measured = measurements[row.id], measured.row == row, measured.width == width,
        measured.category == category, measured.environment == environment
      {
        preparedMeasurements[row.id] = measured
      } else if let measured = source.measurements.measurement(
        for: row, width: width, category: category, environment: environment)
      {
        preparedMeasurements[row.id] = measured
      }
    }
    let missing = rows.filter { preparedMeasurements[$0.id] == nil }
    let validIDs = Set(rows.map(\.id)).subtracting(missing.map(\.id))
    for id in resizeTasks.keys where !validIDs.contains(id) {
      resizeTasks.removeValue(forKey: id)?.cancel()
      resizeIDs.removeValue(forKey: id)
    }
    observedHeights = observedHeights.filter { validIDs.contains($0.key) }
    // Measure the outgoing literal text without mounting temporary SwiftUI trees
    // on the send's first animation frames. Other rows keep their hosted measurement.
    let measuresImmediately =
      source.sendTransition?.hidesBubbleID != nil
      && missing.allSatisfy { row in
        switch row {
        case .message(let message, _, _, _, _, _, _):
          message.id == source.sendTransition?.messageID
            && message.role == .user && message.attachments.isEmpty && message.modelChange == nil
            && message.inputError == nil
            && message.userMessage?.parts.allSatisfy { $0.type == "text" } == true
        case .footer(_, let showsAvatar): !showsAvatar
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
    preparation = Task { [weak self] in
      guard let self else { return }
      await prepareMissingRows(
        missing, rows: rows, width: width, category: category, environment: environment,
        generation: generation, preparedMeasurements: preparedMeasurements)
    }
  }

  private func prepareMissingRows(
    _ missing: [ConversationCollectionRow], rows: [ConversationCollectionRow],
    width: CGFloat, category: UIContentSizeCategory,
    environment: ConversationHeightDiskCache.Layout, generation: UUID,
    preparedMeasurements initial: [String: Measurement]
  ) async {
    var preparedMeasurements = initial
    let disk = ConversationHeightDiskCache.shared
    var keys: [String: ConversationHeightDiskCache.Key] = [:]
    var warmed = Set<String>()
    if let namespace = source.measurements.namespace, missing.count <= 64 {
      let layout = Measurer.diskLayout(width: width, traits: traitCollection)
      for row in missing {
        guard let message = row.message, message.role == .assistant else { continue }
        await measurer.prepareMarkdown(row)
        guard !Task.isCancelled, preparationID == generation else { return }
        warmed.insert(row.id)
      }
      for row in missing {
        keys[row.id] = Measurer.diskKey(
          for: row, namespace: namespace, layout: layout, source: source)
      }
      if !keys.isEmpty {
        let heights = await disk.heights(for: keys)
        guard !Task.isCancelled, preparationID == generation else { return }
        for row in missing {
          if let height = heights[row.id] {
            preparedMeasurements[row.id] = Measurement(
              row: row, width: width, category: category, environment: environment,
              height: height, diskKey: keys[row.id])
          }
        }
      }
    }
    let unmeasured = missing.filter { preparedMeasurements[$0.id] == nil }
    var settledHeights: [ConversationHeightDiskCache.Key: Double] = [:]
    // Four temporary hosts at a time bound retained views even in an expanded history.
    for start in stride(from: 0, to: unmeasured.count, by: 4) {
      let batch = Array(unmeasured[start..<min(start + 4, unmeasured.count)])
      for row in batch where !warmed.contains(row.id) {
        await measurer.prepareMarkdown(row)
        guard !Task.isCancelled, preparationID == generation else { return }
      }
      let (heights, settled) = await measurer.measure(batch, width: width)
      guard !Task.isCancelled, preparationID == generation else { return }
      for (row, height) in zip(batch, heights) {
        let key = settled ? keys[row.id] : nil
        if let key { settledHeights[key] = height }
        preparedMeasurements[row.id] = Measurement(
          row: row, width: width, category: category, environment: environment,
          height: height, diskKey: key)
      }
    }
    guard !Task.isCancelled, preparationID == generation, !stopped else { return }
    preparation = nil
    preparedRows = PreparedRows(rows: rows, measurements: preparedMeasurements)
    applyPreparedRows()
    if !settledHeights.isEmpty { await disk.store(settledHeights) }
  }

  private var needsLoadingIndicator: Bool {
    !stopped && !displayedRows.values.contains(where: \.isMessageContent)
      && (source.isLoadingHistory || source.rows.contains(where: \.isMessageContent))
  }

  private var isScrolling: Bool {
    // A send can accept measured updates and retarget its own animation.
    animatesScroll || collection.isTracking || collection.isDragging || collection.isDecelerating
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
        current.row == prepared.row, current.width == prepared.width,
        current.category == prepared.category, current.environment == prepared.environment
      {
        updatedMeasurements[row.id] = current
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
      if sharingTrailingSpace > 0, !rows.contains(where: \.isShareSelection) {
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
      } else if let pendingScroll {
        self.pendingScroll = nil
        scrollTo(pendingScroll.0, anchor: pendingScroll.1, animated: pendingScroll.2)
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
    captureReadingPosition(retaining: nil)
  }

  private func captureReadingPosition(retaining ids: Set<String>?) -> ConversationReadingPosition? {
    guard isViewLoaded, displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory
    else { return nil }
    let top = collection.bounds.minY + collection.adjustedContentInset.top
    let bottom = collection.bounds.maxY - collection.adjustedContentInset.bottom
    let positions: [ConversationReadingPosition] =
      collection.indexPathsForVisibleItems.compactMap { index in
        guard let id = dataSource.itemIdentifier(for: index), ids?.contains(id) ?? true,
          let spacing = displayedRows[id]?.readingContentTopSpacing,
          let frame = layout.layoutAttributesForItem(at: index)?.frame,
          frame.maxY > top, frame.minY + spacing < bottom
        else { return nil }
        return ConversationReadingPosition(messageID: id, offset: frame.minY + spacing - top)
      }
    return positions.min { $0.offset < $1.offset }
  }

  private func restoreReadingPosition(_ position: ConversationReadingPosition) {
    guard displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory,
      let index = dataSource.indexPath(for: position.messageID),
      let spacing = displayedRows[position.messageID]?.readingContentTopSpacing,
      let frame = layout.layoutAttributesForItem(at: index)?.frame
    else { return }
    let insets = collection.adjustedContentInset
    let requested = frame.minY + spacing - insets.top - position.offset
    if displayedRows[position.messageID]?.isShareSelection == true {
      // Hidden work/usage/follow-up rows can shorten the transcript below the
      // reader. Retain only the trailing room needed to avoid clamping them away.
      let maximum = max(
        -insets.top, collection.contentSize.height - collection.bounds.height + insets.bottom)
      if requested > maximum {
        setSharingTrailingSpace(sharingTrailingSpace + requested - maximum)
      }
    }
    let minimum = -insets.top
    let maximum = max(
      minimum, collection.contentSize.height - collection.bounds.height + insets.bottom)
    let y = min(maximum, max(minimum, requested))
    guard abs(y - collection.contentOffset.y) > 0.5 else { return }
    collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: y), animated: false)
  }

  private func setSharingTrailingSpace(_ height: CGFloat) {
    sharingTrailingSpace = height
    // This is scrollable empty content, not an occluding bar or safe area.
    layout.sectionInset.bottom = height
    layout.invalidateLayout()
    collection.layoutIfNeeded()
  }

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool) {
    guard source.sendTransition?.isActive != true else { return }
    let lastShareID = source.rows.last.flatMap { $0.isShareSelection ? $0.id : nil }
    let targetID = id == "conversation-bottom" ? lastShareID ?? id : id
    if isViewLoaded, id == "conversation-bottom", sharingTrailingSpace > 0 {
      setSharingTrailingSpace(0)
    }
    guard isViewLoaded, let index = dataSource.indexPath(for: targetID) else {
      pendingScroll = (id, anchor, animated)
      return
    }
    collection.layoutIfNeeded()
    guard let attributes = layout.layoutAttributesForItem(at: index) else { return }
    let insets = collection.adjustedContentInset
    let minimum = -insets.top
    let maximum = max(
      minimum, collection.contentSize.height - collection.bounds.height + insets.bottom)
    let requested =
      anchor == .bottom
      ? attributes.frame.maxY - collection.bounds.height + insets.bottom
      : attributes.frame.minY - insets.top
    let y = min(maximum, max(minimum, requested))
    guard abs(y - collection.contentOffset.y) > 0.5 else {
      if animatesScroll {
        collection.setContentOffset(collection.contentOffset, animated: false)
        scrollingEnded()
      }
      publishMetrics()
      return
    }
    let interruptedAnimation = animatesScroll && !animated
    animatesScroll = animated
    if animated { source.phaseChanged(.animating) }
    collection.setContentOffset(CGPoint(x: 0, y: y), animated: animated)
    if interruptedAnimation { scrollingEnded() } else if !animated { publishMetrics() }
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
    pendingScroll = nil
    animatesScroll = false
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
    animatesScroll = false
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
    guard !stopped, !publishesMetrics else { return }
    publishesMetrics = true
    // Delegate callbacks can also occur during a SwiftUI updateUIViewController pass.
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped else { return }
      publishesMetrics = false
      // A width/font transition can change mounted marker geometry before its
      // measured snapshot commits. Keep the previous reading position until then.
      guard
        displayedRows.isEmpty
          || (displayedWidth == collection.bounds.width
            && displayedCategory == traitCollection.preferredContentSizeCategory)
      else { return }
      let insets = collection.adjustedContentInset
      let metrics = ConversationCollectionMetrics(
        height: collection.contentSize.height, offset: collection.contentOffset.y,
        isNearTop: collection.contentOffset.y + insets.top < 100,
        isAwayFromBottom: collection.contentSize.height + insets.bottom - collection.bounds.maxY
          > 20)
      guard metrics != lastMetrics else { return }
      lastMetrics = metrics
      source.metricsChanged(metrics)
    }
  }

  private func observeHeight(
    _ height: CGFloat, row: ConversationCollectionRow, width: CGFloat,
    category: UIContentSizeCategory, environment: ConversationHeightDiskCache.Layout
  ) {
    guard !stopped, height.isFinite, height > 0, width == collection.bounds.width,
      let measurement = measurements[row.id], measurement.row == row, measurement.width == width,
      measurement.category == category, measurement.environment == environment
    else { return }
    let renderedHeight = Measurer.pixelHeight(height, scale: traitCollection.displayScale)
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

  private func applyObservedHeights() {
    guard !isScrolling, !appliesRows else { return }
    let atBottom =
      source.followsBottom
      || collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY <= 20
    var changed: [String] = []
    var corrected: [ConversationHeightDiskCache.Key: Double] = [:]
    for (id, observed) in observedHeights where resizeTasks[id] == nil {
      if let previous = measurements[id], previous.row == observed.row,
        previous.width == observed.width, previous.category == observed.category,
        abs(previous.height - observed.height) > 0.5
      {
        measurements[id]?.height = observed.height
        if let measurement = measurements[id] {
          source.measurements.store(measurement)
          if let key = measurement.diskKey,
            key.layout == Measurer.diskLayout(width: measurement.width, traits: traitCollection)
          {
            corrected[key] = measurement.height
          }
        }
        changed.append(id)
      }
    }
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
