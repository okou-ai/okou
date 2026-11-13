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
    val readFailed: Boolean = false,
    // Unchanged rows still complete a new read; StateFlow can conflate Loading → Ready.
    val confirmation: Long = 0,
)

/** Retained by the workspace ViewModel. Composition owns visibility, never these read resources. */
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
    private var visible = false
    private var job: Job? = null
    private var readJob: Job? = null
    private var confirmed: CachedHistory? = null
    private val dirty = mutableMapOf<String, CachedHistory>()
    private var lastMarked: Pair<String, HistoryCursor>? = null

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
        readJob?.cancel()
        confirmed = null
        lastMarked = null
        visible = false
        mutable.value = ConversationUiState(thread = thread)
        refresh()
    }

    fun setVisible(threadId: String, value: Boolean) {
        if (mutable.value.thread?.id != threadId || retired || !authorized()) return
        val becameVisible = value && !visible
        visible = value
        if (!value) readJob?.cancel()
        if (becameVisible) refresh()
        if (value) markVisibleRead()
    }

    fun refresh() {
        val thread = mutable.value.thread ?: return
        if (retired || !authorized() || job?.isActive == true) return
        val ticket = generation
        mutable.value = mutable.value.copy(phase = HistoryPhase.Loading)
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
                            confirmation = mutable.value.confirmation + 1,
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

    private fun markVisibleRead() {
        val thread = mutable.value.thread ?: return
        val checkpoint = confirmed?.checkpoint ?: return
        val key = thread.id to checkpoint.cursor
        if (
            !visible ||
                retired ||
                !authorized() ||
                mutable.value.phase != HistoryPhase.Ready ||
                mutable.value.source != ChatListSource.Network ||
                readJob?.isActive == true ||
                lastMarked == key
        )
            return
        val ticket = generation
        readJob =
            scope.launch {
                try {
                    requireCurrent(ticket)
                    if (!visible) return@launch
                    service.markRead(thread.id)
                    requireCurrent(ticket)
                    lastMarked = key
                    mutable.value = mutable.value.copy(readFailed = false)
                    onRead()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    requireCurrent(ticket)
                    reportAuthorization(error)
                    if (current(ticket)) mutable.value = mutable.value.copy(readFailed = true)
                }
            }
    }

    fun confirmDisplayed(threadId: String) {
        if (mutable.value.thread?.id == threadId) markVisibleRead()
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
        readJob?.cancel()
        visible = false
        dirty.clear()
    }
}
