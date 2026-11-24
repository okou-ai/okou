#if DEBUG
  import ChatData
  import Foundation
  import SwiftUI
  import Synchronization

  /// On-demand native acceptance of the For you deck: the production page against an isolated
  /// HTTP fixture, so swiping, the dock and the caught-up recap can be checked without signing
  /// in or sending read receipts to a real account. `--for-you-deck-slow` holds the first load
  /// for a few seconds and `--for-you-deck-failure` fails it, for the loading and error panels.
  struct ForYouDeckGallery: View {
    @State private var preview = Result { try ForYouDeckPreview() }

    var body: some View {
      switch preview {
      case .success(let preview):
        ForYouView(workspace: preview.workspace, showChat: {})
          .onDisappear { preview.close() }
      case .failure(let error):
        Text(verbatim: error.localizedDescription)
      }
    }
  }

  @MainActor private final class ForYouDeckPreview {
    let workspace: WorkspaceStore
    private let session: URLSession
    private let host: String

    init() throws {
      host = UUID().uuidString.lowercased() + ".for-you-preview.invalid"
      guard let origin = URL(string: "https://" + host) else { throw APIClientError.invalidURL }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [ForYouDeckPreviewTransport.self]
      session = URLSession(configuration: configuration)
      let client = APIClient(baseURL: origin, clientVersion: "1.0.0", session: session) {
        "local-preview"
      }
      workspace = WorkspaceStore(client: client, webURL: origin)
    }

    func close() {
      _ = workspace.close()
      session.invalidateAndCancel()
      ForYouDeckPreviewTransport.retire(host: host)
    }
  }

  // URLProtocol's SDK conformance is unchecked; preview state is isolated behind Mutex.
  private final class ForYouDeckPreviewTransport: URLProtocol, @unchecked Sendable {
    /// Cards settled in this preview, so a reload after a dismissal keeps them gone.
    private static let settled = Mutex<[String: Set<String>]>([:])

    static func retire(host: String) { _ = settled.withLock { $0.removeValue(forKey: host) } }

    override static func canInit(with request: URLRequest) -> Bool {
      request.url?.host()?.hasSuffix(".for-you-preview.invalid") == true
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      guard let url = request.url, let host = url.host() else {
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
        return
      }
      let path = url.path
      let segments = path.split(separator: "/").map(String.init)
      var status = 200
      let body: String
      // Paths are recognised by comparison: this fixture answers requests, it never sends one.
      let isItems = path == "/api/feed/items"
      let isSummary = path == "/api/feed/summary"
      switch (request.httpMethod ?? "GET", path) {
      case ("GET", _) where isItems && Self.isFailing:
        status = 503
        body = "{\"error\":\"For you is unavailable in this preview.\"}"
      case ("GET", _) where isItems:
        // Only the first load waits, so a pull to refresh still answers at once.
        if Self.isSlow,
          Self.settled.withLock({ $0.updateValue($0[host] ?? [], forKey: host) == nil })
        {
          Thread.sleep(forTimeInterval: Self.slowLoad)
        }
        let gone = Self.settled.withLock { $0[host] ?? [] }
        let items = Self.cards.filter { !gone.contains($0.id) }.map(\.json)
        body = "{\"items\":[\(items.joined(separator: ","))]}"
      case ("GET", _) where isSummary:
        body = "{\"hasUnread\":false}"
      case ("POST", _) where path.hasSuffix("/suggestion/feedback"):
        let undoing = Self.isUndo(request)
        if segments.count > 3 {
          let id = segments[3]
          Self.settled.withLock { state in
            if undoing {
              state[host, default: []].remove(id)
            } else {
              state[host, default: []].insert(id)
            }
          }
        }
        body = "{\"restored\":\(undoing)}"
      case ("POST", _) where path.hasSuffix("/dismiss") || path.hasSuffix("/consume"):
        if segments.count > 3 {
          Self.settled.withLock { _ = $0[host, default: []].insert(segments[3]) }
        }
        body = "{}"
      case ("POST", _) where path.hasSuffix("/read"):
        body = "{}"
      default:
        status = 404
        body = "{\"error\":\"Not in the For you preview\"}"
      }
      guard
        let response = HTTPURLResponse(
          url: url, statusCode: status, httpVersion: "HTTP/1.1",
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

    private static let isSlow = ProcessInfo.processInfo.arguments.contains("--for-you-deck-slow")
    private static let isFailing = ProcessInfo.processInfo.arguments.contains(
      "--for-you-deck-failure")
    private static let slowLoad: TimeInterval = 4

    private static func isUndo(_ request: URLRequest) -> Bool {
      var data = request.httpBody
      if data == nil, let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&chunk, maxLength: chunk.count)
          if count <= 0 { break }
          buffer.append(chunk, count: count)
        }
        data = buffer
      }
      guard let data, let text = String(data: data, encoding: .utf8) else { return false }
      return text.contains("\"kind\":\"undo\"")
    }

    private struct Card {
      let id: String
      let json: String
    }

    private static let cards: [Card] = [
      suggestion(
        id: "73000000-0000-4000-8000-000000000001",
        title: "Reply to Maya on the Q4 pricing review",
        rationale:
          "She asked for a decision by Friday, and the thread has been quiet for two days.",
        options: [
          option(
            id: "reply", label: "Draft a reply to Maya",
            description: "Summarize the three pricing options and recommend one.",
            thread: ("73000000-0000-4000-8000-0000000000a1", "Q4 pricing review")),
          option(
            id: "compare", label: "Compare with last quarter",
            description: "Pull the Q3 numbers and show what changed.")
        ]),
      suggestion(
        id: "73000000-0000-4000-8000-000000000002",
        title: "Prepare tomorrow’s design review",
        rationale: "Three Figma files changed since the last review and two comments are open.",
        options: [
          option(
            id: "agenda", label: "Write the agenda",
            description: "List what changed and the decisions to make."),
          option(
            id: "comments", label: "Answer the open comments",
            description: "Draft replies for the two open threads.")
        ]),
      automation(id: "73000000-0000-4000-8000-000000000003"),
      suggestion(
        id: "73000000-0000-4000-8000-000000000004",
        title:
          "Your weekly metrics digest has a gap: signups from the new landing page aren’t tracked",
        rationale: "The event stopped arriving on Monday after the landing page was redeployed.",
        options: [
          option(
            id: "investigate", label: "Find out why the event stopped",
            description: "Check the deploy and the analytics setup."),
          option(id: "notify", label: "Tell the growth channel", description: "")
        ])
    ]

    private static func suggestion(
      id: String, title: String, rationale: String, options: [String]
    ) -> Card {
      Card(
        id: id,
        json: """
          {"id":"\(id)","type":"suggestion","customContextVersion":"preview",\
          "content":{"title":"\(title)","rationale":"\(rationale)",\
          "options":[\(options.joined(separator: ","))],\
          "customOption":{"threadId":null,"draft":{"draftUserMessage":{"version":1,"parts":[\
          {"type":"feedback","quote":"\(title)","note":[]}]},"draftAttachments":[]}}}}
          """)
    }

    private static func option(
      id: String, label: String, description: String, thread: (id: String, title: String)? = nil
    ) -> String {
      let reference =
        thread.map {
          ",{\"type\":\"chat_thread\",\"threadId\":\"\($0.id)\",\"titleSnapshot\":\"\($0.title)\"}"
        } ?? ""
      let threadID = thread.map { "\"\($0.id)\"" } ?? "null"
      return """
        {"id":"\(id)","label":"\(label)","description":"\(description)","threadId":\(threadID),\
        "draft":{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":"\(label)"}\
        \(reference)]},"draftAttachments":[]}}
        """
    }

    private static func automation(id: String) -> Card {
      Card(
        id: id,
        json: """
          {"id":"\(id)","type":"event","content":{"eventType":"automation-disabled",\
          "automationId":"preview-automation","automationName":"Morning inbox summary",\
          "automationDescription":"Every weekday at 8:00, summarize unread email.",\
          "consecutiveFailures":3,"recoveryScheduled":true,\
          "disabledAt":"2026-11-23T08:02:00.000Z"}}
          """)
    }
  }
#endif
