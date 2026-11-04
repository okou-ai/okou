import Foundation

/// One task's delegate; no session-global state or raw network identifiers are retained.
final class APIRequestMetrics: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var diagnostic: APITransportDiagnostic?

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics
  ) {
    let value = APITransportDiagnostic(metrics)
    lock.withLock { diagnostic = value }
  }

  func snapshot() -> APITransportDiagnostic? { lock.withLock { diagnostic } }
}

struct APIHTTPResponseDiagnostic: Sendable {
  let status: Int
  let headers: [String: String]

  init(_ response: HTTPURLResponse) {
    status = response.statusCode
    headers = Dictionary(
      uniqueKeysWithValues: [
        "cf-ray", "x-vercel-id", "x-vercel-cache", "x-request-id", "server", "content-type",
        "retry-after",
      ].compactMap { name -> (String, String)? in
        guard let value = response.value(forHTTPHeaderField: name) else { return nil }
        return (name, String(value.prefix(256)))
      })
  }
}

struct APITransportDiagnostic: Sendable {
  let response: APIHTTPResponseDiagnostic?
  let transactionCount: Int
  let transactions: [APITransactionDiagnostic]

  init(_ metrics: URLSessionTaskMetrics) {
    response = (metrics.transactionMetrics.last?.response as? HTTPURLResponse)
      .map(APIHTTPResponseDiagnostic.init)
    transactionCount = metrics.transactionMetrics.count
    transactions = metrics.transactionMetrics.suffix(2).map(APITransactionDiagnostic.init)
  }

  var context: [String: Any] {
    [
      "transactionCount": transactionCount,
      "omittedTransactions": transactionCount - transactions.count,
      "transactions": transactions.map(\.context),
    ]
  }
}

struct APITransactionDiagnostic: Sendable {
  let timings: [String: Double]
  let responseStarted: Bool
  let reusedConnection: Bool
  let proxyConnection: Bool
  let networkProtocol: String?
  let status: Int?

  init(_ metrics: URLSessionTaskTransactionMetrics) {
    var timings: [String: Double] = [:]
    func phase(_ key: String, _ start: Date?, _ end: Date?) {
      if let start, let end { timings[key] = end.timeIntervalSince(start) * 1000 }
    }
    phase("dnsMs", metrics.domainLookupStartDate, metrics.domainLookupEndDate)
    phase("connectMs", metrics.connectStartDate, metrics.connectEndDate)
    phase("tlsMs", metrics.secureConnectionStartDate, metrics.secureConnectionEndDate)
    phase("requestToResponseMs", metrics.requestEndDate, metrics.responseStartDate)
    phase("responseMs", metrics.responseStartDate, metrics.responseEndDate)
    self.timings = timings
    responseStarted = metrics.responseStartDate != nil
    reusedConnection = metrics.isReusedConnection
    proxyConnection = metrics.isProxyConnection
    networkProtocol = metrics.networkProtocolName.map { String($0.prefix(32)) }
    status = (metrics.response as? HTTPURLResponse)?.statusCode
  }

  var context: [String: Any] {
    var fields: [String: Any] = [
      "responseStarted": responseStarted, "reusedConnection": reusedConnection,
      "proxyConnection": proxyConnection,
    ]
    for (key, value) in timings { fields[key] = value }
    if let networkProtocol { fields["networkProtocol"] = networkProtocol }
    if let status { fields["status"] = status }
    return fields
  }
}
