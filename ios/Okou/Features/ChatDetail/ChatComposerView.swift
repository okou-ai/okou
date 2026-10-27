import ChatDomain
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatComposerView: View {
  static let compactHeight: CGFloat = 56

  @Binding var draft: String
  let isBusy: Bool
  let showsProgress: Bool
  let canStop: Bool
  let needsUpgrade: Bool
  let error: String?
  let attachmentURL: URL
  let attachments: AttachmentDraftStore
  var draftState: ComposerDraftStore? = nil
  let submit: @MainActor () async -> Void
  let refresh: (@MainActor () async -> Void)?

  var modelSelection: ChatModelSelectionStore? = nil
  var connectorSelection: ComposerConnectorStore? = nil
  var mentionSource: ComposerMentionSource? = nil
  var workflowSource: ComposerWorkflowSource? = nil
  var agentID: String? = nil
  var sendTransition: ConversationSendTransition? = nil

  @State private var isFocused = false
  @State private var showsPhotos = false
  @State private var showsFiles = false
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let actionSize: CGFloat = 44

  private var cornerRadius: CGFloat { Self.compactHeight / 2 }
  private var actionInset: CGFloat { cornerRadius - actionSize / 2 }

  private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var hasContent: Bool {
    hasText || attachments.hasAttachments || draftState?.hasContent == true
  }
  private var expandsInput: Bool { isFocused || draftState?.document.hasFeedback == true }
  private var showsStop: Bool { canStop && !hasContent }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let state = draftState {
        if !state.document.isSupported {
          Text("This draft contains content this app cannot edit. Open it on the web.")
            .font(.caption).foregroundStyle(.red)
        }
        let contextLabels = ChatDraftDocument(
          parts: state.document.parts.filter { !ComposerAttributedDocument.isInline($0) }
        ).contextLabels
        if !contextLabels.isEmpty {
          Text(contextLabels.joined(separator: " · "))
            .font(.caption).foregroundStyle(.secondary).lineLimit(3)
            .accessibilityLabel("Saved context: " + contextLabels.joined(separator: ", "))
        }
        if let draftError = state.error {
          Text(draftError).font(.caption).foregroundStyle(.red)
          if state.conflictingRemote != nil {
            HStack {
              Button("Keep this draft") { state.keepLocal() }.frame(minHeight: 44)
              Button("Use other device's draft") { state.useRemote() }.frame(minHeight: 44)
            }.font(.caption)
          } else {
            Button("Retry draft sync") { Task { await state.synchronize() } }.font(.caption)
          }
        }
      }
      if !attachments.items.isEmpty {
        ChatAttachmentChips(draft: attachments, isDisabled: isBusy || needsUpgrade)
      }
      if attachments.importingCount > 0 {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Preparing attachments…").font(.caption).foregroundStyle(.secondary)
        }
      }
      if let importError = attachments.error {
        HStack {
          Text(importError).font(.caption).foregroundStyle(.red)
          Spacer()
          Button {
            attachments.error = nil
          } label: {
            Image(systemName: "xmark")
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel("Dismiss attachment error")
        }
      }
      if let error {
        VStack(alignment: .leading, spacing: 6) {
          Text(error).foregroundStyle(.red)
          if let refresh {
            HStack {
              Button("Refresh") { Task { await refresh() } }
              Spacer()
              Link("Open on web", destination: attachmentURL)
            }
          }
        }
        .font(.caption)
        .padding(.horizontal, 12)
      }

      let inputID = attachments.inputID
      let generation = draftState?.editorGeneration
      if let editor = draftState?.editor, !editor.mentionSuggestions.isEmpty {
        ComposerMentionMenu(editor: editor, suggestions: editor.mentionSuggestions)
      }
      Group {
        if let state = draftState, state.document.hasFeedback {
          ChatFeedbackComposer(
            state: state, inputID: inputID, isFocused: $isFocused,
            acceptsImages: !isBusy && !needsUpgrade
          )
          .id(inputID)
        } else {
          ChatComposerTextInput(
            text: $draft, isFocused: $isFocused,
            acceptsImages: !isBusy && !needsUpgrade,
            isCurrent: {
              attachments.inputID == inputID && draftState?.editorGeneration == generation
            },
            pasteImages: attachments.importPastedImages,
            editor: draftState?.editor,
            document: draftState.map { state in
              Binding(
                get: { state.editorBlocks.first?.content ?? ChatDraftDocument() },
                set: { content in
                  if let block = state.editorBlocks.first {
                    state.editBlock(block.id, document: content)
                  }
                })
            },
            searchableRanges: {
              draftState?.editorBlocks.first?.searchableRanges ?? [
                NSRange(location: 0, length: draft.utf16.count)
              ]
            }
          )
          .id(inputID)
          .id(generation)
          .disabled(draftState?.document.isSupported == false)
          .onAppear {
            guard let state = draftState, let request = state.focusRequest else { return }
            isFocused = true
            state.consumeFocusRequest(request)
          }
        }
      }
      .accessibilityIdentifier("message-input")
      .padding(.leading, expandsInput ? 18 : (connectorSelection == nil ? 58 : 102))
      .padding(.trailing, expandsInput ? 18 : (modelSelection == nil ? 58 : 106))
      .padding(.top, expandsInput ? 17 : 10)
      .padding(.bottom, expandsInput ? 62 : 10)
      .frame(
        minHeight: expandsInput ? 116 : Self.compactHeight,
        alignment: expandsInput ? .topLeading : .leading
      )
      .glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius))
      .overlay(alignment: .top) {
        if let workflows = draftState?.editor.workflows, workflows.query != nil {
          ComposerWorkflowMenu(suggestions: workflows)
            .disabled(isBusy || needsUpgrade)
        }
      }
      .overlay(alignment: expandsInput ? .bottomLeading : .leading) {
        HStack(spacing: 0) {
          Menu {
            Button("Photo Library", systemImage: "photo.on.rectangle") { showsPhotos = true }
            Button("Choose Files", systemImage: "folder") { showsFiles = true }
            if let state = draftState, state.hasContent || state.error != nil {
              Divider()
              Button("Clear draft", role: .destructive) { state.clear() }
            }
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 22, weight: .regular))
              .frame(width: actionSize, height: actionSize)
          }
          .accessibilityLabel("Attachments")
          .disabled(isBusy || needsUpgrade)
          if let connectorSelection {
            ComposerConnectorButton(store: connectorSelection)
              .disabled(isBusy || needsUpgrade)
          }
        }
        .padding(.leading, actionInset)
        .padding(.bottom, expandsInput ? actionInset : 0)
      }
      .overlay(alignment: expandsInput ? .bottomTrailing : .trailing) {
        HStack(spacing: 4) {
          if let modelSelection {
            ChatModelPickerButton(selection: modelSelection)
              .disabled(isBusy || needsUpgrade)
          }
          Button {
            if !showsStop && sendTransition == nil {
              draftState?.editor.dismissKeyboard()
              isFocused = false
            }
            Task { await submit() }
          } label: {
            Group {
              if showsProgress {
                ProgressView()
                  .controlSize(.small)
                  .tint(Color(uiColor: .systemBackground))
              } else {
                Image(systemName: showsStop ? "stop.fill" : "arrow.up")
              }
            }
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 22, height: 22)
            .foregroundStyle(Color(uiColor: .systemBackground))
          }
          .buttonStyle(.glassProminent)
          .buttonBorderShape(.circle)
          .controlSize(.small)
          .tint(Color.primary)
          .disabled(
            (!hasContent && !showsStop) || !attachments.isReady || isBusy || needsUpgrade
              || draftState?.canSend == false
              || (!showsStop && modelSelection?.canSend == false)
          )
          .accessibilityLabel(showsStop ? "Stop" : "Send message")
          .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
          .frame(width: actionSize, height: actionSize)
          .contentShape(Circle())
        }
        .padding(.trailing, actionInset)
        .padding(.bottom, expandsInput ? actionInset : 0)
      }
      .animation(
        reduceMotion ? nil : sendTransition?.composerAnimation ?? .easeInOut(duration: 0.22),
        value: isFocused
      )
      .animation(
        !reduceMotion && sendTransition?.hidesBubbleID != nil
          ? sendTransition?.composerAnimation : nil,
        value: hasText)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, isFocused ? 8 : 0)
    .onChange(of: "\(agentID ?? "")/\(connectorSelection != nil)", initial: true) { _, _ in
      connectorSelection?.configure(agentID: agentID)
    }
    .onChange(of: mentionSource, initial: true) { _, source in
      draftState?.editor.mentionSource = source
    }
    .onChange(of: "\(workflowSource?.id.uuidString ?? "")/\(agentID ?? "")", initial: true) {
      _, _ in
      draftState?.editor.workflows.configure(source: workflowSource, agentID: agentID)
    }
    .onDisappear { draftState?.editor.workflows.dismiss() }
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
}
