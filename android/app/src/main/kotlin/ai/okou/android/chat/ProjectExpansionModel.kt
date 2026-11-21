package ai.okou.android.chat

import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class ProjectExpansionChange(val projectId: String, val expanded: Boolean)

internal data class ProjectExpansionState(
    val expandedIds: Set<String> = emptySet(),
    val readFailed: Boolean = false,
    val failedWrite: ProjectExpansionChange? = null,
)

class ProjectExpansionModel
internal constructor(
    private val store: ProjectExpansionStore,
    private val identity: WorkspaceIdentity,
) : ViewModel() {
    private val mutable = MutableStateFlow(ProjectExpansionState())
    internal val state = mutable.asStateFlow()
    private var observation: Job? = null
    private val savingIds = mutableSetOf<String>()

    init {
        observe()
    }

    private fun observe() {
        if (observation?.isActive == true) return
        observation =
            viewModelScope.launch {
                try {
                    store.observe(identity).collect { ids ->
                        mutable.update { it.copy(expandedIds = ids, readFailed = false) }
                    }
                } catch (_: IOException) {
                    mutable.update { it.copy(readFailed = true) }
                }
            }
    }

    internal fun setExpanded(projectId: String, expanded: Boolean) {
        if (!savingIds.add(projectId)) return
        mutable.update {
            if (it.failedWrite?.projectId == projectId) it.copy(failedWrite = null) else it
        }
        viewModelScope.launch {
            try {
                store.setExpanded(identity, projectId, expanded)
                observe()
            } catch (_: IOException) {
                mutable.update {
                    it.copy(failedWrite = ProjectExpansionChange(projectId, expanded))
                }
            } finally {
                savingIds.remove(projectId)
            }
        }
    }

    internal fun retry() {
        val snapshot = state.value
        if (snapshot.readFailed) observe()
        snapshot.failedWrite?.let { setExpanded(it.projectId, it.expanded) }
    }
}
