import SwiftUI
import UIKit

/// Opens connector authorization in the user's default browser, outside Okou.
struct ConnectorBrowserView: View {
  let ownerID: UUID?
  let url: URL?
  let onFailure: @MainActor (URL) -> Void

  private struct Request: Equatable {
    let ownerID: UUID?
    let url: URL?
  }

  var body: some View {
    Color.clear
      .task(id: Request(ownerID: ownerID, url: url)) {
        guard ownerID != nil, let url else { return }
        let opened = await UIApplication.shared.open(url, options: [:])
        guard !Task.isCancelled, !opened else { return }
        onFailure(url)
      }
  }
}
