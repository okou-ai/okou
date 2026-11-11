import Foundation
import SwiftLintCore
import SwiftSyntax

struct RenderEffectsRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_render_effects", name: "Native render effects",
    description: "Keep native rendering free of imperative work and graph construction", kind: .lint
  )

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let names = NameCollector(viewMode: .sourceAccurate)
    names.walk(file.syntaxTree)
    let visitor = Visitor(names: names, ccstate: hasCCState(file))
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    let names: NameCollector
    let ccstate: Bool
    var positions: [AbsolutePosition] = []

    init(names: NameCollector, ccstate: Bool) {
      self.names = names
      self.ccstate = ccstate
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      guard isRender(node) else { return .visitChildren }
      let name = callName(node.calledExpression)
      let receiver =
        node.calledExpression.as(MemberAccessExprSyntax.self)?.base?.trimmedDescription ?? ""
      let receiverName = receiver.components(separatedBy: ".").last ?? ""
      let sideEffect =
        ["Task", "addObserver", "addObserverForName", "observe", "watch", "subscribe", "sink"]
        .contains(name)
        || receiver == "Task" || receiver.hasPrefix("Task<") || receiver == "URLSession.shared"
        || (receiver.hasPrefix("DispatchQueue.") && ["async", "asyncAfter"].contains(name))
        || (receiver == "Timer" && ["scheduledTimer", "publish"].contains(name))
        || (["request", "data", "uploadAttachmentBytes", "downloadAttachment"].contains(name)
          && names.clients.contains(receiverName))
        || (name == "set" && names.stores.contains(receiverName))
        || names.setters.contains(name)
        || (ccstate && isGraphCall(node, names: graphConstructors))
      if sideEffect {
        positions.append(node.positionAfterSkippingLeadingTrivia)
        return .skipChildren
      }
      return .visitChildren
    }

    override func visit(_ node: SequenceExprSyntax) -> SyntaxVisitorContinueKind {
      let assignment = node.elements.contains {
        if $0.is(AssignmentExprSyntax.self) { return true }
        let operation = $0.as(BinaryOperatorExprSyntax.self)?.operator.text ?? ""
        return ["+=", "-=", "*=", "/=", "%=", "&+=", "&-=", "&*="].contains(operation)
      }
      guard isRender(node), assignment,
        let lhs = node.elements.first,
        lhs.is(MemberAccessExprSyntax.self) || names.setters.contains(lhs.trimmedDescription)
      else { return .visitChildren }
      if let member = lhs.as(MemberAccessExprSyntax.self), let base = member.base {
        if isLocalProjectionValue(rootName(base), at: node) { return .visitChildren }
        for ancestor in ancestors(of: node) {
          if let closure = ancestor.as(ClosureExprSyntax.self),
            closureCall(closure).map({ callName($0.0.calledExpression) }) == "transaction",
            rootName(base) == (closureParameters(closure).first ?? "$0")
          {
            return .visitChildren
          }
          guard let function = ancestor.as(FunctionDeclSyntax.self) else { continue }
          // Updating the supplied native control is the adapter's purpose;
          // mutating business/graph state from that callback is still forbidden.
          if ["updateUIView", "updateUIViewController"].contains(function.name.text) {
            let projection = ProjectionNames(function: function)
            projection.walk(function)
            if projection.names.contains(rootName(base)) { return .visitChildren }
          }
          break
        }
      }
      positions.append(node.positionAfterSkippingLeadingTrivia)
      return .visitChildren
    }
  }
}
