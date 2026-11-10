#if DEBUG
  import ChatData
  import ChatDomain
  import SwiftUI
  import Synchronization

  /// On-demand native acceptance uses production cards and an isolated HTTP boundary.
  struct ComputerAuthorizationGallery: View {
    @State private var preview = Result { try ComputerAuthorizationPreview() }

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          Text(verbatim: "Local preview · No computer access is granted")
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          switch preview {
          case .success(let preview):
            ForEach(preview.cards, id: \.action) { card in
              ComputerAuthorizationCard(store: card, loadsState: true)
            }
          case .failure(let error):
            Text(verbatim: error.localizedDescription)
          }
        }
        .padding(OkouControl.pageInset)
      }
      .background(OkouColor.background)
      .navigationTitle(Text(verbatim: "Computer access cards"))
      .navigationBarTitleDisplayMode(.inline)
      .onDisappear { if case .success(let preview) = preview { preview.close() } }
    }
  }

  @MainActor private final class ComputerAuthorizationPreview {
    let cards: [ComputerAuthorizationStore]
    private let session: URLSession
    private let host: String

    init() throws {
      host = UUID().uuidString.lowercased() + ".access-preview.invalid"
      guard let origin = URL(string: "https://" + host) else { throw APIClientError.invalidURL }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [ComputerAuthorizationPreviewTransport.self]
      session = URLSession(configuration: configuration)
      let client = APIClient(baseURL: origin, clientVersion: "1.0.0", session: session) {
        "local-preview"
      }
      let sync = ChatSync(client: client)
      let commands = ChatCommands(client: client, sync: sync)
      let thread = ChatThread(
        id: ComputerAuthorizationPreviewTransport.threadID,
        agentID: "72000000-0000-4000-8000-000000000001", title: "Preview",
        createdAt: .now, updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
      cards = try [
        "/computer-use/authorize/preview_computer",
        "/browser/authorize/preview_browser",
        "/computer-use/shell/authorize/72000000-0000-4000-8000-000000000003",
      ].map { path in
        guard
          let action = ChatComputerAuthorizationAction.parse(
            path, webURL: origin, threadID: thread.id)
        else { throw APIClientError.invalidURL }
        let card = ComputerAuthorizationStore(
          action: action, thread: thread, commands: commands, sync: sync,
          didFail: { _ in }, didContinue: {})
        card.activate()
        return card
      }
    }

    func close() {
      for card in cards { card.close() }
      session.invalidateAndCancel()
      ComputerAuthorizationPreviewTransport.retire(host: host)
    }
  }

  // URLProtocol's SDK conformance is unchecked; preview state is isolated behind Mutex.
  private final class ComputerAuthorizationPreviewTransport: URLProtocol, @unchecked Sendable {
    static let threadID = "72000000-0000-4000-8000-000000000002"
    private static let states = Mutex<[String: [String: String]]>([:])

    static func retire(host: String) { _ = states.withLock { $0.removeValue(forKey: host) } }

    override class func canInit(with request: URLRequest) -> Bool {
      request.url?.host()?.hasSuffix(".access-preview.invalid") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      guard let url = request.url, let host = url.host(),
        url.path.contains("/authorization-requests/") || url.path.contains("/authorizations/")
      else {
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
        return
      }
      let isShell = url.path.contains("/shell/")
      let isBrowser = url.path.contains("/browser/")
      let key = isShell ? "shell" : isBrowser ? "browser" : "computer"
      let status = Self.states.withLock { states in
        if request.httpMethod == "POST" {
          states[host, default: [:]][key] =
            url.path.hasSuffix("/deny")
            ? "denied"
            : url.path.hasSuffix("/revoke") ? "revoked" : "approved"
        }
        return states[host]?[key] ?? "pending"
      }
      let common =
        "\"id\":\"72000000-0000-4000-8000-000000000003\",\"chatThreadId\":\"\(Self.threadID)\""
      let hostID = "72000000-0000-4000-8000-000000000004"
      let expiry = "2099-01-01T00:00:00Z"
      let completion = status == "approved" ? "\"2026-11-10T00:00:00Z\"" : "null"
      let body: String
      if isShell {
        body =
          "{\(common),\"computerUseHostId\":\"\(hostID)\",\"computerName\":\"Preview Mac\",\"reason\":\"Build the iOS app and take a screenshot on Preview Mac.\",\"status\":\"\(status)\",\"approvalBlockedReason\":null,\"requestExpiresAt\":\"\(expiry)\",\"grantExpiresAt\":\"\(expiry)\"}"
      } else if isBrowser {
        body =
          "{\(common),\"expiresAt\":\"\(expiry)\",\"completedAt\":\(completion),\"cloudBrowserEnabled\":\(status == "approved")}"
      } else {
        body =
          "{\(common),\"source\":\"chat\",\"expiresAt\":\"\(expiry)\",\"completedAt\":\(completion),\"computerUseHostId\":\"\(hostID)\",\"hosts\":[{\"id\":\"\(hostID)\",\"displayName\":\"Preview Mac\",\"status\":\"online\"}]}"
      }
      guard
        let response = HTTPURLResponse(
          url: url, statusCode: 200, httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"])
      else {
        client?.urlProtocol(self, didFailWithError: APIClientError.invalidResponse)
        return
      }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
  }
#endif
