package ai.okou.android.chat

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
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
) : AutoCloseable {
    private val scope = CoroutineScope(parent.coroutineContext + Job(parent.coroutineContext[Job]))
    private val mutable = MutableStateFlow(HistoryReadState.Idle)
    val readState = mutable.asStateFlow()
    private var closed = false
    private var displayed: HistoryConfirmation? = null
    private var attempted: HistoryConfirmation? = null
    private var lastMarked: HistoryCursor? = null
    private var request: Job? = null

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

    private fun markDisplayedRead() {
        val confirmation = displayed ?: return
        if (
            !current() ||
                confirmation != currentConfirmation() ||
                request?.isActive == true ||
                lastMarked == confirmation.cursor ||
                attempted == confirmation
        )
            return
        attempted = confirmation
        // Register ownership before even an immediately completing service can run its finalizer.
        val next =
            scope.launch(start = CoroutineStart.LAZY) {
                try {
                    requireCurrent()
                    if (confirmation != currentConfirmation()) return@launch
                    mutable.value = HistoryReadState.Pending
                    service.markRead(threadId)
                    requireCurrent()
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
                        // attempt cannot hot-loop; an explicit refresh supplies a new confirmation.
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
