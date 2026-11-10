#if DEBUG
  import SwiftUI

  /// Native previews of the production sync feedback, without starting authenticated services.
  struct ChatSyncStatusGallery: View {
    @State private var liveState: ChatSynchronizationState? = .liveUpdatesUnavailable
    @State private var updateState: ChatSynchronizationState? = .updateFailed

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.xxl) {
          Text(verbatim: "Realtime connection")
            .font(.okou(.headline))
          ChatSyncStatusView(state: liveState) { liveState = nil }

          Text(verbatim: "Chat refresh")
            .font(.okou(.headline))
          ChatSyncStatusView(state: updateState) { updateState = nil }

          Button {
            liveState = .liveUpdatesUnavailable
            updateState = .updateFailed
          } label: {
            Text(verbatim: "Show failures")
          }
          .buttonStyle(.bordered)
        }
        .padding(OkouSpace.pageInset)
      }
      .background(OkouColor.background)
      .navigationTitle(Text(verbatim: "Chat sync feedback"))
    }
  }
#endif
