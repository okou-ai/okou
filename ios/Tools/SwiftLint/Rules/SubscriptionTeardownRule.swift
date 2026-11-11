import SwiftLintCore
import SwiftSyntax

struct SubscriptionTeardownRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_subscription_teardown", name: "Release the original subscription",
    description: "Pair native subscriptions and observer tokens with their owner's teardown",
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
      let owner = SubscriptionOwner(nativeOwner(node))
      let kind: SubscriptionKind
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
      let trace = SubscriptionTrace(kind: kind, creation: node.position, owner: owner)
      if let scope = scope(node) {
        var initial = SubscriptionPath()
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
        if !trace.reachedCreation || !results.allSatisfy({ trace.finished($0) }) {
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

enum SubscriptionKind {
  case subscription
  case observer(String)
}

struct SubscriptionOwner {
  let syntax: MemberBlockSyntax?
  let fields: Set<String>
  let functions: [FunctionDeclSyntax]

  init(_ syntax: MemberBlockSyntax?) {
    self.syntax = syntax
    fields = Set(
      syntax?.members.flatMap { member -> [String] in
        guard let declaration = member.decl.as(VariableDeclSyntax.self) else { return [] }
        return declaration.bindings.compactMap {
          $0.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
        }
      } ?? [])
    functions = syntax?.members.compactMap { $0.decl.as(FunctionDeclSyntax.self) } ?? []
  }

  func isStore(_ expression: ExprSyntax, at node: some SyntaxProtocol) -> Bool {
    let name: String
    if let reference = expression.as(DeclReferenceExprSyntax.self) {
      name = reference.baseName.text
      for ancestor in ancestors(of: node) {
        if ancestor.is(MemberBlockSyntax.self) { break }
        if let statements = ancestor.as(CodeBlockItemListSyntax.self) {
          for statement in statements.reversed() where statement.position < node.position {
            guard let declaration = statement.item.as(VariableDeclSyntax.self) else { continue }
            for binding in declaration.bindings
            where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name
              && binding.initializer.map({
                $0.position <= node.position && node.position < $0.endPosition
              }) != true
            {
              return storeBinding(binding)
            }
          }
        }
        let parameters =
          ancestor.as(FunctionDeclSyntax.self)?.signature.parameterClause.parameters
          ?? ancestor.as(InitializerDeclSyntax.self)?.signature.parameterClause.parameters
        if let parameter = parameters?.first(where: { ($0.secondName ?? $0.firstName).text == name }
        ) {
          return ["Store", "CCState.Store"].contains(parameter.type.trimmedDescription)
        }
      }
    } else if let member = expression.as(MemberAccessExprSyntax.self) {
      name = member.declName.baseName.text
      if member.base?.trimmedDescription != "self" {
        return ["store", "stateStore"].contains(name)
      }
    } else {
      return false
    }
    for member in syntax?.members ?? [] {
      guard let declaration = member.decl.as(VariableDeclSyntax.self) else { continue }
      for binding in declaration.bindings
      where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name {
        return storeBinding(binding)
      }
    }
    if let file = ancestors(of: node).compactMap({ $0.as(SourceFileSyntax.self) }).last {
      for item in file.statements {
        guard let declaration = item.item.as(VariableDeclSyntax.self) else { continue }
        for binding in declaration.bindings
        where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name {
          return storeBinding(binding)
        }
      }
    }
    return false
  }

  private func storeBinding(_ binding: PatternBindingSyntax) -> Bool {
    if let type = binding.typeAnnotation?.type.trimmedDescription {
      return ["Store", "CCState.Store"].contains(type)
    }
    return binding.initializer?.value.as(FunctionCallExprSyntax.self).map {
      isGraphCall($0, names: ["Store"])
    } == true
  }

  var nativeLifetime: Bool {
    let inherited = syntax?.parent?.as(ClassDeclSyntax.self)?.inheritanceClause?.inheritedTypes
    return inherited?.contains {
      ["UIViewController", "UIKit.UIViewController", "UIView", "UIKit.UIView"]
        .contains($0.type.trimmedDescription)
    } == true
  }

  func matching(_ call: FunctionCallExprSyntax) -> [FunctionDeclSyntax] {
    let receiver = call.calledExpression.as(MemberAccessExprSyntax.self)?.base?.trimmedDescription
    guard receiver == nil || receiver == "self" else { return [] }
    return functions.filter { function in
      guard function.name.text == callName(call.calledExpression),
        function.signature.effectSpecifiers?.asyncSpecifier == nil,
        function.signature.parameterClause.parameters.count == call.arguments.count
      else { return false }
      return zip(function.signature.parameterClause.parameters, call.arguments).allSatisfy {
        ($0.0.firstName.text == "_" ? nil : $0.0.firstName.text) == $0.1.label?.text
      }
    }
  }

  func center(
    _ expression: ExprSyntax, at node: some SyntaxProtocol,
    seen: Set<AbsolutePosition> = []
  ) -> String? {
    let text = expression.trimmedDescription
    if ["NotificationCenter.default", "Foundation.NotificationCenter.default"].contains(text) {
      return "NotificationCenter.default"
    }
    let name: String
    if let reference = expression.as(DeclReferenceExprSyntax.self) {
      name = reference.baseName.text
    } else if let member = expression.as(MemberAccessExprSyntax.self),
      member.base?.trimmedDescription == "self"
    {
      name = member.declName.baseName.text
    } else {
      return nil
    }
    // Resolve visible center declarations rather than trusting a receiver's spelling.
    for ancestor in ancestors(of: node) {
      if let statements = ancestor.as(CodeBlockItemListSyntax.self) {
        for statement in statements.reversed() where statement.position < node.position {
          guard let declaration = statement.item.as(VariableDeclSyntax.self) else { continue }
          for binding in declaration.bindings
          where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name
            && binding.initializer.map({
              $0.position <= node.position && node.position < $0.endPosition
            }) != true
          {
            return seen.contains(binding.position)
              ? nil
              : centerBinding(
                binding, name: name, property: false, seen: seen.union([binding.position]))
          }
        }
      }
      if let function = ancestor.as(FunctionDeclSyntax.self),
        let parameter = function.signature.parameterClause.parameters.first(where: {
          ($0.secondName ?? $0.firstName).text == name
        })
      {
        return ["NotificationCenter", "Foundation.NotificationCenter"].contains(
          parameter.type.trimmedDescription)
          ? "parameter:\(parameter.position.utf8Offset)" : nil
      }
    }
    for member in syntax?.members ?? [] {
      guard let declaration = member.decl.as(VariableDeclSyntax.self) else { continue }
      for binding in declaration.bindings
      where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name {
        return seen.contains(binding.position)
          ? nil
          : centerBinding(binding, name: name, property: true, seen: seen.union([binding.position]))
      }
    }
    return nil
  }

  private func centerBinding(
    _ binding: PatternBindingSyntax, name: String, property: Bool, seen: Set<AbsolutePosition>
  ) -> String? {
    guard binding.parent?.parent?.as(VariableDeclSyntax.self)?.bindingSpecifier.text == "let" else {
      return nil
    }
    let value = binding.initializer?.value.trimmedDescription ?? ""
    if ["NotificationCenter.default", "Foundation.NotificationCenter.default"].contains(value) {
      return "NotificationCenter.default"
    }
    if ["NotificationCenter", "Foundation.NotificationCenter"].contains(
      binding.typeAnnotation?.type.trimmedDescription ?? "")
      || ["NotificationCenter()", "Foundation.NotificationCenter()"].contains(value)
    {
      return property ? "self." + name : "local:\(binding.position.utf8Offset)"
    }
    if let source = binding.initializer?.value,
      binding.parent?.parent?.as(VariableDeclSyntax.self)?.bindingSpecifier.text == "let",
      source.as(DeclReferenceExprSyntax.self)?.baseName.text != name
    {
      return center(source, at: binding, seen: seen)
    }
    return nil
  }
}
