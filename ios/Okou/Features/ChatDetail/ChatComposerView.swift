import SwiftUI

struct ChatComposerView: View {
  @Bindable var store: WorkspaceStore
  let thread: ChatThread?

  @FocusState private var isFocused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var draft: Binding<String> {
    if let thread {
      Binding(
        get: { store.drafts[thread.id] ?? "" },
        set: { store.drafts[thread.id] = $0 })
    } else {
      Binding(get: { store.newChatDraft }, set: { store.newChatDraft = $0 })
    }
  }

  private var hasText: Bool {
    !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var showsStop: Bool {
    guard let thread else { return false }
    return (store.histories[thread.id] ?? .empty).canStop && !hasText
  }

  private var isBusy: Bool {
    if let thread {
      return store.sendingThreads.contains(thread.id) || store.stoppingThreads.contains(thread.id)
    }
    return store.isCreating
  }

  private var attachmentURL: URL {
    if let thread { return store.webURL.appending(path: "chats/\(thread.id)") }
    return store.webURL
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let thread, let error = store.threadErrors[thread.id] {
        VStack(alignment: .leading, spacing: 6) {
          Text(error).foregroundStyle(.red)
          HStack {
            Button("Refresh") { Task { await store.loadHistory(thread.id) } }
            Spacer()
            Link("Open on web", destination: attachmentURL)
          }
        }
        .font(.caption)
        .padding(.horizontal, 12)
      } else if thread == nil, let error = store.error {
        Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal, 12)
      }

      TextField("Message Okou", text: draft, axis: .vertical)
        .font(.system(size: 16))
        .lineLimit(isFocused ? 2...6 : 1...1)
        .focused($isFocused)
        .accessibilityIdentifier("message-input")
        .padding(.leading, isFocused ? 18 : 58)
        .padding(.trailing, isFocused ? 18 : 58)
        .padding(.top, isFocused ? 17 : 15)
        .padding(.bottom, isFocused ? 62 : 15)
        .frame(minHeight: isFocused ? 116 : 54, alignment: .topLeading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: isFocused ? 28 : 30))
        .overlay(alignment: isFocused ? .bottomLeading : .leading) {
          Menu {
            Link("Attach files on the web", destination: attachmentURL)
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 22, weight: .regular))
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel("Attachments")
          .padding(.leading, 8)
          .padding(.bottom, isFocused ? 8 : 0)
        }
        .overlay(alignment: isFocused ? .bottomTrailing : .trailing) {
          Button {
            Task {
              if let thread {
                if showsStop { await store.stop(thread) } else { await store.send(in: thread) }
              } else {
                await store.sendNewChat()
              }
            }
          } label: {
            Group {
              if store.isCreating && thread == nil {
                ProgressView()
              } else {
                Image(systemName: showsStop ? "stop.fill" : "arrow.up")
              }
            }
            .font(.system(size: 18, weight: .semibold))
            .frame(width: 42, height: 42)
            .foregroundStyle(Color(uiColor: .systemBackground))
            .background(Color.primary.opacity((hasText || showsStop) ? 1 : 0.38), in: Circle())
          }
          .disabled((!hasText && !showsStop) || isBusy || store.needsUpgrade)
          .accessibilityLabel(showsStop ? "Stop" : "Send message")
          .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
          .padding(.trailing, 7)
          .padding(.bottom, isFocused ? 8 : 0)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: isFocused)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 8)
    .background(Color(uiColor: .systemBackground))
  }
}
