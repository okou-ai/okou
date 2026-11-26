import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI
import Textual

struct ChatDetailView: View {
  let conversation: ConversationStore
  let workspaceName: String?
  var didSend: (@MainActor () async -> Void)?
  let topContentInset: CGFloat
  let mentionSource: ComposerMentionSource?
  let onFirstMessagePresented: (@MainActor (String) -> Void)?
  let fork: ((ChatFeedbackSelection) -> Void)?
  private var thread: ChatThread { conversation.thread }
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openURL) private var openURL
  @Environment(\.openChatSource) private var openChatSource
  @Environment(\.chatFeedbackClearance) private var feedbackClearance
  @State private var scrolling: ConversationScrollCoordinator
  @State private var composerHeight: CGFloat = 0
  @State private var activityOwner = UUID()
  @State private var usageDetails: UsageDetails?
  /// The transcript's graph value, kept in the workspace session's Store.
  @ResolvedValue private var resolvedTranscript: ConversationProjection.Value?
  /// Send, Stop and failure state, kept in the workspace session's Store.
  @ResolvedValue private var resolvedDelivery: ConversationStore.Delivery?
  /// Whether a failure recovery is running, kept in the workspace session's Store.
  @ResolvedValue private var resolvedRecovery: ConversationFailureRecovery.Recovery?
  /// The render window and the scroll target, kept in the workspace session's Store.
  @ResolvedValue private var resolvedWindow: ConversationPresentation.Window?
  @ResolvedValue private var resolvedNavigation: ConversationPresentation.Navigation?
  /// History and read-mark synchronization, kept in the workspace session's Store.
  @ResolvedValue private var resolvedSync: ConversationPresentation.SyncStatus?
  /// The model selection that failure cards and follow-ups read, kept in the same Store.
  @ResolvedValue private var resolvedModels: ChatModelSelectionStore.Presentation??

  private struct UsageDetails: Identifiable { let id: String }

  init(
    conversation: ConversationStore, workspaceName: String? = nil,
    didSend: (@MainActor () async -> Void)? = nil,
    topContentInset: CGFloat = 0,
    mentionSource: ComposerMentionSource? = nil,
    onFirstMessagePresented: (@MainActor (String) -> Void)? = nil,
    fork: ((ChatFeedbackSelection) -> Void)? = nil
  ) {
    self.conversation = conversation
    self.workspaceName = workspaceName
    self.didSend = didSend
    self.topContentInset = topContentInset
    self.mentionSource = mentionSource
    self.onFirstMessagePresented = onFirstMessagePresented
    self.fork = fork
    _scrolling = State(initialValue: ConversationScrollCoordinator(conversation: conversation))
    _resolvedTranscript = ResolvedValue(conversation.transcript)
    _resolvedDelivery = ResolvedValue(conversation.delivery)
    _resolvedRecovery = ResolvedValue(conversation.failureRecoveryActions.recovery)
    _resolvedWindow = ResolvedValue(conversation.window)
    _resolvedNavigation = ResolvedValue(conversation.navigation)
    _resolvedSync = ResolvedValue(conversation.syncStatus)
    _resolvedModels = ResolvedValue(
      ChatModelSelectionStore.presentation(of: conversation.modelSelection))
  }

  /// This render's transcript. The synchronous read only covers a missing first resolution.
  private var transcript: ConversationProjection.Value {
    resolvedTranscript ?? conversation.currentTranscript
  }
  private var history: ChatHistory { transcript.history ?? .empty }
  /// This render's delivery state, with the same fallback as the transcript.
  private var delivery: ConversationStore.Delivery {
    resolvedDelivery ?? conversation.currentDelivery
  }
  private var isRecoveringFailure: Bool {
    (resolvedRecovery ?? conversation.failureRecoveryActions.currentRecovery).isRecovering
  }
  private var rows: [ConversationCollectionRow] {
    ConversationRowProjection(
      conversation: conversation, transcript: transcript, window: window,
      isSending: delivery.isSending, models: models
    ).rows
  }

  var body: some View {
    let displayedMessages = window.items.compactMap(\.message)
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown, renderContext: renderContext,
      measurements: conversation.measurements,
      contentInsets: EdgeInsets(
        top: topContentInset, leading: 0, bottom: composerHeight, trailing: 0),
      anchor: scrolling.anchor,
      scroll: scrolling.scroll,
      followsBottom: scrolling.followsBottom,
      sendTransition: scrolling.sendTransition,
      isLoadingHistory: syncStatus.isLoading && transcript.history == nil,
      phaseChanged: scrolling.phaseChanged, metricsChanged: scrolling.metricsChanged,
      rowsPresented: { id in
        scrolling.rowsPresented(firstItemID: id)
        if let id { onFirstMessagePresented?(id) }
      },
      earlierMessages: conversation.earlierWindowMessages,
      quote: conversation.quote,
      fork: fork,
      refresh: {
        await conversation.refresh()
        await conversation.connectorActions.refreshKnown()
      },
      content: { row, anchor in
        rowContent(row, anchor: anchor).environment(\.openURL, openURL)
          .environment(\.openChatSource, openChatSource)
          .environment(\.permissionWorkspaceName, workspaceName)
      }
    )
    .ignoresSafeArea(.container, edges: .vertical)
    .overlay {
      if transcript.history == nil && syncStatus.historyError != nil {
        OkouEmptyState(
          "Unable to load chat", icon: "message-circle-warning",
          description: Text("Check your connection and try again. Your draft is still here.")
        ) {
          Button("Try again") { Task { await conversation.refresh() } }
            .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      }
    }
    .onAppear {
      scrolling.activate(reduceMotion: reduceMotion)
      conversation.setDetailVisible(true, owner: activityOwner)
    }
    .onChange(of: reduceMotion) { _, value in scrolling.setReduceMotion(value) }
    .overlay(alignment: .bottom) {
      ZStack {
        if showsBottomButton {
          Button {
            scrolling.jumpToLatest()
          } label: {
            // The same 44 pt glass circle as the header's controls.
            OkouToolbarIcon("arrow-down").modifier(OkouGlassControl(shape: .circle))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Scroll to bottom")
          .accessibilityIdentifier("scroll-to-bottom")
          .transition(
            reduceMotion ? .opacity : .scale(scale: 0.8).combined(with: .opacity))
        }
      }
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .animation(reduceMotion ? nil : OkouMotion.press, value: showsBottomButton)
      .allowsHitTesting(showsBottomButton)
      .padding(.bottom, feedbackClearance + OkouSpace.sm)
    }
    .task(id: displayedMessages.last) { await scrolling.latestMessageChanged() }
    .onChange(of: window.items) { _, _ in scrolling.messagesChanged() }
    .onChange(of: navigation.readingMessageID) { previousID, id in
      scrolling.readingPositionChanged(previousID: previousID, currentID: id)
    }
    .onChange(of: navigation.request) { _, request in
      if let request { scrolling.reveal(request.position) }
    }
    .onDisappear {
      conversation.cancelSharing()
      scrolling.deactivate()
      conversation.connectorActions.cancel()
      conversation.setDetailVisible(false, owner: activityOwner)
    }
    .messageAttachmentPreview(viewer: conversation.attachmentViewer)
    .messageArtifactPreview(viewer: conversation.artifacts, markdown: conversation.messageMarkdown)
    .onChange(of: history.executionState) { _, _ in scrolling.executionStateChanged() }
    .sheet(isPresented: Bindable(conversation.sharing).showsCreatedLink) {
      ChatSharingCreatedView(sharing: conversation.sharing)
        .presentationDetents([.medium, .large])
    }
    .onChange(of: conversation.sharing.isSelecting) { _, _ in
      if let position = scrolling.scroll.captureReadingPosition() { scrolling.reveal(position) }
    }
    .sheet(item: $usageDetails) { selection in
      ConversationRunUsageDetails(
        usage: conversation.runUsage, runID: selection.id,
        catalog: conversation.modelSelection?.models.catalog,
        retry: { conversation.runUsage.retry(selection.id) }
      )
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
      .okouSheetBackground()
      .task { await conversation.modelSelection?.models.loadCatalog() }
    }
    .connectorAuthorization(
      store: conversation.connectorActions, failureTitle: "Unable to open connection"
    )
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await conversation.connectorActions.refreshKnown() } }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        if let issue = delivery.stopIssue {
          OkouBanner(Text(issue), icon: "circle-stop") {
            Button("Check status") { Task { await conversation.refresh() } }
              .disabled(syncStatus.isLoading)
            if syncStatus.historyError == nil && history.canStop {
              Button("Stop again") { Task { await conversation.stop() } }
                .disabled(delivery.isStopping)
            }
          }
          .padding(.horizontal, OkouSpace.lg)
          .padding(.bottom, OkouSpace.xs)
          .chatFeedbackContentAnchor()
        }
        if conversation.sharing.isSelecting {
          ChatSharingFooter(sharing: conversation.sharing)
            .chatFeedbackContentAnchor()
        } else {
          ChatComposerView(
            isBusy: delivery.isSending || delivery.isStopping
              || isRecoveringFailure,
            showsProgress: false, canStop: history.canStop, needsUpgrade: delivery.needsUpgrade,
            error: delivery.error,
            attachmentURL: conversation.webURL.appending(path: "chats/\(thread.id)"),
            draftState: conversation.composer,
            submit: {
              if history.canStop && !conversation.composer.hasContent {
                await conversation.stop()
              } else {
                await scrolling.send()
                await didSend?()
              }
            }, refresh: { await conversation.refresh() },
            modelSelection: conversation.modelSelection,
            connectorSelection: conversation.modelSelection?.connectors,
            mentionSource: mentionSource,
            workflowSource: conversation.workflowSource,
            sendTransition: scrolling.sendTransition,
            recommendedFollowup: transcript.recommendedFollowups?.followups.first?.prompt
          )
        }
      }
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        composerHeight = $0
      }
      .chatFeedbackAnchor()
    }
    .modifier(
      ComposerVoiceAnimation(
        voice: conversation.composer.voice,
        animation: reduceMotion ? nil : .easeInOut(duration: 0.22))
    )
    .task(id: thread.id) { await conversation.refresh() }
  }

  private func renderContext(_ message: ChatMessage) -> MessageRenderPlan.Context {
    let assistant = message.role == .assistant
    return .init(
      webURL: conversation.webURL,
      action: assistant ? .init(threadID: thread.id) : nil,
      permissionMember: conversation.permissionActions.member,
      artifacts: assistant ? conversation.artifacts : nil)
  }

  @ViewBuilder
  private func rowContent(_ row: ConversationCollectionRow, anchor: ConversationScrollAnchor?)
    -> some View
  {
    switch row {
    case .share(let group, let topSpacing):
      ChatSharingRow(group: group, sharing: conversation.sharing) {
        VStack(alignment: .leading, spacing: OkouSpace.sm) {
          ForEach(Array(group.messages.enumerated()), id: \.element.id) { index, message in
            messageRow(
              message, pendingRetry: nil, isSending: false,
              presentation: MessageRowPresentation(
                showsAvatar: index == 0, isWorkHistory: false, showsActions: false,
                loadsAttachments: anchor != nil))
          }
        }
      }
      .background {
        if let anchor { ConversationRowAnchor(messageID: group.id, anchor: anchor) }
      }
      .padding(.horizontal, ConversationCollectionRow.messageHorizontalInset)
      .padding(.top, topSpacing)
    case .failure(let message, let state, let topSpacing, let providerMessage):
      AssistantFailureRecoveryCard(
        failure: state.failure, conversation: conversation, providerMessage: providerMessage
      )
      .background {
        if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .followups(let source, let finishedAt):
      RecommendedFollowupList(
        source: source, finishedAt: finishedAt,
        select: conversation.composer.editor.selectOrAppendText
      )
      .padding(.top, OkouSpace.xxl)
    case .earlier:
      ConversationEarlierMessagesButton(conversation: conversation, scrolling: scrolling)
    case .work(let section, let expanded, let showsAvatar, let topSpacing, let failed):
      // The avatar shares the work summary's line instead of taking a line of its own.
      HStack(spacing: OkouSpace.sm) {
        if showsAvatar { assistantAvatar }
        ConversationWorkHeader(section: section, expanded: expanded, failed: failed) {
          scrolling.toggleWorkHistory(section.id)
        }
      }
      .padding(.leading, showsAvatar ? 0 : OkouSpace.six)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if let anchor { ConversationRowAnchor(messageID: section.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .message(
      let message, let showsAvatar, let topSpacing, let pendingRetry, let isSending,
      let isWorkHistory, let showsActions):
      messageRow(
        message, pendingRetry: pendingRetry, isSending: isSending,
        presentation: MessageRowPresentation(
          showsAvatar: showsAvatar, isWorkHistory: isWorkHistory, showsActions: showsActions,
          loadsAttachments: anchor != nil)
      )
      .background {
        if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
      }
      .padding(
        EdgeInsets(
          top: topSpacing, leading: ConversationCollectionRow.messageHorizontalInset,
          bottom: 0, trailing: ConversationCollectionRow.messageHorizontalInset))
    case .footer(let executionState, let showsAvatar):
      VStack(alignment: .leading, spacing: OkouSpace.xxl) {
        if executionState.isActive {
          HStack(spacing: OkouSpace.sm) {
            if showsAvatar { assistantAvatar }
            ConversationActivityLabel(
              summary: conversation.activitySummary, state: executionState
            )
          }
          .padding(.leading, showsAvatar ? 0 : OkouSpace.six)
        }
        Color.clear.frame(height: 1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(EdgeInsets(top: 24, leading: 20, bottom: 20, trailing: 20))
    case .usage(let runID, let answer):
      HStack(spacing: OkouSpace.sm) {
        if let answer { messageActions(for: answer) }
        ConversationRunUsageView(
          runID: runID, usage: conversation.runUsage,
          showDetails: { usageDetails = UsageDetails(id: runID) })
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if let anchor { ConversationRowAnchor(messageID: "usage:\(runID)", anchor: anchor) }
      }
      .padding(.horizontal, ConversationCollectionRow.messageHorizontalInset + OkouSpace.six)
      .padding(.top, answer == nil ? 0 : OkouSpace.sm)
    }
  }

  private struct MessageRowPresentation {
    let showsAvatar: Bool
    let isWorkHistory: Bool
    let showsActions: Bool
    let loadsAttachments: Bool
  }

  private func messageRow(
    _ message: ChatMessage, pendingRetry: Bool?, isSending: Bool,
    presentation: MessageRowPresentation
  ) -> some View {
    Group {
      if message.role == .user {
        VStack(alignment: .trailing, spacing: OkouSpace.sm) {
          if let change = message.modelChange {
            ConversationModelChangeLabel(
              change: change, models: conversation.modelSelection?.models)
          }
          UserMessageView(
            message: message, webURL: conversation.webURL,
            viewer: conversation.attachmentViewer, loadsAttachments: presentation.loadsAttachments,
            sendTransition: presentation.loadsAttachments ? scrolling.sendTransition : nil
          ) {
            if presentation.loadsAttachments, !conversation.sharing.isSelecting {
              StoreProvider(conversation.graph) {
                ConversationSendingIndicator(messageID: message.id, conversation: conversation)
              }
            }
          }
          if pendingRetry == true { deliveryFailure(message, isSending: isSending) }
        }
      } else {
        messageContent(message, presentation: presentation)
          .textual.fontScale(presentation.isWorkHistory ? 0.9 : 1)
          .foregroundStyle(
            presentation.isWorkHistory ? OkouColor.mutedForeground : OkouColor.foreground
          )
          .padding(.leading, presentation.isWorkHistory ? 28 : 0)
          .overlay(alignment: .leading) {
            if presentation.isWorkHistory {
              Rectangle().fill(OkouColor.divider).frame(width: 1).padding(
                .leading, 14)
            }
          }
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
  }

  private var assistantAvatar: some View {
    OkouAvatar(size: OkouAvatarSize.message, label: "Okou")
      .accessibilityIdentifier("assistant-avatar")
  }

  private func messageContent(_ message: ChatMessage, presentation: MessageRowPresentation)
    -> some View
  {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      if message.role == .assistant && presentation.showsAvatar {
        assistantAvatar
          .padding(
            .leading, conversation.sharing.isSelecting ? OkouAvatarSize.message + OkouSpace.sm : 0)
      }
      if message.role == .system {
        Label(message.text, okouSymbol: message.isError ? "circle-alert" : "circle-stop")
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
          .textSelection(.enabled)
          .padding(.leading, OkouSpace.six)
      } else if !message.text.isEmpty {
        MessageBodyView(
          text: message.text, baseURL: conversation.webURL, markdown: conversation.messageMarkdown,
          actionContext: message.role == .assistant
            ? MessageActionContext(threadID: thread.id) : nil,
          connectorActions: conversation.connectorActions,
          permissionActions: conversation.permissionActions,
          approvals: message.role == .assistant ? conversation.approvals : nil,
          artifacts: message.role == .assistant ? conversation.artifacts : nil,
          artifactGroup: conversation.artifactGroup(for: message.id),
          loadsActions: presentation.loadsAttachments, loadsDiagrams: presentation.loadsAttachments
        )
        .equatable()
        .foregroundStyle(
          presentation.isWorkHistory ? OkouColor.mutedForeground : OkouColor.foreground
        )
        .padding(
          .leading, message.role == .assistant ? ConversationCollectionRow.assistantLeadingInset : 0
        )
      }
      ForEach(Array(message.attachments.enumerated()), id: \.offset) { _, attachment in
        MessageAttachmentView(
          attachment: attachment, viewer: conversation.attachmentViewer,
          loadsThumbnail: presentation.loadsAttachments)
      }
      if presentation.showsActions {
        messageActions(for: message)
          .padding(.leading, OkouSpace.six)
      }
    }
  }

  private func messageActions(for message: ChatMessage) -> some View {
    MessageActionBar(
      text: message.copyText,
      chatURL: conversation.webURL.appending(path: "chats/\(thread.id)"),
      shareLink: { audience in
        let id = try await conversation.shareAnswer(message.id, audience: audience)
        return conversation.webURL.appending(path: "share/threads/\(id)")
      })
  }

  private func deliveryFailure(_ message: ChatMessage, isSending: Bool) -> some View {
    HStack {
      Text(conversation.deliveryFailureText(message.id))
        .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
      Button("Check and retry") {
        guard let pending = conversation.pending.first(where: { $0.id == message.id }) else {
          return
        }
        Task { await conversation.retry(pending) }
      }
      .font(.okou(.caption))
      .disabled(isSending)
    }
  }
}

extension ChatDetailView {
  /// This render's window and scroll target, with the same fallback as the transcript.
  private var window: ConversationPresentation.Window {
    resolvedWindow ?? conversation.currentWindow
  }
  private var navigation: ConversationPresentation.Navigation {
    resolvedNavigation ?? conversation.currentNavigation
  }
  private var syncStatus: ConversationPresentation.SyncStatus {
    resolvedSync ?? conversation.currentSyncStatus
  }
  private var models: ChatModelSelectionStore.Presentation? {
    resolvedModels ?? conversation.modelSelection?.presentation
  }
  /// The jump-to-latest control needs a displayed message as well as the reader's position.
  private var showsBottomButton: Bool {
    scrolling.isAwayFromLatest && window.items.contains { $0.message != nil }
  }
}

private struct ConversationEarlierMessagesButton: View {
  let conversation: ConversationStore
  let scrolling: ConversationScrollCoordinator

  var body: some View {
    // Transcript cells host this row outside the workspace root, so it provides the session
    // Store that keeps the render window.
    StoreProvider(conversation.graph) {
      ConversationEarlierMessagesControl(conversation: conversation, scrolling: scrolling)
    }
  }
}

private struct ConversationEarlierMessagesControl: View {
  let conversation: ConversationStore
  let scrolling: ConversationScrollCoordinator
  @ResolvedValue private var loadsEarlier: Bool?

  init(conversation: ConversationStore, scrolling: ConversationScrollCoordinator) {
    self.conversation = conversation
    self.scrolling = scrolling
    _loadsEarlier = ResolvedValue(conversation.loadsEarlier)
  }

  var body: some View {
    // Update the mounted indicator without waiting for the next measured snapshot.
    let isLoading = scrolling.isLoadingEarlier || (loadsEarlier ?? conversation.isLoadingEarlier)
    Button {
      scrolling.loadEarlierMessages()
    } label: {
      ProgressView()
        .controlSize(.small)
        .opacity(isLoading ? 1 : 0)
        .frame(maxWidth: .infinity)
        .frame(height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(isLoading)
    .accessibilityLabel(isLoading ? "Loading earlier messages" : "Load earlier messages")
    .accessibilityIdentifier("load-earlier-messages")
    .padding(.horizontal, OkouSpace.xl)
  }
}

/// Names a model change with the workspace's model names once they have loaded.
private struct ConversationModelChangeLabel: View {
  let change: ChatModelChange
  let models: ChatModelStore?

  var body: some View {
    if let models {
      // Transcript cells host this label outside the workspace root, so it provides the
      // session Store that keeps the model configuration.
      StoreProvider(models.stateStore) { NamedModelChangeLabel(change: change, models: models) }
    } else {
      Self.label(change, catalog: nil)
    }
  }

  static func label(_ change: ChatModelChange, catalog: ModelCatalog?) -> some View {
    let label: String
    switch change {
    case .model(let model):
      let name = catalog?.name(model.id) ?? model.id
      label = "Model: \(name)" + (model.isFast ? " · Fast" : "")
    case .fastMode(let enabled): label = enabled ? "Fast mode on" : "Fast mode off"
    }
    return Label(label, okouSymbol: "sliders-horizontal", iconSize: OkouIconSize.inline)
      .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground).lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

private struct NamedModelChangeLabel: View {
  let change: ChatModelChange
  let models: ChatModelStore
  @ResolvedValue private var snapshot: ChatModelStore.Snapshot?

  init(change: ChatModelChange, models: ChatModelStore) {
    self.change = change
    self.models = models
    _snapshot = ResolvedValue(models.snapshotValue)
  }

  var body: some View {
    ConversationModelChangeLabel.label(
      change, catalog: (snapshot ?? models.snapshot).configuration?.catalog)
  }
}
