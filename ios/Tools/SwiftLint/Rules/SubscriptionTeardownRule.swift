import SwiftLintCore
import SwiftSyntax

struct SubscriptionTeardownRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_subscription_teardown", name: "Release the original subscription",
    description:
      "Release original subscriptions and observer tokens at teardown and before replacement",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let visitor = Visitor(ccstate: hasCCState(file))
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    let ccstate: Bool
    var positions: [AbsolutePosition] = []
    init(ccstate: Bool) {
      self.ccstate = ccstate
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      guard let member = node.calledExpression.as(MemberAccessExprSyntax.self),
        let base = member.base
      else { return .visitChildren }
      let owner = NativeLifetimeOwner(nativeOwner(node))
      let kind: NativeLifetimeKind
      if ccstate, member.declName.baseName.text == "watch",
        owner.isStore(base, at: node)
      {
        kind = .subscription
      } else if member.declName.baseName.text == "addObserver",
        node.arguments.first?.label?.text == "forName",
        let center = owner.center(base, at: node)
      {
        kind = .observer(center)
      } else {
        return .visitChildren
      }
      let trace = NativeLifetimeTrace(kind: kind, creation: node.position, owner: owner)
      if let scope = scope(node) {
        var initial = NativeLifetimePath()
        for parent in ancestors(of: node) {
          if let closure = parent.as(ClosureExprSyntax.self) {
            initial.locals = Set(closureParameters(closure))
            break
          }
          if let function = parent.as(FunctionDeclSyntax.self) {
            initial.locals = Set(
              function.signature.parameterClause.parameters.map {
                ($0.secondName ?? $0.firstName).text
              })
            break
          }
          if let initializer = parent.as(InitializerDeclSyntax.self) {
            initial.locals = Set(
              initializer.signature.parameterClause.parameters.map {
                ($0.secondName ?? $0.firstName).text
              })
            break
          }
        }
        let results = trace.block(scope, states: [initial])
        let slots = trace.retainedSlots
        let acquisition = NativeLifetimeTrace(
          kind: kind, creation: node.position, owner: owner, slots: slots)
        let acquired = slots.isEmpty ? results : acquisition.block(scope, states: [initial])
        let lifetime = NativeLifetimeScope(
          statements: scope, locals: initial.locals,
          initializer: ancestors(of: scope).prefix(2).contains {
            $0.is(InitializerDeclSyntax.self)
          })
        let singles = trace.retained.filter { owner.fields.contains($0.key) && $0.value == .handle }
        let replaced =
          singles.keys.contains {
            !trace.preserves(node, scope: lifetime, storage: "self." + $0)
          }
          || slots.contains {
            !$0.fresh(in: scope, repeated: lifetime.repeated(node))
              && !trace.preserves(node, scope: lifetime, storage: $0.storage, slot: $0)
          }
        if !trace.reachedCreation || !acquired.allSatisfy({ acquisition.finished($0) }) || replaced
        {
          positions.append(node.positionAfterSkippingLeadingTrivia)
        }
      } else if let binding = ancestors(of: node).compactMap({
        $0.as(PatternBindingSyntax.self)
      }).first,
        let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text,
        owner.fields.contains(name)
      {
        let collection =
          binding.initializer?.value.is(ArrayExprSyntax.self) == true
          || binding.initializer?.value.is(DictionaryExprSyntax.self) == true
        if !trace.ownerReleases(name, value: collection ? .collection : .handle) {
          positions.append(node.positionAfterSkippingLeadingTrivia)
        }
      } else {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    private func scope(_ node: FunctionCallExprSyntax) -> CodeBlockItemListSyntax? {
      for parent in ancestors(of: node) {
        if let closure = parent.as(ClosureExprSyntax.self) { return closure.statements }
        if let function = parent.as(FunctionDeclSyntax.self) { return function.body?.statements }
        if let initializer = parent.as(InitializerDeclSyntax.self) {
          return initializer.body?.statements
        }
        if parent.is(MemberBlockSyntax.self) { return nil }
        if let file = parent.as(SourceFileSyntax.self) { return file.statements }
      }
      return nil
    }
  }
}
