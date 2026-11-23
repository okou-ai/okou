package ai.okou.android.chat

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel

internal sealed interface WorkspaceRenameTarget {
    val id: String

    data class Chat(override val id: String, val fromConversation: Boolean) : WorkspaceRenameTarget

    data class Project(override val id: String) : WorkspaceRenameTarget
}

internal class ChatRenameEditor(val target: WorkspaceRenameTarget, initialName: String) {
    val baseline = initialName.trim()
    val input = TextFieldState(initialText = initialName)
    var submitted by mutableStateOf<String?>(null)
}

/** Owns the open editor in memory across activity recreation within one authorized workspace. */
class ChatRenamePresentation : ViewModel() {
    internal var editor by mutableStateOf<ChatRenameEditor?>(null)
        private set

    internal fun openChat(id: String, fromConversation: Boolean, list: ChatListUiState) {
        val thread =
            list.confirmedThreads.firstOrNull { it.id == id && it.hidden != true } ?: return
        editor =
            ChatRenameEditor(
                WorkspaceRenameTarget.Chat(id, fromConversation),
                thread.title.orEmpty(),
            )
    }

    internal fun openProject(id: String, list: ChatListUiState) {
        val project = list.projects.firstOrNull { it.id == id } ?: return
        editor = ChatRenameEditor(WorkspaceRenameTarget.Project(id), project.name)
    }

    internal fun dismiss(openEditor: ChatRenameEditor) {
        if (editor === openEditor) editor = null
    }

    override fun onCleared() {
        editor = null
    }
}
