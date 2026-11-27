import Foundation
import Observation
import SwiftUI

/// The first message is visible while its server-owned conversation is being created.
@MainActor @Observable
final class NewChatSubmission {
  let message: ConversationStore.PendingMessage
  let composer: ComposerDraftStore
  let viewer: MessageAttachmentStore
  let transition: ConversationSendTransition
  var isReadyForConversation = false { didSet { finishIfReady() } }
  private var isConversationPresented = false
  private var closed = false
  @ObservationIgnored private var presentationWaiters: [CheckedContinuation<Void, Never>] = []

  var isPresenting: Bool {
    !closed
      && (!isReadyForConversation || !isConversationPresented || transition.hidesBubbleID != nil)
  }

  init(
    message: ConversationStore.PendingMessage, composer: ComposerDraftStore,
    viewer: MessageAttachmentStore, transition: ConversationSendTransition
  ) {
    self.message = message
    self.composer = composer
    self.viewer = viewer
    self.transition = transition
    transition.didEnd = { [weak self] in self?.finishIfReady() }
  }

  func presentMessage(_ id: String) {
    guard !closed, id == message.id else { return }
    isConversationPresented = true
    finishIfReady()
  }

  func waitUntilPresented() async {
    guard !closed, isReadyForConversation, isPresenting else { return }
    await withCheckedContinuation { presentationWaiters.append($0) }
  }

  private func finishIfReady() {
    guard !isPresenting else { return }
    let waiters = presentationWaiters
    presentationWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  func close() {
    guard !closed else { return }
    closed = true
    transition.cancel()
    finishIfReady()
    composer.close()
    viewer.close()
  }
}

struct NewChatSubmissionView: View {
  let submission: NewChatSubmission
  let conversation: ConversationStore?
  let webURL: URL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        UserMessageView(
          message: submission.message.message, webURL: webURL, viewer: submission.viewer,
          loadsAttachments: true, voicePlayback: submission.composer.voicePlayback,
          sendTransition: submission.transition
        ) {
          if submission.isReadyForConversation, let conversation {
            ConversationSendingIndicator(
              messageID: submission.message.id, conversation: conversation)
          } else {
            UserMessageSendingIndicator(sentAt: submission.message.createdAt)
          }
        }
        .padding(.horizontal, ConversationCollectionRow.messageHorizontalInset)
        .padding(.top, OkouSpace.xl)
        ConversationFooterView(
          state: .running, showsAvatar: true, avatarMotion: .animated,
          sendTransition: submission.transition)
      }
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.top, for: .alignment)
    .onDisappear { submission.transition.cancel() }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      let composer = submission.composer
      ChatComposerView(
        isBusy: true, showsProgress: true, canStop: false,
        needsUpgrade: false, error: nil, attachmentURL: webURL,
        draftState: composer,
        submit: {}, refresh: nil
      )
      .disabled(true)
    }
    .messageAttachmentPreview(viewer: submission.viewer)
  }
}
