package ai.okou.android.chat

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class HistoryReadState {
    Idle,
    Pending,
    Confirmed,
    Failed,
}

internal data class RunActivityText(val runId: String, val text: String)

/** One visible visit, not a workspace cache or a second history synchronizer. */
class ConversationReadSession
internal constructor(
    private val threadId: String,
    private val service: ConversationHistoryService,
    parent: CoroutineScope,
    private val authorizedSelection: () -> Boolean,
    private val currentConfirmation: () -> HistoryConfirmation?,
    private val onFailure: (Exception) -> Unit,
    private val onRead: () -> Unit,
    private val precedingReadWrite: () -> Job?,
    private val markRead: suspend (String) -> Unit,
) : AutoCloseable {
    private val scope = CoroutineScope(parent.coroutineContext + Job(parent.coroutineContext[Job]))
    private val mutable = MutableStateFlow(HistoryReadState.Idle)
    val readState = mutable.asStateFlow()
    private val activity = MutableStateFlow<RunActivityText?>(null)
    internal val activityText = activity.asStateFlow()
    private var activityRunId: String? = null
    private var activityRequest: Job? = null
    private var closed = false
    private var automaticRead = true
    private var displayed: HistoryConfirmation? = null
    private var attempted: HistoryConfirmation? = null
    private var lastMarked: HistoryCursor? = null
    private var request: Job? = null
    // Explicit unread waits for a submission already in flight. A retry delay must leave it free.
    internal var pendingAutomaticRead: Job? = null
        private set

    private fun current() = !closed && authorizedSelection()

    private suspend fun requireCurrent() {
        currentCoroutineContext().ensureActive()
        if (!current()) throw CancellationException("Conversation visit ended")
    }

    fun confirmDisplayed(confirmation: HistoryConfirmation) {
        if (!current() || confirmation != currentConfirmation()) return
        displayed = confirmation
        markDisplayedRead()
    }

    internal fun stopAutomaticRead() {
        automaticRead = false
    }

    internal fun showRunActivity(runId: String?) {
        if (!current() || runId == activityRunId) return
        activityRunId = runId
        activityRequest?.cancel()
        activity.value = null
        activityRequest = runId?.let { target ->
            scope.launch {
                while (true) {
                    requireCurrent()
                    val text =
                        try {
                            service.summarizeRunActivity(threadId, target)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Exception) {
                            requireCurrent()
                            onFailure(error)
                            null
                        }
                    requireCurrent()
                    activity.value = text?.let { RunActivityText(target, it) }
                    delay(15_000L)
                }
            }
        }
    }

    private fun markDisplayedRead() {
        val confirmation = displayed ?: return
        if (
            !current() ||
                !automaticRead ||
                confirmation != currentConfirmation() ||
                request?.isActive == true ||
                lastMarked == confirmation.cursor ||
                attempted == confirmation
        )
            return
        attempted = confirmation
        // Join a write that was already pending when this display was confirmed.
        val preceding = precedingReadWrite()
        // Register ownership before even an immediately completing service can run its finalizer.
        val next =
            scope.launch(start = CoroutineStart.LAZY) {
                try {
                    preceding?.join()
                    val marked =
                        ChatWriteRetries().run {
                            requireCurrent()
                            if (
                                confirmation != currentConfirmation() ||
                                    !automaticRead ||
                                    precedingReadWrite()?.isActive == true
                            )
                                return@run false
                            mutable.value = HistoryReadState.Pending
                            val submission = CompletableDeferred<Unit>()
                            pendingAutomaticRead = submission
                            try {
                                markRead(threadId)
                            } finally {
                                pendingAutomaticRead = null
                                submission.complete(Unit)
                            }
                            true
                        }
                    requireCurrent()
                    if (!marked) {
                        mutable.value = HistoryReadState.Idle
                        return@launch
                    }
                    lastMarked = confirmation.cursor
                    mutable.value = HistoryReadState.Confirmed
                    onRead()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    requireCurrent()
                    onFailure(error)
                    if (current()) mutable.value = HistoryReadState.Failed
                } finally {
                    if (current() && request === currentCoroutineContext()[Job]) {
                        request = null
                        // A newer displayed revision waits behind the request. An identical failed
                        // attempt cannot hot-loop. A new history confirmation can try again.
                        markDisplayedRead()
                    }
                }
            }
        request = next
        next.start()
    }

    override fun close() {
        closed = true
        displayed = null
        scope.cancel()
    }
}
