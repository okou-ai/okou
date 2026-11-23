package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.workflows.WorkflowReadFailure
import ai.okou.android.workflows.WorkflowState
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
import kotlinx.coroutines.flow.first
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
    val content: String,
    val ranges: List<IntRange>,
)

data class SearchWorkflowHit(
    val id: String,
    val name: String,
    val displayName: String?,
    val description: String?,
    val canUse: Boolean,
) {
    internal val title
        get() = displayName?.takeIf(String::isNotBlank) ?: name

    internal fun matches(keyword: String) =
        title.contains(keyword, ignoreCase = true) ||
            "/$name".contains(keyword, ignoreCase = true) ||
            description?.contains(keyword, ignoreCase = true) == true
}

private fun WorkflowSummary.toSearchHit() =
    SearchWorkflowHit(id, name, displayName, description, shadowedBy == null)

internal fun WorkflowState.searchCatalog(keyword: String): SearchRead<SearchWorkflowHit> {
    val rows =
        catalog
            ?: return when (catalogFailure) {
                null -> SearchRead.Loading
                WorkflowReadFailure.CouldNotLoad -> SearchRead.Retrying
                WorkflowReadFailure.Unavailable -> SearchRead.AccessLost
                else -> SearchRead.Failed
            }
    return SearchRead.Ready(
        rows.mapNotNull { it.toSearchHit().takeIf { hit -> hit.matches(keyword) } },
        refreshFailed = catalogFailure != null,
    )
}

data class SearchArtifactHit(val id: String, val title: String, val kind: ArtifactKind)

data class SearchArtifactPage(val hits: List<SearchArtifactHit>, val nextCursor: String?)

interface WorkspaceSearchService {
    suspend fun searchMessages(keyword: String): List<SearchMessageHit>

    suspend fun searchArtifacts(keyword: String, cursor: String?): SearchArtifactPage
}

internal sealed interface SearchRead<out T> {
    data object Loading : SearchRead<Nothing>

    data object Retrying : SearchRead<Nothing>

    data object Failed : SearchRead<Nothing>

    data object AccessLost : SearchRead<Nothing>

    data class Ready<T>(
        val rows: List<T>,
        val nextCursor: String? = null,
        val refreshFailed: Boolean = false,
    ) : SearchRead<T>
}

internal val SearchRead<*>?.hasFailure: Boolean
    get() =
        when (this) {
            SearchRead.Retrying,
            SearchRead.Failed,
            SearchRead.AccessLost -> true
            is SearchRead.Ready -> refreshFailed
            else -> false
        }

private fun <T> SearchRead<T>.updated(read: SearchRead<T>): SearchRead<T> =
    if (this is SearchRead.Ready && read.hasFailure && read != SearchRead.AccessLost)
        copy(refreshFailed = true)
    else read

