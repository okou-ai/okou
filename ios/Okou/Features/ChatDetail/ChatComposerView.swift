import CCStateSwiftUI
import ChatData
import ChatDomain
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The draft, its uploads and its voice input are read from the composer's CCState graph.
struct ChatComposerView: View {
  let isBusy: Bool
  let showsProgress: Bool
  let canStop: Bool
  let needsUpgrade: Bool
  let error: String?
  let attachmentURL: URL
  let draftState: ComposerDraftStore
  let submit: @MainActor () async -> Void
  let refresh: (@MainActor () async -> Void)?

  var stopRun: (@MainActor () async -> Void)?
  var modelSelection: ChatModelSelectionStore?
  var connectorSelection: ComposerConnectorStore?
  var mentionSource: ComposerMentionSource?
  var workflowSource: ComposerWorkflowSource?

  var sendTransition: ConversationSendTransition?
  /// Writes a direction for a For you card rather than a chat message. The card stands above
  /// the input as its context, so the input stays open; the card's own files are not the
  /// member's content; and the page sets the input's width.
  var writesDirection = false
  var placeholder = ""
  var recommendedFollowup: String?
  var showsTrailingFeedbackInput = false
  var project: ChatProject?
  var removeProject: (() -> Void)?

  /// The workspace root provides the session Store that keeps the composer's graph.
  var body: some View { ChatComposerContent(configuration: self) }
}

private struct ChatComposerContent: View {
  let configuration: ChatComposerView
  @ResolvedValue private var draftPresentation: ComposerDraftPresentation?
  @ResolvedValue private var resolvedModels: ChatModelSelectionStore.Presentation??
  /// The connector choices' writes, which gate sending, kept in the session Store.
  @ResolvedValue private var resolvedConnectors: ComposerConnectorStore.Status?

  init(configuration: ChatComposerView) {
    self.configuration = configuration
    _draftPresentation = ResolvedValue(configuration.draftState.presentation)
    _resolvedModels = ResolvedValue(
      ChatModelSelectionStore.presentation(of: configuration.modelSelection))
    _resolvedConnectors = ResolvedValue(
      ComposerConnectorStore.status(
        of: configuration.connectorSelection ?? configuration.modelSelection?.connectors))
  }

  private var isBusy: Bool { configuration.isBusy }
  private var showsProgress: Bool { configuration.showsProgress }
  private var canStop: Bool { configuration.canStop }
  private var needsUpgrade: Bool { configuration.needsUpgrade }
  private var error: String? { configuration.error }
  private var attachmentURL: URL { configuration.attachmentURL }
  private var draftState: ComposerDraftStore { configuration.draftState }
  private var attachments: AttachmentDraftStore { configuration.draftState.attachments }
  private var submit: @MainActor () async -> Void { configuration.submit }
  private var refresh: (@MainActor () async -> Void)? { configuration.refresh }
  private var modelSelection: ChatModelSelectionStore? { configuration.modelSelection }
  private var connectorSelection: ComposerConnectorStore? { configuration.connectorSelection }
  private var mentionSource: ComposerMentionSource? { configuration.mentionSource }
  private var workflowSource: ComposerWorkflowSource? { configuration.workflowSource }
  private var sendTransition: ConversationSendTransition? { configuration.sendTransition }
  private var writesDirection: Bool { configuration.writesDirection }
  private var showsTrailingFeedbackInput: Bool { configuration.showsTrailingFeedbackInput }
  private var project: ChatProject? { configuration.project }
  private var removeProject: (() -> Void)? { configuration.removeProject }
  /// This render's graph value. The synchronous read only covers a missing first resolution.
  private var current: ComposerDraftPresentation {
    draftPresentation ?? draftState.currentPresentation
  }
  /// The model selection's graph value for this render, with the same fallback.
  private var models: ChatModelSelectionStore.Presentation? {
    resolvedModels ?? modelSelection?.presentation
  }
  /// The connector choices' graph value for this render, with the same fallback.
  private var connectors: ComposerConnectorStore.Status {
    resolvedConnectors
      ?? (connectorSelection ?? modelSelection?.connectors)?.status
      ?? ComposerConnectorStore.Status()
  }
  /// The model selection's part of send admission; a composer without one is not gated.
  private var modelsAllowSending: Bool {
    guard modelSelection != nil, let models else { return true }
    return models.canSend && connectors.canSend
  }

