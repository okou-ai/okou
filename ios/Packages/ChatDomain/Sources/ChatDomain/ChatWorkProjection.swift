import Foundation

enum ChatWorkProjection {
  private struct Phase {
    let runID: String?
    var events: [ChatEvent]
  }

  static func build(rows: [ChatEvent], messages: [ChatMessage])
    -> (messages: [ChatMessage], sections: [ChatWorkSection], usageAnchors: [String: String])
  {
    let byID = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
    let revoked = Set(rows.compactMap(\.revokesEventId))
    var inputTimes: [String: Date] = [:]
    for row in rows where isInput(row.eventType) {
      inputTimes[row.id] = row.revokesEventId.flatMap { inputTimes[$0] } ?? row.createdAt
    }
    func eventTime(_ row: ChatEvent) -> Date { inputTimes[row.id] ?? row.createdAt }
    var phases: [Phase] = []
    for row in rows
    where !revoked.contains(row.id) && row.eventType != .controlRevoke
      && row.eventType != .inputBudget
    {
      let runID = row.runId
      if let runID, phases.last?.runID == runID, !isInput(row.eventType) {
        phases[phases.count - 1].events.append(row)
      } else {
        phases.append(Phase(runID: runID, events: [row]))
      }
    }

    var endTimes: [Int: Date] = [:]
    var nextInputTime: Date?
    for index in phases.indices.reversed() {
      let events = phases[index].events
      let terminalTime = events.last { $0.eventType.isTerminal }.map(eventTime)
      endTimes[index] = [terminalTime, nextInputTime].compactMap { $0 }.min()
      if let input = events.first(where: { isInput($0.eventType) }) {
        nextInputTime = eventTime(input)
      }
    }

    var sections: [ChatWorkSection] = []
    var statusIDs = Set<String>()
    var latestStatusIDs = Set<String>()
    for (index, phase) in phases.enumerated() {
      let outputs = phase.events.filter { $0.eventType == .outputMessage && byID[$0.id] != nil }
      let anchor = outputs.last
      let anchorIndex = anchor.flatMap { anchor in phase.events.firstIndex { $0.id == anchor.id } }
      let trailing = phase.events.dropFirst((anchorIndex ?? -1) + 1).filter {
        byID[$0.id]?.role == .system
      }
      statusIDs.formUnion(trailing.map(\.id))
      if phase.events.contains(where: { isInput($0.eventType) || byID[$0.id] != nil }) {
        // A new input retires the previous outcome before it has assistant output.
        // Deduplicate repeated outcomes without discarding distinct recovery details.
        var seen = Set<String>()
        latestStatusIDs = Set(
          trailing.reversed().filter { row in
            guard let message = byID[row.id] else { return false }
            return seen.insert("\(message.isError):\(message.text)").inserted
          }.map(\.id))
      }
      guard let runID = phase.runID, let anchor, let anchorIndex,
        let first = phase.events.first
      else { continue }
      let hidden = phase.events.prefix(anchorIndex).compactMap { event -> String? in
        guard let message = byID[event.id],
          message.role == .assistant || (message.role == .system && message.isError)
        else {
          return nil
        }
        return event.id
      }
      sections.append(
        ChatWorkSection(
          id: "work:\(runID):\(first.id)", anchorMessageID: anchor.id,
          hiddenMessageIDs: hidden, stepCount: outputs.count - 1,
          startTime: eventTime(first), endTime: endTimes[index]))
    }
    let visibleMessages = messages.filter {
      !statusIDs.contains($0.id) || latestStatusIDs.contains($0.id)
    }
    let visibleIDs = Set(visibleMessages.map(\.id))
    var usageAnchors: [String: String] = [:]
    for phase in phases {
      let assistant = phase.events.filter {
        visibleIDs.contains($0.id) && byID[$0.id]?.role != .user
      }
      // Match PWA's last eligible assistant group. Local lifecycle placeholders
      // alone are not server output; a later steer must not move an older total.
      guard let runID = phase.runID,
        assistant.contains(where: {
          $0.eventType == .outputMessage || $0.payload?.error?.isEmpty == false
        }),
        let anchor = assistant.last
      else { continue }
      usageAnchors[runID] = anchor.id
    }
    return (visibleMessages, sections, usageAnchors)
  }

  private static func isInput(_ type: ChatEventType) -> Bool {
    type == .inputPrompt || type == .inputAutomation || type == .inputRejected
  }
}