internal data class WorkspaceSearchResults(
    val keyword: String = "",
    val messages: SearchRead<SearchMessageHit> = SearchRead.Loading,
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
    private val visibleType = MutableStateFlow<WorkspaceSearchType?>(null)
    private var artifactPageJob: Job? = null
    private var online = false

    internal fun opened(chat: ConfirmedChat) {
        val store = recents ?: return
        if (chat.archived || !authorized()) return
        viewModelScope.launch {
            try {
                store.record(identity, chat.id)
            } catch (_: IOException) {
                // The last confirmed visit list and recent-chat fallback remain usable.
            }
        }
    }

    internal fun update(
        keyword: String,
        type: WorkspaceSearchType,
        connected: Boolean,
        artifactsAvailable: Boolean = false,
        visible: Boolean = true,
    ) {
        if (!authorized()) return
        val previous = mutable.value
        if (previous.keyword != keyword || online != connected) {
            online = connected
            artifactPageJob?.cancel()
            artifactPageJob = null
            searches.values.forEach { it.cancel() }
            searches.clear()
            mutable.value =
                if (previous.keyword != keyword) WorkspaceSearchResults(keyword)
                else
                    previous.copy(
                        messages = previous.messages as? SearchRead.Ready ?: SearchRead.Loading,
                        artifacts = previous.artifacts as? SearchRead.Ready ?: SearchRead.Loading,
                        moreArtifactsFailed = false,
                    )
        }
        if (!artifactsAvailable) {
            searches.remove(WorkspaceSearchType.Artifacts)?.cancel()
            artifactPageJob?.cancel()
            artifactPageJob = null
            mutable.value =
                mutable.value.copy(artifacts = SearchRead.Loading, moreArtifactsFailed = false)
        }
        visibleType.value = type.takeIf { visible && connected && keyword.isNotEmpty() }
        if (visibleType.value == null) return
        if (type.includes(WorkspaceSearchType.Messages)) {
            request(
                WorkspaceSearchType.Messages,
                { SearchRead.Ready(service.searchMessages(keyword)) },
            ) { state, read ->
                state.copy(messages = state.messages.updated(read))
            }
        }
        if (artifactsAvailable && type.includes(WorkspaceSearchType.Artifacts)) {
            request(WorkspaceSearchType.Artifacts, { artifactPage(keyword, null) }) { state, read ->
                state.copy(artifacts = state.artifacts.updated(read))
            }
        }
    }

    internal fun pauseReads() {
        visibleType.value = null
    }

    internal fun nextArtifacts(keyword: String, cursor: String) {
        val current = mutable.value
        val loaded = current.artifacts as? SearchRead.Ready ?: return
        if (
            !authorized() ||
                !online ||
                current.keyword != keyword ||
                loaded.nextCursor != cursor ||
                loaded.refreshFailed ||
                current.moreArtifactsFailed ||
                artifactPageJob?.isActive == true
        )
            return
        artifactPageJob =
            viewModelScope.launch {
                searches[WorkspaceSearchType.Artifacts]?.join()
                val currentPage = mutable.value.artifacts as? SearchRead.Ready ?: return@launch
                if (currentPage.nextCursor != cursor || currentPage.refreshFailed) return@launch
                readSearch(
                    { it == WorkspaceSearchType.Artifacts },
                    { artifactPage(keyword, cursor) },
                ) { next ->
                    val latest = mutable.value
                    val merged =
                        (next as? SearchRead.Ready)?.let { page ->
                            val rows = (currentPage.rows + page.rows).distinctBy { it.id }
                            if (rows.size == currentPage.rows.size && page.nextCursor != null) null
                            else SearchRead.Ready(rows, page.nextCursor)
                        }
                    mutable.value =
                        if (next == SearchRead.AccessLost)
                            latest.copy(artifacts = next, moreArtifactsFailed = false)
                        else if (merged == null) latest.copy(moreArtifactsFailed = true)
                        else latest.copy(artifacts = merged, moreArtifactsFailed = false)
                }
            }
    }

    private suspend fun artifactPage(
        keyword: String,
        cursor: String?,
    ): SearchRead.Ready<SearchArtifactHit> {
        val page = service.searchArtifacts(keyword, cursor)
        return SearchRead.Ready(page.hits.distinctBy { it.id }, page.nextCursor)
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
                readSearch({ it.includes(type) }, read) { result ->
                    mutable.value = publish(mutable.value, result)
                }
            }
    }

    private suspend fun <T> readSearch(
        inScope: (WorkspaceSearchType) -> Boolean,
        read: suspend () -> SearchRead.Ready<T>,
        publish: (SearchRead<T>) -> Unit,
    ) {
        val context = currentCoroutineContext()
        var failures = 0
        while (true) {
            visibleType.first { it != null && inScope(it) }
            context.ensureActive()
            if (!authorized()) return
            val result =
                try {
                    read()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    context.ensureActive()
                    if (!authorized()) return
                    if (
                        error is ApiFailure.Unauthenticated ||
                            error is ApiFailure.UpdateRequired ||
                            error is ApiFailure.Http && error.status == 401
                    ) {
                        onFailure(error)
                    }
                    val retryAfter = workspaceReadRetryAfterMillis(error)
                    if (authorized()) {
                        publish(
                            when {
                                error is ApiFailure.Unauthenticated ||
                                    error is ApiFailure.UpdateRequired ||
                                    error is ApiFailure.Http && error.status in setOf(401, 403) ->
                                    SearchRead.AccessLost
                                retryAfter == null -> SearchRead.Failed
                                else -> SearchRead.Retrying
                            }
                        )
                    }
                    if (retryAfter == null) return
                    delay(maxOf(retryAfter, workspaceReadRetryDelays[failures]))
                    failures = (failures + 1).coerceAtMost(workspaceReadRetryDelays.lastIndex)
                    continue
                }
            context.ensureActive()
            if (authorized()) publish(result)
            return
        }
    }
}
