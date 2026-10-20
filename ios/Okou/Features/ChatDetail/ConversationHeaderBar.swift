import SwiftUI

/// A translucent native material protects the title without hiding the history behind it.
struct ConversationHeaderBar<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    content.background {
      Rectangle()
        .fill(.ultraThinMaterial)
        .mask {
          LinearGradient(
            stops: [
              .init(color: .black, location: 0),
              .init(color: .black, location: 0.6),
              .init(color: .clear, location: 1),
            ],
            startPoint: .top, endPoint: .bottom)
        }
        .padding(.bottom, -24)
        .ignoresSafeArea(.container, edges: .top)
        .allowsHitTesting(false)
    }
  }
}