  @State private var isFocused = false
  @State private var showsPhotos = false
  @State private var showsFiles = false
  @State private var showsConnectors = false
  @State private var showsModels = false
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @State private var showsCamera = false
  @State private var showsAddSheet = false
  /// What "Add to chat" asked for; the composer opens it once the sheet has gone.
  @State private var pendingAdd: ComposerAddAction?
  @State private var showsScanner = false
  @State private var sendFeedback = 0
  @State private var stopFeedback = 0
  @State private var mountedVoice: ComposerVoiceInputStore?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.newChatActivation) private var newChatActivation
  @Environment(\.workspaceChatPresentation) private var presentation
  private let actionSize = OkouControl.minimumTarget

  private var hasText: Bool {
    !current.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  private var hasContent: Bool {
    if writesDirection {
      return hasText
        || current.draft.document.parts.contains {
          $0["type"]?.string != "text" && ComposerAttributedDocument.isInline($0)
        }
    }
    return hasText || current.attachments.hasAttachments || current.hasContent
  }
  private var canPerformPrimaryAction: Bool {
    (hasContent || showsStop) && current.attachments.isReady && !isBusy && !needsUpgrade
      && !voiceActive && current.canSend
      && (showsStop || modelsAllowSending)
  }
  private var showsEditingLayout: Bool {
    isFocused || current.draft.focusRequest != nil
      || presentation?.keepsComposerExpanded == true
  }
  private var focusAnimation: Animation? {
    guard !reduceMotion, presentation?.isTransitioning != true,
      presentation?.allowsFocus != false
    else { return nil }
    return sendTransition?.composerAnimation ?? .easeInOut(duration: 0.22)
  }
  /// A draft keeps the open layout after the keyboard closes; collapsing it cut the text to
  /// one truncated line under the controls. Voice input opens it too, and the model sheet
  /// keeps it open while the keyboard is down under the sheet.
  private var hasMultipleVoiceParts: Bool {
    current.draft.document.parts.lazy.filter { $0["type"]?.string == "voice" }.prefix(2).count == 2
  }

  private var expandsInput: Bool {
    writesDirection || showsEditingLayout || hasText || hasMultipleVoiceParts
      || current.draft.document.hasFeedback || (voiceActive && hasContent) || showsModels
  }
  private var showsStop: Bool { canStop && !hasContent }
  private var voiceActive: Bool {
    guard let phase = current.voicePhase else { return false }
    return phase == .recording || phase == .processing || phase == .saved
  }
  private var usesFollowupPlaceholder: Bool {
    models?.snapshot.usesFollowupPlaceholder == true
  }
  private var visibleFollowup: String? {
    guard !canStop, !voiceActive, usesFollowupPlaceholder, current.text.isEmpty, !hasContent,
      !isBusy, !needsUpgrade,
      current.canSend, let followup = configuration.recommendedFollowup,
      !followup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    return followup
  }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      Group {
        if let project {
          OkouBanner(Text(verbatim: project.name), icon: "folder", dismiss: removeProject)
            .accessibilityLabel("Project: \(project.name)")
            .disabled(isBusy || needsUpgrade)
        }
        if let voice = draftState.voice, current.voiceHasError {
          ComposerVoiceInputNotice(voice: voice)
            .transition(reduceMotion ? .identity : .move(edge: .bottom).combined(with: .opacity))
        }
        // Every notice above the composer is the same quiet banner (OkouBanner): one footnote
        // sentence, its actions as text buttons, a ✕ where the reader can dismiss it.
        if !current.draft.document.isSupported {
          OkouBanner(
            Text("This draft contains content this app cannot edit. Open it on the web."),
            icon: "file-warning", tone: .problem
          ) {
            Link("Open on web", destination: attachmentURL)
          }
        }
        let contextLabels = ChatDraftDocument(
          parts: current.draft.document.parts.filter { !ComposerAttributedDocument.isInline($0) }
        ).contextLabels
        if !contextLabels.isEmpty {
          Text(contextLabels.joined(separator: " · "))
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground).lineLimit(3)
            .padding(.horizontal, OkouSpace.md)
            .accessibilityLabel("Saved context: " + contextLabels.joined(separator: ", "))
        }
        if let draftError = current.error,
          current.draft.document.isSupported || current.hasLocalFailure
            || current.status.conflictingRemote != nil
        {
          OkouBanner(Text(draftError), icon: "circle-alert", tone: .problem) {
            if current.status.conflictingRemote != nil {
              Button("Keep this draft") { draftState.keepLocal() }
              Button("Use other device's draft") { draftState.useRemote() }
            } else if current.hasLocalFailure {
              Button("Copy draft text") { UIPasteboard.general.string = draftState.text }
                .disabled(current.text.isEmpty)
              Button("Save on this device") { draftState.retryLocalSave() }
                .disabled(!current.canRetryLocalSave)
            } else {
              Button("Retry draft sync") { Task { await draftState.synchronize() } }
            }
          }
        }
        if let warning = current.status.syncWarning {
          OkouBanner(Text(warning), icon: "refresh-cw") {
            Button("Sync draft") { Task { await draftState.synchronize() } }
          }
        }
        if current.attachments.hasAttachments {
          ChatAttachmentChips(
            draft: attachments, content: current.attachments, isDisabled: isBusy || needsUpgrade)
        }
        if let importError = current.attachments.error {
          OkouBanner(
            Text(importError), icon: "circle-alert", tone: .problem,
            dismiss: { attachments.error = nil })
        }
        if let error {
          OkouBanner(Text(error), icon: "circle-alert", tone: .problem) {
            if let refresh {
              Button("Refresh") { Task { await refresh() } }
              Link("Open on web", destination: attachmentURL)
            }
          }
        }
      }
      .chatFeedbackContentAnchor()

      let inputID = current.attachments.inputID
      VStack(alignment: .trailing, spacing: 0) {
        // Retired native editors must leave immediately. Fading a first responder
        // through a draft reset can restart keyboard avoidance during the send flight.
        let followup = visibleFollowup
        OkouComposerSurface(
          isExpanded: voiceActive ? hasContent : expandsInput,
          compactTrailingCount: draftState.voice == nil ? 1 : 2,
          showsBottomBar: voiceActive
        ) {
          ZStack(alignment: .topLeading) {
            textInput(id: inputID, followup: followup)
              .opacity(voiceActive && !hasContent ? 0 : 1)
              .allowsHitTesting(!voiceActive)
              .accessibilityHidden(voiceActive && !hasContent)
            if expandsInput, let followup {
              followupSuggestion(followup)
            }
          }
          .accessibilityIdentifier("message-input")
        } leading: {
          HStack(spacing: 0) {
            Button {
              showsAddSheet = true
            } label: {
              OkouToolbarIcon("plus")
                .frame(width: actionSize, height: actionSize)
                .contentShape(Rectangle())
                .overlay(alignment: .topTrailing) {
                  if connectorSelection != nil && connectors.uncertain {
                    OkouIcon("circle-alert", size: OkouIconSize.badge)
                      .foregroundStyle(OkouStatusColor.warning)
                  }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add attachments and tools")
            .accessibilityValue(
              connectorSelection != nil && connectors.uncertain
                ? "Confirm connector settings before sending" : ""
            )
            .disabled(isBusy || needsUpgrade)
          }
        } trailing: {
          trailingActions
        } bottomBar: {
          if voiceActive, let voice = draftState.voice {
            ComposerVoiceInputTray(
              voice: voice, canSend: canSendRecording,
              send: { await submit() })
          }
        }
        .chatFeedbackContentAnchor()
        .anchorPreference(key: ComposerSuggestionPresentation.self, value: .bounds) { bounds in
          let editor = draftState.editor
          let content: ComposerSuggestionPresentation.Content
          if editor.workflows.query != nil {
            content = .workflows(editor.workflows)
          } else if editor.mentionQuery != nil {
            content = .chats(editor, mentionSource)
          } else {
            return nil
          }
          return ComposerSuggestionPresentation.Presentation(
            bounds: bounds, content: content, isDisabled: isBusy || needsUpgrade)
        }
      }
      .animation(focusAnimation, value: isFocused)
      .animation(
        !reduceMotion && sendTransition?.hidesBubbleID != nil
          ? sendTransition?.composerAnimation : nil,
        value: hasText
      )
      .animation(focusAnimation, value: hasMultipleVoiceParts)
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: voiceActive)
    .padding(.horizontal, writesDirection ? 0 : OkouControl.pageInset)
    .padding(.top, OkouSpace.sm)
    .padding(.bottom, showsEditingLayout ? OkouSpace.sm : OkouSpace.six)
    .fixedSize(horizontal: false, vertical: true)
    .sensoryFeedback(.impact(weight: .light), trigger: sendFeedback)
    .sensoryFeedback(.impact(weight: .medium), trigger: stopFeedback)
    .sensoryFeedback(.error, trigger: error) { _, new in new != nil }
    .onChange(of: connectorSelection.map(ObjectIdentifier.init), initial: true) { _, _ in
      showsConnectors = false
    }
    .sheet(isPresented: $showsAddSheet, onDismiss: openPendingAdd) {
      ComposerAddSheet(
        attachments: attachments, connectorSelection: connectorSelection,
        clearDraft: clearDraftAction
      ) { action in
        pendingAdd = action
        showsAddSheet = false
      }
    }
    .sheet(isPresented: $showsModels) {
      if let modelSelection { ChatModelPickerView(selection: modelSelection) }
    }
    .sheet(isPresented: $showsConnectors) {
      if let connectorSelection {
        ComposerConnectorSheet(store: connectorSelection)
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
          .okouSheetBackground()
      }
    }
    // Model settings decide whether the draft can be sent, so a mounted composer loads them
    // while the reader types; the open composer's model control shows what they resolve to.
    .task(id: modelSelection.map { ObjectIdentifier($0) }) {
      await modelSelection?.open()
    }
    .onChange(
      of: workflowSource?.id, initial: true
    ) { _, _ in
      draftState.editor.workflows.configure(source: workflowSource)
    }
    .onChange(of: ObjectIdentifier(draftState), initial: true) { _, _ in
      mountedVoice?.suspend()
      mountedVoice = draftState.voice
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .background { mountedVoice?.suspend() }
    }
    .onChange(of: newChatActivation) { _, _ in
      pendingAdd = nil
      showsAddSheet = false
      showsConnectors = false
      showsModels = false
      showsCamera = false
      showsScanner = false
      showsPhotos = false
      showsFiles = false
    }
    .onDisappear {
      draftState.editor.workflows.dismiss()
      mountedVoice?.suspend()
    }
    .fullScreenCover(isPresented: $showsCamera) {
      ComposerCamera { url in attachments.importFiles([url]) }
        .ignoresSafeArea()
    }
    .fullScreenCover(isPresented: $showsScanner) {
      ComposerDocumentScanner { url in attachments.importFiles([url]) }
        .ignoresSafeArea()
    }
    .photosPicker(
      isPresented: $showsPhotos, selection: $selectedPhotos,
      matching: .any(of: [.images, .videos]), preferredItemEncoding: .current
    )
    .onChange(of: selectedPhotos) { _, photos in
      guard !photos.isEmpty else { return }
      attachments.importPhotos(photos)
      selectedPhotos = []
    }
    .fileImporter(
      isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
    ) {
      switch $0 {
      case .success(let urls): attachments.importFiles(urls)
      case .failure(let error): attachments.report(error)
      }
    }
  }

  private func textInput(id inputID: UUID, followup: String?) -> some View {
    ChatFeedbackComposer(
      state: draftState, presentation: current, inputID: inputID,
      isFocused: $isFocused,
      acceptsImages: !isBusy && !needsUpgrade && !voiceActive,
      placeholder: expandsInput && followup != nil ? "" : configuration.placeholder,
      followup: followup,
      showsTrailingParagraph: showsTrailingFeedbackInput,
      expanded: showsEditingLayout,
      showsFollowupPlaceholder: !expandsInput,
      mentionSource: mentionSource
    )
    .id(inputID)
    .transition(.identity)
    .disabled(!current.draft.document.isSupported)
  }

  private var canSendRecording: Bool {
    !isBusy && !needsUpgrade && current.attachments.isReady && modelsAllowSending
      && draftState.canEditVoice
  }

  private func followupSuggestion(_ prompt: String) -> some View {
    var text = AttributedString(prompt + " ")
    var action = AttributedString(String(localized: "Accept"))
    action.link = URL(string: "okou-followup:accept")
    action.foregroundColor = OkouColor.foreground
    text.append(action)
    let accept = OpenURLAction { _ in
      draftState.editor.acceptFollowup(prompt)
      return .handled
    }
    return Text(text)
      .font(.okou(.body))
      .foregroundStyle(OkouColor.mutedForeground)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .environment(\.openURL, accept)
  }

  private var trailingActions: some View {
    HStack(spacing: OkouSpace.xs) {
      if expandsInput, let modelSelection {
        ChatModelPickerButton(selection: modelSelection, action: { showsModels = true })
          .disabled(needsUpgrade)
          .frame(width: actionSize, height: actionSize)
      }
      if let voice = draftState.voice {
        voiceInput(voice)
      }
      primaryAction
        .frame(width: actionSize, height: actionSize)
    }
  }

  private func voiceInput(_ voice: ComposerVoiceInputStore) -> some View {
    ComposerVoiceInputButton(voice: voice)
      .disabled(isBusy || needsUpgrade || voiceActive || !current.canEditVoice)
  }

  private var primaryAction: some View {
    Button(action: performPrimaryAction) {
      Group {
        if showsProgress {
          ProgressView()
            .controlSize(.small)
            .tint(showsStop ? OkouColor.interruptForeground : OkouColor.primaryForeground)
        } else if showsStop {
          OkouIcon("square", size: OkouIconSize.inline)
        } else {
          OkouToolbarIcon("arrow-up")
        }
      }
      .font(.okou(size: 16, weight: .semibold))
      .foregroundStyle(
        showsStop
          ? OkouColor.interruptForeground
          : hasContent ? OkouColor.primaryForeground : OkouColor.mutedForeground)
    }
    // A solid fill: the composer under it is already glass.
    .buttonStyle(.borderedProminent)
    .buttonBorderShape(.circle)
    // An empty draft always disables send, so it takes the system's disabled fill.
    .tint(showsStop ? OkouColor.interrupt : OkouColor.primary)
    .disabled(!canPerformPrimaryAction)
    .accessibilityLabel(showsStop ? "Stop" : "Send message")
    .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
    .frame(width: actionSize, height: actionSize)
    .contentShape(Circle())
    .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: hasContent)
  }

  private func stopRun() async {
    if let stop = configuration.stopRun {
      await stop()
    } else {
      await submit()
    }
  }

  private func performPrimaryAction() {
    guard canPerformPrimaryAction else { return }
    let stopsRun = showsStop
    Task {
      if stopsRun {
        stopFeedback += 1
        await stopRun()
      } else if hasContent {
        sendFeedback += 1
        await submit()
      }
    }
  }

  /// "Clear draft" in Add to chat, only while there is something to clear.
  private var clearDraftAction: (() -> Void)? {
    guard current.hasContent || current.error != nil else { return nil }
    let state = draftState
    return { state.clear() }
  }

  private func openPendingAdd() {
    guard let action = pendingAdd else { return }
    pendingAdd = nil
    switch action {
    case .camera: showsCamera = true
    case .photos: showsPhotos = true
    case .scan: showsScanner = true
    case .files: showsFiles = true
    case .connectors: showsConnectors = true
    }
  }
}
