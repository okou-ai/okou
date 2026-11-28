package ai.okou.android.chat

import ai.okou.android.api.generated.ComposerWorkflowsItem
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

internal data class WorkflowToken(val range: TextRange, val query: String)

private val fuzzyParts = Regex("[0-9]+|[^0-9]")

internal fun TextFieldValue.activeWorkflowToken(): WorkflowToken? {
    if (!selection.collapsed || composition != null) return null
    val cursor = selection.start
    var start = cursor
    while (start > 0) {
        val codePoint = text.codePointBefore(start)
        if (!codePoint.isWorkflowCharacter()) break
        start -= Character.charCount(codePoint)
    }
    val slash = start - 1
    if (text.getOrNull(slash) != '/' || slash > 0 && !text[slash - 1].isWhitespace()) return null
    var end = cursor
    while (end < text.length) {
        val codePoint = text.codePointAt(end)
        if (!codePoint.isWorkflowCharacter()) break
        end += Character.charCount(codePoint)
    }
    val after = text.getOrNull(end)
    if (after == '/' || after == '.') return null
    return WorkflowToken(TextRange(slash, end), text.substring(start, cursor))
}

private fun Int.isWorkflowCharacter(): Boolean =
    this == '-'.code ||
        Character.isLetterOrDigit(this) ||
        when (Character.getType(this)) {
            Character.NON_SPACING_MARK.toInt(),
            Character.COMBINING_SPACING_MARK.toInt(),
            Character.ENCLOSING_MARK.toInt(),
            Character.LETTER_NUMBER.toInt(),
            Character.OTHER_NUMBER.toInt() -> true
            else -> false
        }

internal fun TextFieldValue.insertWorkflow(name: String, token: WorkflowToken?): TextFieldValue {
    val range = token?.range ?: TextRange(selection.max)
    val prefix = text.substring(0, range.min)
    val suffix = text.substring(range.max)
    val separator = if (token == null && prefix.lastOrNull()?.isWhitespace() == false) " " else ""
    val padding = if (suffix.firstOrNull()?.isWhitespace() == true) "" else " "
    val command = "$separator/$name$padding"
    val cursor = prefix.length + command.length + if (suffix.startsWith(' ')) 1 else 0
    return TextFieldValue(prefix + command + suffix, TextRange(cursor))
}

internal fun sentWorkflowNames(text: String): Set<String> {
    if ('/' !in text) return emptySet()
    return buildSet {
        var start = 0
        for (end in 0..text.length) {
            if (end < text.length && !text[end].isWhitespace()) continue
            if (end > start + 1 && text[start] == '/') add(text.substring(start + 1, end))
            start = end + 1
        }
    }
}

internal data class WorkflowMatch(
    val workflow: ComposerWorkflowsItem,
    val ranges: List<IntRange>,
    val rank: Int,
)

internal data class WorkflowCandidates(
    val recent: List<WorkflowMatch> = emptyList(),
    val all: List<WorkflowMatch> = emptyList(),
) {
    val rows = recent + all
}

internal fun ComposerWorkflowSnapshot.candidates(query: String): WorkflowCandidates {
    val term = query.trim().removePrefix("/").lowercase()
    val nameOrder = compareBy<WorkflowMatch> { it.workflow.name }.thenBy { it.workflow.id }
    if (term.isEmpty()) {
        val sorted = workflows.map { WorkflowMatch(it, emptyList(), 0) }.sortedWith(nameOrder)
        val byId = sorted.associateBy { it.workflow.id }
        val recentMatches = recent.distinct().mapNotNull(byId::get).take(3)
        return WorkflowCandidates(recentMatches, sorted - recentMatches.toSet())
    }
    val order = recent.withIndex().associate { it.value to it.index }
    val matches = workflows.mapNotNull { item ->
        val name = item.name.lowercase()
        val hit = name.indexOf(term)
        val ranges =
            when {
                hit >= 0 -> listOf(hit until hit + term.length)
                term.length >= 3 -> fuzzyWorkflowRanges(name, term)
                else -> emptyList()
            }
        val rank =
            when {
                name == term -> 0
                hit == 0 -> 1
                hit > 0 -> 2
                ranges.isNotEmpty() ||
                    item.displayName?.contains(term, ignoreCase = true) == true ||
                    item.description?.contains(term, ignoreCase = true) == true -> 3
                else -> return@mapNotNull null
            }
        WorkflowMatch(item, ranges.takeIf { name.length == item.name.length }.orEmpty(), rank)
    }
    return WorkflowCandidates(
        all =
            matches.sortedWith(
                compareBy<WorkflowMatch> { it.rank }
                    .thenBy { order[it.workflow.id] ?: Int.MAX_VALUE }
                    .then(nameOrder),
            ),
    )
}

private fun fuzzyWorkflowRanges(name: String, term: String): List<IntRange> {
    var offset = 0
    val ranges = mutableListOf<IntRange>()
    for (part in fuzzyParts.findAll(term)) {
        val start = name.indexOf(part.value, offset)
        if (start < 0) return emptyList()
        offset = start + part.value.length
        ranges.add(start until offset)
    }
    return ranges
}
