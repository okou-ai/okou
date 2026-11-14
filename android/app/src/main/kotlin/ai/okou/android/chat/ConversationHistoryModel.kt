package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class HistoryPhase {
    Loading,
    Ready,
    Failed,
    Missing,
}

data class ConversationUiState(
    val thread: ConfirmedChat? = null,
    val transcript: HistoryTranscript? = null,
    val phase: HistoryPhase = HistoryPhase.Loading,
    val source: ChatListSource? = null,
    val cacheUnavailable: Boolean = false,
    val generation: Long = 0,
    val confirmation: HistoryConfirmation? = null,
)

/** A completed network read, distinct from both selection identity and the event cursor. */
data class HistoryConfirmation(val generation: Long, val revision: Long, val cursor: HistoryCursor)

/** Workspace-retained confirmed data. A visible visit owns its separate read session. */
class ConversationHistoryModel(
    private val service: ConversationHistoryService,
    private val cache: ChatCacheStore.Lease,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val onRead: () -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    private val mutable = MutableStateFlow(ConversationUiState())
    val uiState = mutable.asStateFlow()
    private val sync = ConversationHistorySync(service, dispatcher)
    private var generation = 0L
    private var retired = false
    private var revision = 0L
    private var job: Job? = null
    private var visit: ConversationReadSession? = null
    private var confirmed: CachedHistory? = null
    private val dirty = mutableMapOf<String, CachedHistory>()

    private fun current(ticket: Long) = !retired && authorized() && ticket == generation

    private suspend fun requireCurrent(ticket: Long) {
        currentCoroutineContext().ensureActive()
        if (!current(ticket)) throw CancellationException("Conversation owner retired")
    }

    fun open(thread: ConfirmedChat) {
        if (retired || !authorized()) return
        if (mutable.value.thread?.id == thread.id) {
            mutable.value = mutable.value.copy(thread = thread)
            return
        }
        generation++
        job?.cancel()
        visit?.close()
        visit = null
        confirmed = null
        mutable.value = ConversationUiState(thread = thread, generation = generation)
        refresh()
    }

    fun beginVisit(threadId: String, generation: Long): ConversationReadSession? {
        if (mutable.value.thread?.id != threadId || !current(generation)) return null
        visit?.close()
        return ConversationReadSession(
                threadId,
                service,
                scope,
                { current(generation) },
                { mutable.value.confirmation },
                ::reportAuthorization,
                onRead,
            )
            .also {
                visit = it
                refresh()
            }
    }

    fun refresh() {
        val thread = mutable.value.thread ?: return
        if (retired || !authorized() || job?.isActive == true) return
        val ticket = generation
        mutable.value = mutable.value.copy(phase = HistoryPhase.Loading, confirmation = null)
        job =
            scope.launch {
                var saved = confirmed ?: dirty[thread.id]
                if (saved == null) {
                    try {
                        saved = cache.loadHistory(thread.id)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        requireCurrent(ticket)
                        mutable.value = mutable.value.copy(cacheUnavailable = true)
                    }
                }
                if (saved != null) {
                    val transcript = withContext(dispatcher) { projectHistory(saved.checkpoint) }
                    requireCurrent(ticket)
                    confirmed = saved
                    mutable.value =
                        mutable.value.copy(transcript = transcript, source = ChatListSource.Cache)
                }
                try {
                    var next =
                        CachedHistory(
                            sync.synchronize(thread.id, saved?.checkpoint),
                            System.currentTimeMillis(),
                        )
                    requireCurrent(ticket)
                    dirty[thread.id] = next
                    var diskFailed = false
                    try {
                        cache.saveHistory(next.checkpoint, next.confirmedAt)
                        val disk = cache.loadHistory(thread.id)
                        requireCurrent(ticket)
                        if (disk != null) next = disk
                        dirty.remove(thread.id)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        requireCurrent(ticket)
                        diskFailed = true
                    }
                    val transcript = withContext(dispatcher) { projectHistory(next.checkpoint) }
                    requireCurrent(ticket)
                    confirmed = next
                    mutable.value =
                        mutable.value.copy(
                            transcript = transcript,
                            phase = HistoryPhase.Ready,
                            source = ChatListSource.Network,
                            cacheUnavailable = diskFailed,
                            // Equal rows still complete a new read; StateFlow may conflate phases.
                            confirmation =
                                HistoryConfirmation(ticket, ++revision, next.checkpoint.cursor),
                        )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    requireCurrent(ticket)
                    if (error is ApiFailure.Http && error.status in setOf(403, 404)) {
                        confirmed = null
                        dirty.remove(thread.id)
                        mutable.value =
                            mutable.value.copy(
                                transcript = null,
                                source = null,
                                phase = HistoryPhase.Missing,
                            )
                        try {
                            cache.deleteHistory(thread.id)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            requireCurrent(ticket)
                            mutable.value = mutable.value.copy(cacheUnavailable = true)
                        }
                    } else {
                        reportAuthorization(error)
                        if (current(ticket))
                            mutable.value = mutable.value.copy(phase = HistoryPhase.Failed)
                    }
                }
            }
    }

    private fun reportAuthorization(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            onFailure(error)
    }

    fun close() {
        retired = true
        generation++
        job?.cancel()
        visit?.close()
        visit = null
        dirty.clear()
    }
}
