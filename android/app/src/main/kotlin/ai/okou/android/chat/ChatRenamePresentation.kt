package ai.okou.android.chat

import ai.okou.android.RenameDraft
import ai.okou.android.normalizedRenameName
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.lifecycle.ViewModel

internal sealed interface WorkspaceRenameTarget {
    val id: String

    data class Chat(override val id: String, val fromConversation: Boolean) : WorkspaceRenameTarget

    data class Project(override val id: String, val newlyCreated: Boolean = false) :
        WorkspaceRenameTarget
}

internal class ChatRenameEditor(
    val target: WorkspaceRenameTarget,
    initialName: String,
    val restoreFocus: Boolean,
) {
    val field = WorkspaceNameField(initialName)
    private val draft = RenameDraft(initialName, field.input)
    var submitted by mutableStateOf<RenameSubmission?>(null)

    fun form(confirmedName: String, enabled: Boolean) = draft.form(confirmedName, enabled, null)

    fun updateConfirmedName(name: String, readOnly: Boolean) {
        if (draft.receive(name, readOnly)) {
            field.focusedSelection = field.input.selection
        }
    }
}

internal class WorkspaceNameField(initialName: String = "") {
    val input = TextFieldState(initialText = initialName)
    var focusedSelection: TextRange = input.selection
    var overlongSubmission by mutableStateOf<String?>(null)
        private set

    fun submitProjectName(): String? {
        val name = input.text.toString().trim()
        overlongSubmission = name.takeIf { it.length > ProjectNameLimit }
        return name.takeIf { it.length in 1..ProjectNameLimit }
    }

    fun clearLengthErrorOnEdit() {
        val rejected = overlongSubmission ?: return
        if (normalizedRenameName(input.text) != rejected) overlongSubmission = null
    }
}

internal class ProjectCreationEditor(var restoreFocus: Boolean) {
    val field = WorkspaceNameField()
}

/** Retains workspace name forms and their focus destinations across Activity recreation. */
class WorkspaceNamePresentation : ViewModel() {
    internal var editor by mutableStateOf<ChatRenameEditor?>(null)
        private set

    internal var focusReturn by mutableStateOf<WorkspaceRenameTarget?>(null)
        private set

    private var creationEditor by mutableStateOf<ProjectCreationEditor?>(null)
    private var creationOpen by mutableStateOf(false)
    internal val projectCreation: ProjectCreationEditor?
        get() = creationEditor.takeIf { creationOpen }

    internal var restoreCreationFocus by mutableStateOf(false)
        private set

    internal fun openProjectCreation(restoreFocus: Boolean) {
        focusReturn = null
        restoreCreationFocus = false
        val openEditor = creationEditor ?: ProjectCreationEditor(restoreFocus)
        openEditor.restoreFocus = restoreFocus
        creationEditor = openEditor
        creationOpen = true
    }

    internal fun closeProjectCreation(
        editor: ProjectCreationEditor,
        keepForVerification: Boolean = false,
    ) {
        if (creationEditor !== editor) return
        creationOpen = false
        if (!keepForVerification) creationEditor = null
        restoreCreationFocus = editor.restoreFocus
    }

    internal fun finishProjectCreation(createdId: String?) {
        projectCreation?.let { editor ->
            if (createdId == null) restoreCreationFocus = editor.restoreFocus
            else focusReturn = WorkspaceRenameTarget.Project(createdId, newlyCreated = true)
        }
        creationOpen = false
        creationEditor = null
    }

    internal fun finishCreationFocus() {
        restoreCreationFocus = false
    }

    internal fun openChat(
        id: String,
        fromConversation: Boolean,
        restoreFocus: Boolean,
        list: ChatListUiState,
    ) {
        val thread =
            list.confirmedThreads.firstOrNull { it.id == id && it.hidden != true } ?: return
        val title = (list.threads.firstOrNull { it.id == id } ?: thread).title.orEmpty()
        open(WorkspaceRenameTarget.Chat(id, fromConversation), title, restoreFocus)
    }

    internal fun openProject(id: String, restoreFocus: Boolean, list: ChatListUiState) {
        val project = list.projects.firstOrNull { it.id == id } ?: return
        open(WorkspaceRenameTarget.Project(id), project.name, restoreFocus)
    }

    private fun open(
        target: WorkspaceRenameTarget,
        name: String,
        restoreFocus: Boolean,
    ) {
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
        creationEditor = null
        creationOpen = false
        restoreCreationFocus = false
    }
}
