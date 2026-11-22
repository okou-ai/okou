package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class ProjectExpansionState(
    val expandedIds: Set<String>? = null,
    val readFailed: Boolean = false,
    val failedWrites: Map<String, Boolean> = emptyMap(),
) {
    fun confirms(projectId: String, expanded: Boolean): Boolean =
        !readFailed && expandedIds?.contains(projectId) == expanded
}

class ProjectExpansionModel
internal constructor(
    private val store: ProjectExpansionStore,
    private val identity: WorkspaceIdentity,
) : ViewModel() {
    private val mutable = MutableStateFlow(ProjectExpansionState())
    internal val state = mutable.asStateFlow()
    private var observation: Job? = null
    private val savingIds = mutableSetOf<String>()
    private val awaitingReadbackIds = mutableSetOf<String>()

    init {
        observe()
    }

    private fun observe(restart: Boolean = false) {
        if (!restart && observation?.isActive == true) return
        observation?.cancel()
        observation =
            viewModelScope.launch {
                try {
                    store.observe(identity).collect { ids ->
                        awaitingReadbackIds.clear()
                        mutable.update { it.copy(expandedIds = ids, readFailed = false) }
                    }
                } catch (_: IOException) {
                    ensureActive()
                    mutable.update { it.copy(readFailed = true) }
                }
            }
    }

    internal fun setExpanded(projectId: String, expanded: Boolean) {
        if (projectId in awaitingReadbackIds || !savingIds.add(projectId)) return
        mutable.update { it.copy(failedWrites = it.failedWrites - projectId) }
        if (state.value.confirms(projectId, expanded)) {
            savingIds.remove(projectId)
            return
        }
        viewModelScope.launch {
            try {
                store.setExpanded(identity, projectId, expanded)
                if (!state.value.confirms(projectId, expanded)) {
                    awaitingReadbackIds.add(projectId)
                    // The existing collector may still hold a value from before this commit.
                    // A fresh subscription sees this commit or a later one from another owner.
                    observe(restart = true)
                }
            } catch (_: IOException) {
                ensureActive()
                mutable.update { it.copy(failedWrites = it.failedWrites + (projectId to expanded)) }
            } finally {
                savingIds.remove(projectId)
            }
        }
    }

    internal fun retry() {
        val snapshot = state.value
        if (snapshot.readFailed) observe()
        snapshot.failedWrites.forEach { (projectId, expanded) -> setExpanded(projectId, expanded) }
    }
}
