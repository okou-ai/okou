#if DEBUG || STAGING
  import ChatData
  import ChatDomain
  import SwiftUI
  import Synchronization

  /// On-demand native acceptance renders the real transcript against an isolated HTTP boundary.
  struct SSHAuthorizationGallery: View {
    @State private var preview = Result { try SSHAuthorizationPreview() }

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          Text("Local preview · No SSH access is granted")
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          switch preview {
          case .success(let preview):
            Text(
              "The lifecycle fix is ready. Allow access to staging Mac to continue verification."
            )
            .font(.okou(.body))
            MessageBodyView(
              text: preview.message, baseURL: preview.origin, markdown: preview.markdown,
              actionContext: MessageActionContext(
                agentID: preview.thread.agentID, threadID: preview.thread.id),
              connectorActions: preview.connectors, approvals: preview.approvals, loadsActions: true
            )
          case .failure(let error):
            Text(verbatim: error.localizedDescription)
          }
        }
        .padding(OkouControl.pageInset)
      }
      .background(OkouColor.background)
      .navigationTitle("SSH access")
      .navigationBarTitleDisplayMode(.inline)
      .onDisappear { if case .success(let preview) = preview { preview.close() } }
    }
  }

  @MainActor private final class SSHAuthorizationPreview {
    let origin: URL
    let thread: ChatThread
    let approvals: ApprovalCardRegistry
    let connectors: ConnectorActionStore
    let markdown: MessageMarkdownCache
    let message: String
    private let session: URLSession
    private let host: String

    init() throws {
      host = UUID().uuidString.lowercased() + ".ssh-preview.invalid"
      guard let origin = URL(string: "https://" + host) else { throw APIClientError.invalidURL }
      self.origin = origin
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [SSHAuthorizationPreviewTransport.self]
      session = URLSession(configuration: configuration)
      let client = APIClient(baseURL: origin, clientVersion: "1.0.0", session: session) {
        "local-preview"
      }
      let sync = ChatSync(client: client)
      let commands = ChatCommands(client: client, sync: sync)
      thread = ChatThread(
        id: SSHAuthorizationPreviewTransport.threadID,
        agentID: "74000000-0000-4000-8000-000000000001", title: "SSH preview",
        createdAt: .now, updatedAt: .now, sortAt: .now, pinnedAt: nil, pinOrder: nil)
      approvals = ApprovalCardRegistry(
        thread: thread, commands: commands, sync: sync, didFail: { _ in }, didContinue: {})
      connectors = ConnectorActionStore(
        service: commands.connectorActions, commands: commands, thread: thread,
        didContinue: {}, didFail: { _ in })
      markdown = MessageMarkdownCache(baseURL: origin)
      let ids = (3...5).map { "74000000-0000-4000-8000-00000000000\($0)" }
      message = ids.map { "\(origin.absoluteString)/ssh/authorize/\($0)" }.joined(separator: "\n\n")
      approvals.activate()
    }

    func close() {
      approvals.close()
      session.invalidateAndCancel()
      SSHAuthorizationPreviewTransport.retire(host: host)
    }
  }

  // URLProtocol's SDK conformance is unchecked; the preview's state is protected by Mutex.
  private final class SSHAuthorizationPreviewTransport: URLProtocol, @unchecked Sendable {
    static let threadID = "74000000-0000-4000-8000-000000000002"
    private static let states = Mutex<[String: [String: String]]>([:])

    static func retire(host: String) { _ = states.withLock { $0.removeValue(forKey: host) } }

    override class func canInit(with request: URLRequest) -> Bool {
      request.url?.host()?.hasSuffix(".ssh-preview.invalid") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      guard let url = request.url, let host = url.host(),
        url.path.hasPrefix("/api/ssh/authorizations/")
      else {
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
        return
      }
      let parts = url.path.split(separator: "/")
      guard parts.count == 4 || parts.count == 5, UUID(uuidString: String(parts[3])) != nil else {
        client?.urlProtocol(self, didFailWithError: APIClientError.invalidURL)
        return
      }
      let id = String(parts[3])
      let continuation = id.hasSuffix("4")
      let blocked = id.hasSuffix("5")
      let status = Self.states.withLock { states in
        if request.httpMethod == "POST" {
          states[host, default: [:]][id] = url.path.hasSuffix("/revoke") ? "revoked" : "approved"
        }
        return states[host]?[id] ?? (continuation ? "approved" : "pending")
      }
      let pending = continuation && Self.states.withLock { $0[host]?[id] == nil }
      let blocker = blocked ? "\"permissions_required\"" : "null"
      let permissions =
        blocked ? "[{\"connectorSlug\":\"example-connector\",\"permission\":\"read\"}]" : "[]"
      let body = """
        {"id":"\(id)","chatThreadId":"\(Self.threadID)",
        "connectionId":"74000000-0000-4000-8000-000000000006",
        "displayName":"staging Mac","username":"staging","host":"mac.example.com","port":22,
        "reason":"Compile the iOS app and run lint and regression tests on staging Mac.",
        "status":"\(status)","requestExpiresAt":"2099-01-01T00:00:00Z",
        "enabled":\(status == "approved"),"continuationPending":\(pending),
        "approvalBlockedReason":\(blocker),"requiredPermissions":\(permissions)}
        """
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
