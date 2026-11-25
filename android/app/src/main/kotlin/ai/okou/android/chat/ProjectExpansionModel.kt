package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.launch

internal data class ProjectExpansionState(
    val expandedIds: Set<String>? = null,
    val hasLocalChoices: Boolean = false,
)

class ProjectExpansionModel
internal constructor(
    private val store: ProjectExpansionStore,
    private val identity: WorkspaceIdentity,
) : ViewModel() {
    private val mutable = MutableStateFlow(ProjectExpansionState())
    internal val state = mutable.asStateFlow()
    private var observation: Job? = null
    private var confirmedIds: Set<String>? = null

    private class Choice(val expanded: Boolean)

    private val choices = mutableMapOf<String, Choice>()
    private val savingIds = mutableSetOf<String>()
    private val savedIds = mutableSetOf<String>()

    init {
        observe()
    }

    private fun observe() {
        observation?.cancel()
        observation = viewModelScope.launch {
            var retries = 0
            try {
                store
                    .observe(identity)
                    .onEach { retries = 0 }
                    .retryWhen { cause, _ ->
                        if (cause !is IOException || retries == ChatDependencyRetryCount) {
                            false
                        } else {
                            retries++
                            delay(ChatDependencyRetryDelayMillis)
                            true
                        }
                    }
                    .collect { ids ->
                        ensureActive()
                        confirmedIds = ids
                        choices.keys.removeAll(savedIds)
                        savedIds.clear()
                        publish()
                    }
            } catch (_: IOException) {
                ensureActive()
                // Keep the last visible choices when the saved record is unavailable.
            }
        }
    }

    internal fun toggle(projectId: String) {
        setExpanded(projectId, state.value.expandedIds?.contains(projectId) != true)
    }

    internal fun setExpanded(projectId: String, expanded: Boolean) {
        if ((state.value.expandedIds?.contains(projectId) == true) == expanded) return
        choices[projectId] = Choice(expanded)
        savedIds.remove(projectId)
        publish()
        if (!savingIds.add(projectId)) return
        viewModelScope.launch {
            try {
                while (true) {
                    val choice = choices[projectId] ?: break
                    val saved = save(projectId, choice)
                    if (choices[projectId] !== choice) continue
                    if (saved) {
                        savedIds.add(projectId)
                        // A new subscription observes this commit or a later one.
                        observe()
                    }
                    break
                }
            } finally {
                savingIds.remove(projectId)
            }
        }
    }

    private suspend fun save(projectId: String, choice: Choice): Boolean {
        var retries = 0
        while (choices[projectId] === choice) {
            try {
                store.setExpanded(identity, projectId, choice.expanded)
                return true
            } catch (_: IOException) {
                currentCoroutineContext().ensureActive()
                if (choices[projectId] !== choice || retries == ChatDependencyRetryCount)
                    return false
                retries++
                delay(ChatDependencyRetryDelayMillis)
            }
        }
        return false
    }

    private fun publish() {
        val expanded =
            if (choices.isEmpty()) confirmedIds
            else
                buildSet {
                    addAll(confirmedIds.orEmpty())
                    choices.forEach { (id, choice) ->
                        if (choice.expanded) add(id) else remove(id)
                    }
                }
        mutable.value = ProjectExpansionState(expanded, choices.isNotEmpty())
    }
}
