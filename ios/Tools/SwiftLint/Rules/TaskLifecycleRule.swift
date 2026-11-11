import SwiftLintCore
import SwiftSyntax

struct TaskLifecycleRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_task_lifecycle", name: "Own retained business Tasks",
    description: "Cancel or await retained Tasks at teardown and before replacing their handles",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return visitor.reasons.keys.sorted().map { position in
      StyleViolation(
        ruleDescription: Self.description, severity: configuration.severity,
        location: Location(file: file, position: position),
        reason: visitor.reasons[position]?.sorted().joined(separator: "; "))
    }
  }

  private final class Visitor: SyntaxVisitor {
    var reasons: [AbsolutePosition: Set<String>] = [:]

    private func report(_ node: FunctionCallExprSyntax, _ reason: String) {
      reasons[node.positionAfterSkippingLeadingTrivia, default: []].insert(reason)
    }

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      guard nativeTaskCall(node), let body = nativeTaskBody(node), !body.statements.isEmpty,
        let syntax = nativeOwner(node),
        syntax.parent?.is(ClassDeclSyntax.self) == true
          || syntax.parent?.is(ActorDeclSyntax.self) == true
      else { return .visitChildren }
      let owner = NativeLifetimeOwner(syntax)
      // The syntax rule needs an explicit owner boundary. Process/SDK lifetimes
      // without one remain architectural review, rather than an invented close.
      guard
        owner.functions.contains(where: { nativeTaskTeardown.contains($0.name.text) })
          || syntax.members.contains(where: { $0.decl.is(DeinitializerDeclSyntax.self) })
      else { return .visitChildren }
      let fields = taskFields(syntax)
      guard !fields.isEmpty else { return .visitChildren }
      let trace = NativeLifetimeTrace(kind: .task, creation: node.position, owner: owner)
      if let scope = scope(node) {
        let paths = trace.block(
          scope.statements,
          states: [NativeLifetimePath(locals: scope.locals, immutable: scope.locals)])
        let retained = trace.retained.filter { fields.contains($0.key) }
        if !retained.isEmpty, !paths.allSatisfy({ trace.finished($0) }) {
          report(
            node, "The newly retained Task loses its original handle before release or transfer")
        }
        for (field, value) in retained {
          if !trace.ownerReleases(field, value: value) {
            report(
              node,
              "Retained Task '\(field)' needs cancellation or completion in its owner's teardown")
          }
          // Initializers create the first handle; indexed collections can add independent keys.
          // Replacement checks here cover single, explicitly typed owner handles.
          if value == .handle, !scope.initializer || repeatedScope(node) != nil {
            let replacement = NativeLifetimeTrace(
              kind: .task, creation: nil, owner: owner)
            func preserves(_ statements: CodeBlockItemListSyntax) -> Bool {
              let original = NativeLifetimePath(
                values: ["self." + field: .handle], locals: scope.locals,
                immutable: scope.locals, acquired: true)
              return replacement.block(statements, states: [original])
                .allSatisfy { replacement.finished($0) }
            }
            var preserved = scope.initializer || preserves(scope.statements)
            if let repeated = repeatedScope(node) {
              let iteration = NativeLifetimeTrace(
                kind: .task, creation: node.position, owner: owner)
              let body =
                repeated.as(ForStmtSyntax.self)?.body
                ?? repeated.as(WhileStmtSyntax.self)?.body
                ?? repeated.as(RepeatStmtSyntax.self)?.body
              let completes =
                body.map {
                  iteration.block(
                    $0.statements,
                    states: [NativeLifetimePath(locals: scope.locals, immutable: scope.locals)]
                  ).allSatisfy {
                    !$0.acquired || $0.released || $0.transferred
                      || [.breakLoop, .returned, .thrown].contains($0.exit)
                  }
                } ?? false
              let original = NativeLifetimePath(
                values: ["self." + field: .handle], locals: scope.locals,
                immutable: scope.locals, acquired: true)
              let retains = replacement.step(repeated, path: original)
                .allSatisfy { replacement.finished($0) }
              preserved = preserved && (completes || retains)
            }
            if !preserved {
              report(
                node,
                "Replacing '\(field)' loses its original Task; cancel, await, or preserve it first")
            }
          }
        }
      } else if let binding = ancestors(of: node).compactMap({ $0.as(PatternBindingSyntax.self) })
        .first,
        binding.parent?.parent?.parent?.is(MemberBlockItemSyntax.self) == true,
        let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text,
        fields.contains(name)
      {
        let collection =
          binding.initializer?.value.is(ArrayExprSyntax.self) == true
          || binding.initializer?.value.is(DictionaryExprSyntax.self) == true
        if !trace.ownerReleases(name, value: collection ? .collection : .handle) {
          report(
            node, "Retained Task '\(name)' needs cancellation or completion in its owner's teardown"
          )
        }
      }
      return .visitChildren
    }

    private func repeatedScope(_ node: FunctionCallExprSyntax) -> Syntax? {
      for ancestor in ancestors(of: node) {
        if ancestor.is(ClosureExprSyntax.self) || ancestor.is(FunctionDeclSyntax.self)
          || ancestor.is(InitializerDeclSyntax.self)
        {
          return nil
        }
        if ancestor.is(ForStmtSyntax.self) || ancestor.is(WhileStmtSyntax.self)
          || ancestor.is(RepeatStmtSyntax.self)
        {
          return ancestor
        }
      }
      return nil
    }

    private struct Scope {
      let statements: CodeBlockItemListSyntax
      let locals: Set<String>
      var initializer = false
    }

    private func scope(_ node: FunctionCallExprSyntax) -> Scope? {
      for ancestor in ancestors(of: node) {
        if let closure = ancestor.as(ClosureExprSyntax.self) {
          if let (call, _) = closureCall(closure),
            isGraphCall(call, names: ["Computed", "computedTask"])
          {
            return nil  // Evaluation-owned acquisitions use okou_resource_cancellation.
          }
          return Scope(statements: closure.statements, locals: Set(closureParameters(closure)))
        }
        if let function = ancestor.as(FunctionDeclSyntax.self), let body = function.body {
          let parameters = function.signature.parameterClause.parameters
          if function.signature.returnClause?.type.trimmedDescription.contains("Task<") == true,
            parameters.contains(where: {
              ["EvaluationSignal", "CCState.EvaluationSignal"].contains($0.type.trimmedDescription)
            })
          {
            return nil
          }
          return Scope(
            statements: body.statements,
            locals: Set(parameters.map { ($0.secondName ?? $0.firstName).text }))
        }
        if let initializer = ancestor.as(InitializerDeclSyntax.self), let body = initializer.body {
          return Scope(
            statements: body.statements,
            locals: Set(
              initializer.signature.parameterClause.parameters.map {
                ($0.secondName ?? $0.firstName).text
              }), initializer: true)
        }
        if ancestor.is(MemberBlockSyntax.self) { return nil }
      }
      return nil
    }

    private func taskFields(_ owner: MemberBlockSyntax) -> Set<String> {
      Set(
        owner.members.flatMap { member -> [String] in
          guard let declaration = member.decl.as(VariableDeclSyntax.self) else { return [] }
          return declaration.bindings.compactMap { binding in
            guard
              binding.typeAnnotation.map({ taskStorage($0.type) }) == true
                || binding.initializer.map({ taskInitializer($0.value) }) == true
            else { return nil }
            return binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
          }
        })
    }

    private func taskInitializer(_ expression: ExprSyntax) -> Bool {
      if let call = expression.as(FunctionCallExprSyntax.self) { return nativeTaskCall(call) }
      if let array = expression.as(ArrayExprSyntax.self) {
        return array.elements.contains { taskInitializer($0.expression) }
      }
      if let dictionary = expression.as(DictionaryExprSyntax.self),
        case .elements(let elements) = dictionary.content
      {
        return elements.contains { taskInitializer($0.value) }
      }
      return false
    }

    private func taskStorage(_ type: TypeSyntax) -> Bool {
      if let optional = type.as(OptionalTypeSyntax.self) {
        return taskStorage(optional.wrappedType)
      }
      if let array = type.as(ArrayTypeSyntax.self) { return taskStorage(array.element) }
      if let dictionary = type.as(DictionaryTypeSyntax.self) {
        return taskStorage(dictionary.value)
      }
      if let named = type.as(IdentifierTypeSyntax.self) {
        if named.name.text == "Task" { return named.genericArgumentClause != nil }
        if ["Optional", "Array"].contains(named.name.text),
          let element = named.genericArgumentClause?.arguments.first?.argument.as(TypeSyntax.self)
        {
          return taskStorage(element)
        }
        if named.name.text == "Dictionary",
          let element = named.genericArgumentClause?.arguments.last?.argument.as(TypeSyntax.self)
        {
          return taskStorage(element)
        }
      }
      if let member = type.as(MemberTypeSyntax.self), member.name.text == "Task",
        ["Swift", "_Concurrency"].contains(member.baseType.trimmedDescription)
      {
        return member.genericArgumentClause != nil
      }
      return false
    }
  }
}
