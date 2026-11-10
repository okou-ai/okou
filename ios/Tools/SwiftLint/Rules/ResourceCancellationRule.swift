import Foundation
import SwiftLintCore
import SwiftSyntax

struct ResourceCancellationRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_resource_cancellation", name: "Cancel the original resource Task",
    description: "Connect newly created resource Tasks to evaluation and owner cancellation",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard hasCCState(file) else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      guard nativeTaskCall(node), let body = node.trailingClosure else { return .visitChildren }
      let facts = CancellationFacts()
      facts.walk(body.statements)
      guard facts.awaits, let scope = scope(node) else { return .visitChildren }
      guard
        let binding = node.parent?.as(InitializerClauseSyntax.self)?.parent?
          .as(PatternBindingSyntax.self),
        let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text,
        binding.parent?.parent?.as(VariableDeclSyntax.self)?.bindingSpecifier.text == "let"
      else {
        positions.append(node.positionAfterSkippingLeadingTrivia)
        return .visitChildren
      }
      var aliases: Set<String> = [name]
      var hooked = false
      for statement in scope.statements where statement.position > node.position {
        let pending = CancellationFacts()
        pending.walk(statement.item)
        if !hooked, pending.awaits { break }
        addAliases(statement, to: &aliases)
        if let call = statement.item.as(FunctionCallExprSyntax.self),
          let member = call.calledExpression.as(MemberAccessExprSyntax.self),
          member.declName.baseName.text == "onCancel",
          scope.signals.contains(member.base?.trimmedDescription ?? ""),
          let handler = call.trailingClosure,
          cancelsOriginal(handler, aliases: aliases)
        {
          hooked = true
        }
        if statement.item.is(ReturnStmtSyntax.self) { break }
      }
      let retained = retainedProperties(
        scope.statements, aliases: aliases, owner: nativeOwner(node))
      let released = retained.allSatisfy { releasedByOwner($0, owner: nativeOwner(node)) }
      if !hooked || !released { positions.append(node.positionAfterSkippingLeadingTrivia) }
      return .visitChildren
    }

    private struct Scope {
      let statements: CodeBlockItemListSyntax
      let signals: Set<String>
    }

    private func scope(_ node: FunctionCallExprSyntax) -> Scope? {
      for parent in ancestors(of: node) {
        if let closure = parent.as(ClosureExprSyntax.self) {
          guard let (call, _) = closureCall(closure),
            isGraphCall(call, names: ["Computed", "computedTask"])
          else { return nil }
          return Scope(statements: closure.statements, signals: nativeSignalNames(closure))
        }
        if let function = parent.as(FunctionDeclSyntax.self), let body = function.body {
          let parameters = function.signature.parameterClause.parameters.filter {
            ["EvaluationSignal", "CCState.EvaluationSignal"].contains($0.type.trimmedDescription)
          }
          guard function.signature.returnClause?.type.trimmedDescription.contains("Task<") == true,
            !parameters.isEmpty
          else { return nil }
          return Scope(
            statements: body.statements,
            signals: nativeSignalAliases(
              body.statements,
              signals: Set(parameters.map { ($0.secondName ?? $0.firstName).text })))
        }
      }
      return nil
    }

    private func addAliases(_ statement: CodeBlockItemSyntax, to aliases: inout Set<String>) {
      guard let variable = statement.item.as(VariableDeclSyntax.self),
        variable.bindingSpecifier.text == "let"
      else { return }
      for binding in variable.bindings {
        if let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text,
          let original = binding.initializer?.value.as(DeclReferenceExprSyntax.self)?.baseName.text,
          aliases.contains(original)
        {
          aliases.insert(name)
        }
      }
    }

    private func cancelsOriginal(_ handler: ClosureExprSyntax, aliases: Set<String>) -> Bool {
      var names = aliases.subtracting(closureParameters(handler))
      for statement in handler.statements {
        if statement.item.is(ReturnStmtSyntax.self) || statement.item.is(ThrowStmtSyntax.self) {
          break
        }
        if let variable = statement.item.as(VariableDeclSyntax.self) {
          for binding in variable.bindings {
            if let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text {
              names.remove(name)
            }
          }
          addAliases(statement, to: &names)
        }
        if let call = statement.item.as(FunctionCallExprSyntax.self),
          let member = call.calledExpression.as(MemberAccessExprSyntax.self),
          member.declName.baseName.text == "cancel",
          let name = member.base?.as(DeclReferenceExprSyntax.self)?.baseName.text,
          names.contains(name)
        {
          return true
        }
      }
      return false
    }

    private func retainedProperties(
      _ statements: CodeBlockItemListSyntax, aliases: Set<String>, owner: MemberBlockSyntax?
    ) -> Set<String> {
      guard let owner else { return [] }
      let properties = Set(
        owner.members.flatMap { member -> [String] in
          guard let variable = member.decl.as(VariableDeclSyntax.self) else { return [] }
          return variable.bindings.compactMap { binding in
            guard binding.typeAnnotation?.type.trimmedDescription.contains("Task<") == true else {
              return nil
            }
            return binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
          }
        })
      var retained: Set<String> = []
      for statement in statements {
        guard let sequence = statement.item.as(SequenceExprSyntax.self),
          sequence.elements.count == 3,
          sequence.elements.dropFirst().first?.is(AssignmentExprSyntax.self) == true,
          let value = sequence.elements.last?.as(DeclReferenceExprSyntax.self)?.baseName.text,
          aliases.contains(value), let target = sequence.elements.first
        else { continue }
        let property =
          target.as(DeclReferenceExprSyntax.self)?.baseName.text
          ?? target.as(MemberAccessExprSyntax.self).flatMap {
            $0.base?.trimmedDescription == "self" ? $0.declName.baseName.text : nil
          }
        if let property, properties.contains(property) { retained.insert(property) }
      }
      return retained
    }

    private func releasedByOwner(_ property: String, owner: MemberBlockSyntax?) -> Bool {
      guard let owner else { return false }
      let functions = owner.members.compactMap { $0.decl.as(FunctionDeclSyntax.self) }
      var cancelling: Set<String> = []
      // Resolve only same-owner synchronous teardown helpers; names alone grant nothing.
      for _ in 0...functions.count {
        let previous = cancelling
        for function in functions where function.signature.effectSpecifiers?.asyncSpecifier == nil {
          guard let body = function.body else { continue }
          let statements = body.statements.prefix {
            !$0.item.is(ReturnStmtSyntax.self) && !$0.item.is(ThrowStmtSyntax.self)
          }
          var locals = Set(
            function.signature.parameterClause.parameters.map {
              ($0.secondName ?? $0.firstName).text
            })
          var snapshots: Set<String> = []
          for statement in statements {
            guard let variable = statement.item.as(VariableDeclSyntax.self) else { continue }
            for binding in variable.bindings {
              if let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text {
                let value = binding.initializer?.value.trimmedDescription ?? ""
                if variable.bindingSpecifier.text == "let",
                  value == "self." + property || value == property && !locals.contains(property)
                {
                  snapshots.insert(name)
                }
                locals.insert(name)
              }
            }
          }
          let calls = statements.compactMap { statement in
            statement.item.as(FunctionCallExprSyntax.self)
              ?? statement.item.as(TryExprSyntax.self)?.expression.as(FunctionCallExprSyntax.self)
          }
          if calls.contains(where: { call in
            if let member = call.calledExpression.as(MemberAccessExprSyntax.self),
              member.declName.baseName.text == "cancel",
              let base = member.base?.trimmedDescription.replacingOccurrences(of: "?", with: "")
            {
              return base == "self." + property || (base == property && !locals.contains(property))
                || snapshots.contains(base)
            }
            return cancelling.contains(callName(call.calledExpression))
              && ["", "self"].contains(
                call.calledExpression.as(MemberAccessExprSyntax.self)?.base?.trimmedDescription
                  ?? "")
          }) {
            cancelling.insert(function.name.text)
          }
        }
        if previous == cancelling { break }
      }
      return !cancelling.intersection(["close", "cancel", "dismiss", "deactivate"]).isEmpty
    }
  }
}
