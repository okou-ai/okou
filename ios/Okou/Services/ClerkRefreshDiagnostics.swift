#if STAGING
  import ClerkKit
  import Foundation
  import OSLog
  import Synchronization
  import UIKit

  /// Temporary, credential-free correlation for the Clerk refresh investigation.
  final class ClerkRefreshDiagnostics: Sendable {
    enum Source: String, Sendable {
      case sdk = "sdk.runtime"
      case startup = "app.startup"
      case foreground = "app.foreground"
      case accessToken = "app.access-token"
      case notification = "app.notification"
      case other = "app.refresh"
    }

    struct Context: Sendable {
      let source: Source
      let owner: String
      var refreshID: String?
    }

    @TaskLocal static var source: Source = .other
    @TaskLocal static var context: Context?

    private struct Lifecycle: Sendable {
      var cycle = 0
      var phase = "launch"
    }

    let id = UUID().uuidString
    private let lifecycle = Mutex(Lifecycle())
    private let observers = Mutex<[NSObjectProtocol]>([])
    private let log = Logger(subsystem: "ai.okou.ios", category: "Authentication")

    @MainActor
    init() {
      let events: [(Notification.Name, String)] = [
        (UIApplication.willEnterForegroundNotification, "will-enter-foreground"),
        (UIApplication.didBecomeActiveNotification, "did-become-active"),
        (UIApplication.willResignActiveNotification, "will-resign-active"),
        (UIApplication.didEnterBackgroundNotification, "did-enter-background"),
      ]
      for (name, phase) in events {
        let observer = NotificationCenter.default.addObserver(
          forName: name, object: nil, queue: .main
        ) { [weak self] _ in
          guard let self else { return }
          let snapshot = lifecycle.withLock {
            if phase == "will-enter-foreground" { $0.cycle += 1 }
            $0.phase = phase
            return $0
          }
          log.info(
            "event=auth.client.lifecycle owner=\(self.id, privacy: .public) cycle=\(snapshot.cycle) phase=\(phase, privacy: .public)"
          )
        }
        observers.withLock { $0.append(observer) }
      }
    }

    deinit {
      observers.withLock { tokens in
        for token in tokens { NotificationCenter.default.removeObserver(token) }
      }
    }

    var middleware: Clerk.Options.MiddlewareConfig {
      .init(request: [RequestTrace(owner: self)], response: [ResponseTrace(owner: self)])
    }

    func record(_ operation: String, refreshID: UUID) {
      let snapshot = lifecycle.withLock { $0 }
      let refresh = refreshID.uuidString
      log.info(
        "event=auth.client.trace operation=\(operation, privacy: .public) owner=\(self.id, privacy: .public) cycle=\(snapshot.cycle) phase=\(snapshot.phase, privacy: .public) source=\(Self.source.rawValue, privacy: .public) refresh_id=\(refresh, privacy: .public)"
      )
    }

    private func prepare(_ request: inout URLRequest) {
      guard request.httpMethod == "GET", request.url?.path == "/v1/client" else { return }
      let snapshot = lifecycle.withLock { $0 }
      let context = Self.context
      let requestID = UUID().uuidString
      let source = context?.source.rawValue ?? "unmarked"
      let caller: String
      if context?.source == .sdk {
        // Export only known function classifications, never a raw stack or URL.
        let symbols = Thread.callStackSymbols
        if symbols.contains(where: { $0.contains("onWillEnterForeground") }) {
          caller = "sdk.foreground"
        } else if symbols.contains(where: { $0.contains("startStartupClientRefreshIfNeeded") }) {
          caller = "sdk.startup"
        } else {
          caller = "unavailable"
        }
      } else {
        caller = context == nil ? "unavailable" : "app"
      }
      request.setValue(requestID, forHTTPHeaderField: "X-Okou-Clerk-Request-Id")
      request.setValue(source, forHTTPHeaderField: "X-Okou-Clerk-Source")
      request.setValue(id, forHTTPHeaderField: "X-Okou-Clerk-Owner")
      request.setValue(context?.owner, forHTTPHeaderField: "X-Okou-Clerk-Context-Owner")
      request.setValue(context?.refreshID, forHTTPHeaderField: "X-Okou-Clerk-Refresh-Id")
      request.setValue(String(snapshot.cycle), forHTTPHeaderField: "X-Okou-Clerk-Cycle")
      request.setValue(snapshot.phase, forHTTPHeaderField: "X-Okou-Clerk-Phase")
      request.setValue(caller, forHTTPHeaderField: "X-Okou-Clerk-Caller")
      log.info(
        "event=auth.client.request.started owner=\(self.id, privacy: .public) request_id=\(requestID, privacy: .public) source=\(source, privacy: .public) cycle=\(snapshot.cycle) phase=\(snapshot.phase, privacy: .public) caller=\(caller, privacy: .public)"
      )
    }

    private func received(_ response: HTTPURLResponse, for request: URLRequest) {
      guard let requestID = request.value(forHTTPHeaderField: "X-Okou-Clerk-Request-Id")
      else { return }
      log.info(
        "event=auth.client.request.received owner=\(self.id, privacy: .public) request_id=\(requestID, privacy: .public) status=\(response.statusCode)"
      )
    }

    private struct RequestTrace: ClerkRequestMiddleware {
      let owner: ClerkRefreshDiagnostics

      func prepare(_ request: inout URLRequest) async throws {
        owner.prepare(&request)
      }
    }

    private struct ResponseTrace: ClerkResponseMiddleware {
      let owner: ClerkRefreshDiagnostics

      func validate(_ response: HTTPURLResponse, data _: Data, for request: URLRequest) async throws {
        owner.received(response, for: request)
      }
    }
  }
#endif
