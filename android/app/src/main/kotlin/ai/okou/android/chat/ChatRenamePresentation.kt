package ai.okou.android.chat

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.lifecycle.ViewModel

internal sealed interface WorkspaceRenameTarget {
    val id: String

    data class Chat(override val id: String, val fromConversation: Boolean) : WorkspaceRenameTarget

    data class Project(override val id: String) : WorkspaceRenameTarget
}

internal class ChatRenameEditor(
    val target: WorkspaceRenameTarget,
    initialName: String,
    val restoreFocus: Boolean,
) {
    val baseline = initialName.trim()
    val input = TextFieldState(initialText = initialName)
    var focusedSelection: TextRange = input.selection
    var submitted by mutableStateOf<String?>(null)
}

/** Owns the open editor in memory across activity recreation within one authorized workspace. */
class ChatRenamePresentation : ViewModel() {
    internal var editor by mutableStateOf<ChatRenameEditor?>(null)
        private set

    internal var focusReturn by mutableStateOf<WorkspaceRenameTarget?>(null)
        private set

    internal fun openChat(
        id: String,
        fromConversation: Boolean,
        restoreFocus: Boolean,
        list: ChatListUiState,
    ) {
        val thread =
            list.confirmedThreads.firstOrNull { it.id == id && it.hidden != true } ?: return
        open(WorkspaceRenameTarget.Chat(id, fromConversation), thread.title.orEmpty(), restoreFocus)
    }

    internal fun openProject(id: String, restoreFocus: Boolean, list: ChatListUiState) {
        val project = list.projects.firstOrNull { it.id == id } ?: return
        open(WorkspaceRenameTarget.Project(id), project.name, restoreFocus)
    }

    private fun open(target: WorkspaceRenameTarget, name: String, restoreFocus: Boolean) {
        focusReturn = null
        editor = ChatRenameEditor(target, name, restoreFocus)
    }

    internal fun dismiss(openEditor: ChatRenameEditor) {
        if (editor !== openEditor) return
        editor = null
        focusReturn = openEditor.target.takeIf { openEditor.restoreFocus }
    }

    internal fun finishFocus(request: WorkspaceRenameTarget) {
        if (focusReturn === request) focusReturn = null
    }

    override fun onCleared() {
        editor = null
        focusReturn = null
    }
}
