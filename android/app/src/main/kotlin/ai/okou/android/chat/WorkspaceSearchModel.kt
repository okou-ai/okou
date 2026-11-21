package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

internal const val RecentSearchChatLimit = 8
internal const val GroupedSearchResultLimit = 3
private const val SearchDebounceMillis = 300L

internal enum class WorkspaceSearchType {
    All,
    Chats,
    Messages,
    Workflows,
    Artifacts;

    fun includes(type: WorkspaceSearchType) = this == All || this == type
}

data class SearchMessageHit(
    val threadId: String,
    val seqId: Long,
    val agentName: String,
    val content: String,
    val ranges: List<IntRange>,
) {
    internal val key
        get() = "message:$threadId:$seqId"
}

data class SearchWorkflowHit(
    val id: String,
    val agentId: String,
    val name: String,
    val title: String,
    val description: String?,
    val canUse: Boolean,
) {
    internal val key
        get() = "workflow:$id"

    internal fun matches(keyword: String) =
        title.contains(keyword, ignoreCase = true) ||
            "/$name".contains(keyword, ignoreCase = true) ||
            description?.contains(keyword, ignoreCase = true) == true
}

data class SearchArtifactHit(val id: String, val title: String, val kind: ArtifactKind) {
    internal val key
        get() = "artifact:$id"
}

data class SearchArtifactPage(val hits: List<SearchArtifactHit>, val nextCursor: String?)

interface WorkspaceSearchService {
    suspend fun searchMessages(keyword: String): List<SearchMessageHit>

    suspend fun searchableWorkflows(): List<SearchWorkflowHit>

    suspend fun searchArtifacts(keyword: String, cursor: String?): SearchArtifactPage
}

internal sealed interface SearchRead<out T> {
    data object Loading : SearchRead<Nothing>

    data object Failed : SearchRead<Nothing>

    data class Ready<T>(val rows: List<T>, val nextCursor: String? = null) : SearchRead<T>
}

internal data class WorkspaceSearchResults(
    val keyword: String = "",
    val messages: SearchRead<SearchMessageHit> = SearchRead.Loading,
    val workflows: SearchRead<SearchWorkflowHit> = SearchRead.Loading,
    val artifacts: SearchRead<SearchArtifactHit> = SearchRead.Loading,
    val moreArtifactsFailed: Boolean = false,
)

class WorkspaceSearchModel
internal constructor(
    private val service: WorkspaceSearchService,
    private val identity: WorkspaceIdentity,
    private val recents: SearchRecentChatsStore?,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkspaceSearchResults())
    internal val results = mutable.asStateFlow()
    internal val recentlyOpened =
        (recents?.observe(identity) ?: emptyFlow())
            .catch { error -> if (error !is IOException) throw error }
            .stateIn(viewModelScope, SharingStarted.Lazily, emptyList())
    private val searches = mutableMapOf<WorkspaceSearchType, Job>()
    private var artifactPageJob: Job? = null
    private var workflowCatalog: List<SearchWorkflowHit>? = null
    private var online = false

    internal fun opened(threadId: String) {
        val store = recents ?: return
        if (!authorized()) return
        viewModelScope.launch {
            try {
                store.record(identity, threadId)
            } catch (_: IOException) {
                // The last confirmed visit list and recent-chat fallback remain usable.
            }
        }
    }

    internal fun update(
        keyword: String,
        type: WorkspaceSearchType,
        connected: Boolean,
        workflowsAvailable: Boolean = false,
        artifactsAvailable: Boolean = false,
    ) {
        if (!authorized()) return
        if (online != connected || keyword.isEmpty()) workflowCatalog = null
        if (mutable.value.keyword != keyword || online != connected) {
            online = connected
            artifactPageJob?.cancel()
            artifactPageJob = null
            searches.values.forEach { it.cancel() }
            searches.clear()
            mutable.value = WorkspaceSearchResults(keyword)
        }
        if (!connected || keyword.isEmpty()) return
        if (type.includes(WorkspaceSearchType.Messages)) {
            request(
                WorkspaceSearchType.Messages,
                { SearchRead.Ready(service.searchMessages(keyword)) },
            ) { state, read ->
                state.copy(messages = read)
            }
        }
        if (workflowsAvailable && type.includes(WorkspaceSearchType.Workflows)) {
            request(WorkspaceSearchType.Workflows, { SearchRead.Ready(findWorkflows(keyword)) }) {
                state,
                read ->
                state.copy(workflows = read)
            }
        }
        if (artifactsAvailable && type.includes(WorkspaceSearchType.Artifacts)) {
            request(WorkspaceSearchType.Artifacts, { artifactPage(keyword, null) }) { state, read ->
                state.copy(artifacts = read)
            }
        }
    }

    internal fun nextArtifacts(keyword: String, cursor: String) {
        val current = mutable.value
        val loaded = current.artifacts as? SearchRead.Ready ?: return
        if (
            !authorized() ||
                !online ||
                current.keyword != keyword ||
                loaded.nextCursor != cursor ||
                current.moreArtifactsFailed ||
                artifactPageJob?.isActive == true
        )
            return
        artifactPageJob =
            viewModelScope.launch {
                val next = readSearch { artifactPage(keyword, cursor) }
                currentCoroutineContext().ensureActive()
                if (!authorized()) return@launch
                val latest = mutable.value
                val merged =
                    (next as? SearchRead.Ready)?.let { page ->
                        val rows = (loaded.rows + page.rows).distinctBy { it.id }
                        if (rows.size == loaded.rows.size && page.nextCursor != null) null
                        else SearchRead.Ready(rows, page.nextCursor)
                    }
                mutable.value =
                    if (merged == null) latest.copy(moreArtifactsFailed = true)
                    else latest.copy(artifacts = merged)
            }
    }

    private suspend fun artifactPage(
        keyword: String,
        cursor: String?,
    ): SearchRead.Ready<SearchArtifactHit> {
        val page = service.searchArtifacts(keyword, cursor)
        return SearchRead.Ready(page.hits.distinctBy { it.id }, page.nextCursor)
    }

    private suspend fun findWorkflows(keyword: String): List<SearchWorkflowHit> {
        val catalog =
            workflowCatalog
                ?: service.searchableWorkflows().also {
                    currentCoroutineContext().ensureActive()
                    if (authorized()) workflowCatalog = it
                }
        return catalog.filter { it.matches(keyword) }
    }

    private fun <T> request(
        type: WorkspaceSearchType,
        read: suspend () -> SearchRead.Ready<T>,
        publish: (WorkspaceSearchResults, SearchRead<T>) -> WorkspaceSearchResults,
    ) {
        if (searches.containsKey(type)) return
        searches[type] =
            viewModelScope.launch {
                delay(SearchDebounceMillis)
                val result = readSearch(read)
                currentCoroutineContext().ensureActive()
                if (authorized()) mutable.value = publish(mutable.value, result)
            }
    }

    private suspend fun <T> readSearch(read: suspend () -> SearchRead.Ready<T>): SearchRead<T> =
        try {
            read()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            if (
                authorized() &&
                    (error is ApiFailure.Unauthenticated ||
                        error is ApiFailure.UpdateRequired ||
                        error is ApiFailure.Http && error.status == 401)
            )
                onFailure(error)
            SearchRead.Failed
        }
}
