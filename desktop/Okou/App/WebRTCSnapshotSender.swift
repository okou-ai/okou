import CryptoKit
import Foundation
import OkouCore
import WebKit

@MainActor
final class WebRTCSnapshotSender: NSObject, SnapshotSender, WKNavigationDelegate {
  private var session: String?
  private var webView: WKWebView?
  private var exchange: (@Sendable (JSONValue) async throws -> JSONValue)?
  private var negotiation: Task<Void, Never>?
  private var expiry: Task<Void, Never>?
  private var birth = ContinuousClock.now
  private var ready = false
  private var sending = false

  func prepare(
    session: String, exchange: @escaping @Sendable (JSONValue) async throws -> JSONValue
  ) {
    if self.session != session || birth.duration(to: .now) >= .seconds(100) {
      stop()
    }
    expiry?.cancel()
    if self.session == nil {
      guard let url = Bundle.main.url(forResource: "snapshot-peer", withExtension: "html") else {
        return
      }
      self.session = session
      self.exchange = exchange
      birth = .now
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = .nonPersistent()
      let view = WKWebView(frame: .zero, configuration: configuration)
      view.navigationDelegate = self
      webView = view
      view.loadFileURL(url, allowingReadAccessTo: url)
    }
    let lifetime = min(Duration.seconds(60), .seconds(100) - birth.duration(to: .now))
    expiry = Task { [weak self] in
      do { try await Task.sleep(for: lifetime) } catch { return }
      self?.stop()
    }
  }

  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
    guard webView === view, let exchange else { return }
    negotiation = Task { [weak self] in
      do {
        let config = try await exchange(.object(["ice": .bool(true)]))
        try Task.checkCancellation()
        let iceServers = try JSONSerialization.jsonObject(
          with: JSONEncoder().encode(config["iceServers"]))
        let offer = try await view.callAsyncJavaScript(
          "return await snapshotPeer.offer(servers, relay)", arguments: [
            "servers": iceServers, "relay": config["relayOnly"].bool == true,
          ], in: nil, contentWorld: .page)
        guard let offer = offer as? String else { throw CancellationError() }
        var response = try await exchange(.object(["offer": .string(offer)]))
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while response["description"].string == nil, ContinuousClock.now < deadline {
          try await Task.sleep(for: .milliseconds(300))
          response = try await exchange(.object([:]))
        }
        try Task.checkCancellation()
        guard let answer = response["description"].string else { throw CancellationError() }
        _ = try await view.callAsyncJavaScript(
          "return await snapshotPeer.connect(answer)", arguments: ["answer": answer],
          in: nil, contentWorld: .page)
        if self?.webView === view { self?.ready = true }
      } catch {
        if self?.webView === view { self?.stop() }
      }
    }
  }

  func enqueue(session: String, commandId: String, snapshot: JSONValue) -> String? {
    let prefix = "data:image/png;base64,"
    guard ready, !sending, self.session == session, let view = webView,
      let snapshotId = snapshot["snapshotId"].string,
      UUID(uuidString: snapshotId) != nil, UUID(uuidString: commandId) != nil,
      let encoded = snapshot["screenshot"].string, encoded.hasPrefix(prefix),
      encoded.utf8.count <= prefix.utf8.count + 5_592_408,
      let png = Data(base64Encoded: String(encoded.dropFirst(prefix.count))),
      !png.isEmpty, png.count <= 4 * 1024 * 1024
    else { return nil }

    // The receiving Run obtains this one-capture key only with the authoritative result.
    let key = SymmetricKey(size: .bits256)
    let aad = Data("\(commandId)/\(snapshotId)".utf8)
    guard let sealed = try? AES.GCM.seal(png, using: key, authenticating: aad),
      let bytes = sealed.combined else { return nil }
    sending = true
    Task { [weak self] in
      guard let self, self.webView === view else { return }
      defer { if self.webView === view { self.sending = false } }
      do {
        _ = try await view.callAsyncJavaScript(
          "return snapshotPeer.send(command, snapshot, data)", arguments: [
            "command": commandId, "snapshot": snapshotId, "data": bytes.base64EncodedString(),
          ], in: nil, contentWorld: .page)
      } catch {
        if self.webView === view { self.stop() }
      }
    }
    return key.withUnsafeBytes { Data($0).base64EncodedString() }
  }

  func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
    if webView === view { stop() }
  }

  func stop() {
    negotiation?.cancel()
    negotiation = nil
    expiry?.cancel()
    expiry = nil
    webView?.navigationDelegate = nil
    webView?.stopLoading()
    webView?.evaluateJavaScript("window.snapshotPeer?.close()")
    webView = nil
    exchange = nil
    session = nil
    ready = false
    sending = false
  }
}
