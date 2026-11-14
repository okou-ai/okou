package ai.okou.android.state

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

/**
 * Saved values are restoration metadata. Documents and pending writes belong to their data owner.
 */
@Composable
internal fun rememberUiTargetId(): MutableState<String?> = rememberSaveable {
    mutableStateOf<String?>(null)
}

@Composable
internal fun rememberUiFlag(): MutableState<Boolean> = rememberSaveable { mutableStateOf(false) }

internal class SavedUiIds(private val state: MutableState<List<String>>, private val limit: Int) {
    val values: List<String>
        get() = state.value

    fun record(id: String): List<String> {
        val next = (values - id) + id
        val evicted = next.dropLast(limit)
        state.value = next.takeLast(limit)
        return evicted
    }

    fun toggle(id: String) {
        if (id in values) state.value = values - id else record(id)
    }
}

@Composable
internal fun rememberCollapsedProjects(): SavedUiIds =
    rememberUiIds(SavedStatePolicy.COLLAPSED_PROJECTS)

@Composable
private fun rememberUiIds(limit: Int): SavedUiIds {
    val state = rememberSaveable { mutableStateOf(emptyList<String>()) }
    return remember(state, limit) { SavedUiIds(state, limit) }
}

internal class ConversationUiState(
    private val holder: SaveableStateHolder,
    private val recent: SavedUiIds,
) {
    fun open(id: String) {
        recent.record(id).forEach(holder::removeState)
    }

    @Composable
    fun Content(id: String, content: @Composable () -> Unit) {
        holder.SaveableStateProvider(id, content)
    }
}

@Composable
internal fun rememberConversationUiState(): ConversationUiState {
    val holder = rememberSaveableStateHolder()
    val recent = rememberUiIds(SavedStatePolicy.CONVERSATION_STATES)
    return remember(holder, recent) { ConversationUiState(holder, recent) }
}

internal class JournalEditor(val value: TextFieldValue, val edit: (TextFieldValue) -> Unit)

/** Wait for journal hydration before consuming the restored native selection. */
@Composable
internal fun rememberJournalEditor(
    text: String?,
    target: Any = Unit,
    replacementSelection: TextRange = TextRange(text?.length ?: 0),
): JournalEditor {
    if (text == null) return JournalEditor(TextFieldValue(), {})
    var native by
        rememberSaveable(
            target,
            stateSaver =
                listSaver<TextFieldValue, Int>(
                    save = {
                        val selection = if (it.text == text) it.selection else TextRange.Zero
                        listOf(selection.start, selection.end)
                    },
                    restore = { TextFieldValue(text, TextRange(it[0], it[1])) },
                ),
        ) {
            mutableStateOf(TextFieldValue(text, replacementSelection))
        }
    val presented = if (native.text == text) native else TextFieldValue(text, replacementSelection)
    return JournalEditor(presented) { native = it }
}
