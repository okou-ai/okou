package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

private val listRefreshRetryDelays = listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L)
private const val unreadSnapshotLifetimeMillis = 120_000L
private const val unreadSnapshotRenewalMillis = 30_000L

private fun CachedUnread.remainingMillis(now: Long): Long {
    val age = now - confirmedAt
    return if (confirmedAt > 0 && age in 0 until unreadSnapshotLifetimeMillis) {
        unreadSnapshotLifetimeMillis - age
    } else 0
}

private fun listRetryAfterMillis(error: Exception): Long? {
    val seconds =
        when (error) {
            is ApiFailure.Network -> 0L
            is ApiFailure.Http ->
                if (retryableListReadStatus(error.status)) error.retryAfterSeconds ?: 0L else null
            // A fresh descriptor can replace an expired signed URL on the next read.
            is ChatSnapshotUnavailable ->
                if (error.status == 403 || retryableListReadStatus(error.status))
                    error.retryAfterSeconds ?: 0L
                else null
            else -> null
        }
    return seconds?.coerceIn(0, Long.MAX_VALUE / 1_000)?.times(1_000)
}

private fun retryableListReadStatus(status: Int) =
    status == 408 || status == 429 || status in 500..599

enum class ChatReadPhase {
    Idle,
    Loading,
    Ready,
    Failed,
}

enum class ChatListReadFailure {
    Retrying,
    NeedsRetry,
}

enum class ChatListFilter {
    Inbox,
    Unread,
    Archived,
    Muted,
}

enum class ChatListSource {
    Cache,
    Network,
}

data class ChatMarkAllReadResult(val confirmed: Int, val requested: Int)

class ChatReadIntent
internal constructor(internal val action: ChatRowAction, internal val through: String?) {
    // Indicators use the server's fixed-width UTC ISO timestamps.
    // A locally marked unread row can still lack a server watermark on the next action.
    internal fun isUnread(serverUnreadAt: String?): Boolean =
        action == ChatRowAction.MarkUnread ||
            (through != null && serverUnreadAt != null && serverUnreadAt > through)
}

enum class ChatRowAction(
    internal val updatesChat: Boolean = true,
    internal val updatesIndicators: Boolean = true,
    internal val changesPinOrder: Boolean = false,
) {
    MarkRead(updatesChat = false),
    MarkUnread(updatesChat = false),
    Mute,
    Unmute,
    Archive,
    Unarchive,
    Delete,
    Rename(updatesIndicators = false),
    Pin(updatesIndicators = false, changesPinOrder = true),
    Unpin(updatesIndicators = false, changesPinOrder = true),
    MovePinUp(updatesIndicators = false, changesPinOrder = true),
    MovePinDown(updatesIndicators = false, changesPinOrder = true),
}

class ChatRowUndo
internal constructor(val threadId: String, val action: ChatRowAction, internal val sequence: Long) {
    internal val inverse: ChatRowAction
        get() =
            when (action) {
                ChatRowAction.Archive -> ChatRowAction.Unarchive
                ChatRowAction.Unarchive -> ChatRowAction.Archive
                ChatRowAction.MarkRead -> ChatRowAction.MarkUnread
                else -> error("Chat action cannot be undone")
            }
}

data class ChatListUiState(
    val threads: List<ConfirmedChat> = emptyList(),
    val listPhase: ChatReadPhase = ChatReadPhase.Idle,
    val offline: Boolean = false,
    val listReadFailure: ChatListReadFailure? = null,
    val sustainedRefreshFailure: Boolean = false,
    val confirmedAt: Long? = null,
    val source: ChatListSource? = null,
    val cacheUnavailable: Boolean = false,
    val projectCacheUnavailable: Boolean = false,
    val agents: Agents = emptyList(),
    val agentsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val agentsSource: ChatListSource? = null,
    val projects: List<ConfirmedProject> = emptyList(),
    val projectsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val projectsSource: ChatListSource? = null,
    val indicators: Indicators? = null,
    val indicatorsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val filter: ChatListFilter = ChatListFilter.Inbox,
    val pendingRowActions: Map<String, ChatRowAction> = emptyMap(),
    val failedRowAction: ChatRowAction? = null,
    val rowUndo: ChatRowUndo? = null,
    val markingAllRead: Boolean = false,
    val markAllReadResult: ChatMarkAllReadResult? = null,
    internal val cachedUnread: CachedUnread? = null,
    internal val readIntents: Map<String, ChatReadIntent> = emptyMap(),
    internal val threadsByRecency: List<ConfirmedChat> = emptyList(),
)

internal val ChatListUiState.displayUnreadAt: Map<String, String>?
    get() = indicators?.unreadAt ?: cachedUnread?.unreadAt

internal fun ChatListUiState.isUnread(threadId: String): Boolean {
    val serverUnreadAt = displayUnreadAt?.get(threadId)
    return readIntents[threadId]?.isUnread(serverUnreadAt) ?: (serverUnreadAt != null)
}

internal fun ChatListUiState.unreadChatIds(): Set<String> {
    val serverUnread = displayUnreadAt.orEmpty().keys
    if (readIntents.isEmpty()) return serverUnread
    return serverUnread.toMutableSet().apply {
        for (id in readIntents.keys) {
            if (isUnread(id)) add(id) else remove(id)
        }
    }
}

internal fun ChatListUiState.rowActions(
    thread: ConfirmedChat,
    group: ChatListGroup? = null,
    index: Int = -1,
): List<ChatRowAction> = buildList {
    val canUpdateChat = listPhase != ChatReadPhase.Failed
    // A refresh retains the last synchronized rank scope while it fetches the next one.
    if (
        group != null &&
            source == ChatListSource.Network &&
            canUpdateChat &&
            projectsSource != null &&
            pendingRowActions.values.none { it.changesPinOrder }
    ) {
        val pinned = thread.pinnedAt != null
        add(if (pinned) ChatRowAction.Unpin else ChatRowAction.Pin)
        if (pinned && filter == ChatListFilter.Inbox) {
            if (group.pinNeighbor(index, -1) != null) add(ChatRowAction.MovePinUp)
            if (group.pinNeighbor(index, 1) != null) add(ChatRowAction.MovePinDown)
        }
    }
    val canUpdateUnread = indicators != null || (cachedUnread != null && !offline)
    if (canUpdateUnread && indicatorsPhase != ChatReadPhase.Failed && thread.muted != true) {
        add(if (isUnread(thread.id)) ChatRowAction.MarkRead else ChatRowAction.MarkUnread)
    }
    if (canUpdateChat) {
        add(ChatRowAction.Rename)
        add(if (thread.muted == true) ChatRowAction.Unmute else ChatRowAction.Mute)
        add(if (thread.archived) ChatRowAction.Unarchive else ChatRowAction.Archive)
        add(ChatRowAction.Delete)
    }
}

internal fun ChatListUiState.markAllReadTargets(): Map<String, String> {
    val unreadAt = indicators?.unreadAt ?: return emptyMap()
    if (markingAllRead || indicatorsPhase == ChatReadPhase.Failed || unreadAt.isEmpty()) {
        return emptyMap()
    }
    // The Unread view includes every matching chat before collapse or viewport filtering.
    val targets = buildMap {
        for (group in chatListGroups(this@markAllReadTargets, ChatListFilter.Unread)) {
            for (thread in group.threads) {
                unreadAt[thread.id]?.let { put(thread.id, it) }
            }
        }
    }
    return if (targets.keys.any { it in pendingRowActions }) emptyMap() else targets
}

/** Workspace-retained HTTP observations; no row collector owns synchronization or durable state. */
class ChatListModel(
    private val service: ChatListService,
    cacheStore: ChatCacheStore,
    identity: WorkspaceIdentity,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    realtime: RealtimeService? = null,
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    connectivity: Flow<Boolean> = emptyFlow(),
    private val wallMillis: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val mutable = MutableStateFlow(ChatListUiState())
    val uiState = mutable.asStateFlow()
    @Volatile private var retired = false
    private val cache = cacheStore.open(identity) { current() }
    private val readWrites = mutableMapOf<String, Job>()
    val history =
        ConversationHistoryModel(
            service,
            cache,
            viewModelScope,
            { current() },
            onFailure,
            { invalidateIndicators() },
            dispatcher,
            precedingReadWrite = { readWrites[it] },
        )
    private val sync = ChatListSync(service, dispatcher)
    private var confirmed: CachedChats? = null
    private var confirmedRows = ReplayedChats(emptyList(), emptyList())
    private var rowEdits = emptyList<ChatRowEdit>()
    private val unconfirmedRowEvents = mutableSetOf<String>()
    private val rejectedRowEvents = mutableSetOf<String>()
    private var confirmedProjects: CachedProjects? = null
    private var cacheRead = false
    private var restoreJob: Job? = null
    private var projectsRestoreJob: Job? = null
    private var agentsJob: Job? = null
    private var projectsJob: Job? = null
    private var indicatorsJob: Job? = null
    private val indicatorReadReceipts = mutableMapOf<String, ChatTimestamp>()
    private val readConfirmations = mutableMapOf<String, ReadConfirmation>()
    private val writes = Mutex()
    private val projectSync = ProjectSync(service, dispatcher)

    private class ListReadBatch {
        var refresh = false
        var userRequested = false
        val discardOnSuccess = mutableSetOf<String>()
        val confirmations = mutableListOf<ListConfirmation>()
    }

    private class ListConfirmation(
        val edits: List<ChatRowEdit>,
        val done: CompletableDeferred<Unit>,
    )

    private class ReadConfirmation(
        val intent: ChatReadIntent,
        val receiptCoversIntent: Boolean,
        val single: Boolean,
    )

    private class PreparedListRebase(
        val baseline: ChatCheckpoint,
        val result: ChatListSync.Result,
        val projection: ReplayedChats,
    )

    private var pendingListRead: ListReadBatch? = null
    private var listRetry: Job? = null
    private var listRetryAt: Long? = null
    private var refreshOnReconnect = false
    private var listFailureNotice: Job? = null
    private var firstListFailureAt: Long? = null
    private var filterListFailures = 0
    private var listFailures = 0
    private var connectivityGeneration = 0
    private var listIsVisible = true
    private var filterIsVisible = true
    private var filterGeneration = 0
    private var listInForeground = true
    private var listRebaseJob: Job? = null
    private var readyListRebase: PreparedListRebase? = null
    private val listReadRequests = Channel<Unit>(Channel.CONFLATED)
    private val projectInvalidations = Channel<Unit>(Channel.CONFLATED)
    private val indicatorInvalidations = Channel<Unit>(Channel.CONFLATED)
    private val unreadCacheWrites = Channel<CachedUnread>(Channel.CONFLATED)
    private var immediateIndicators = false
    private var indicatorsStartedAt: Long? = null
    val warming =
        ChatHistoryWarming(
            service,
            cache,
            viewModelScope,
            { current() },
            candidates = {
                val state = mutable.first { it.source != null && it.indicators != null }
                withContext(dispatcher) {
                    (state.threads
                            .filter { it.hidden != true }
                            .sortedWith(
                                compareByDescending<ConfirmedChat> { it.sortAt }
                                    .thenByDescending { it.id }
                            )
                            .take(100)
                            .map { it.id } + checkNotNull(state.indicators).threads.keys)
                        .distinct()
                }
            },
            selected = { history.uiState.value.thread?.id },
            onFailure,
            dispatcher,
            monotonicMillis,
            onUnavailable = history::forgetWarmedHistory,
        )
    val updates =
        ChatUpdatesModel(
            realtime,
            viewModelScope,
            { current() },
            onFailure,
            history.output,
            foregroundChanged = { foreground ->
                warming.foreground(foreground)
                listInForeground = foreground
                updateListRetryVisibility()
            },
        ) { changes ->
            if (current()) {
                if (changes.resync || changes.list) {
                    refreshList()
                    projectInvalidations.trySend(Unit)
                }
                if (changes.resync || changes.indicators || changes.readCursor)
                    requestIndicators(immediate = changes.resync || changes.readCursor)
                if (changes.resync) {
                    history.invalidate()
                    history.invalidateDetail()
                } else {
                    changes.messageThreads.forEach { history.invalidate(it) }
                    changes.detailThreads.forEach { history.invalidateDetail(it) }
                }
                if (changes.resync || changes.messageThreads.isNotEmpty()) warming.invalidate()
            }
        }

    init {
        viewModelScope.launch {
            connectivity.collect { online ->
                if (!current() || online == !mutable.value.offline) return@collect
                connectivityGeneration++
                resetListReadFailures()
                mutable.value =
                    mutable.value.copy(
                        offline = !online,
                        listReadFailure = null,
                        sustainedRefreshFailure = false,
                    )
                refreshOnReconnect = online
                updateListRetryVisibility()
            }
        }
        viewModelScope.launch { for (ignored in listReadRequests) readPendingListBatch() }
        viewModelScope.launch {
            var saved: CachedUnread? = null
            for (snapshot in unreadCacheWrites) {
                if (
                    saved != null &&
                        saved.unreadAt == snapshot.unreadAt &&
                        snapshot.confirmedAt - saved.confirmedAt in
                            0 until unreadSnapshotRenewalMillis
                )
                    continue
                if (cache.saveUnread(snapshot)) saved = snapshot
            }
        }
        viewModelScope.launch {
            for (ignored in projectInvalidations) {
                projectsJob?.join()
                if (current()) {
                    refreshProjects()
                    projectsJob?.join()
                }
            }
        }
        viewModelScope.launch {
            for (ignored in indicatorInvalidations) {
                indicatorsJob?.join()
                val remaining =
                    indicatorsStartedAt?.let { (it + 1_000 - monotonicMillis()).coerceAtLeast(0) }
                        ?: 0
                if (!immediateIndicators && remaining > 0)
                    withTimeoutOrNull(remaining) {
                        // New status demand does not postpone the deadline. A read-cursor signal
                        // wakes it immediately and cannot be downgraded by later status demand.
                        while (!immediateIndicators) indicatorInvalidations.receive()
                    }
                // A manual read can replace the job while this worker waits or throttles.
                // Drain demand only after the current read finishes, so its guard cannot drop it.
                awaitIndicatorRead()
                while (indicatorInvalidations.tryReceive().isSuccess) {}
                immediateIndicators = false
                if (current()) {
                    refreshIndicators()
                    indicatorsJob?.join()
                }
            }
        }
    }

    private fun navigation() =
        mutable.value.let { state ->
            CachedChatNavigation(agents = state.agents.takeIf { state.agentsSource != null })
        }

    /** The commit identifies when a newer checkpoint already on disk needs to be loaded. */
    private suspend fun persistChats(adoptNewerCheckpoint: Boolean = false): CachedChats? =
        writes.withLock {
            val saved = confirmed ?: return@withLock null
            requireCurrent()
            val refs = navigation()
            try {
                val written = cache.save(saved.checkpoint, saved.confirmedAt, refs)
                val disk = if (!written && adoptNewerCheckpoint) cache.load() else null
                requireCurrent()
                mutable.value = mutable.value.copy(cacheUnavailable = false)
                if (disk != null && disk.checkpoint.cursor.seqId > saved.checkpoint.cursor.seqId)
                    disk
                else saved.copy(navigation = refs)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                requireCurrent()
                mutable.value = mutable.value.copy(cacheUnavailable = true)
                saved.copy(navigation = refs)
            }
        }

    private suspend fun persistProjects(saved: CachedProjects): CachedProjects =
        try {
            cache.saveProjects(saved.checkpoint, saved.confirmedAt)
            val disk = cache.loadProjects()
            requireCurrent()
            mutable.value = mutable.value.copy(projectCacheUnavailable = false)
            if (disk != null && disk.checkpoint.cursor.seqId > saved.checkpoint.cursor.seqId) disk
            else saved
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            requireCurrent()
            mutable.value = mutable.value.copy(projectCacheUnavailable = true)
            saved
        }

    private fun current() = !retired && authorized()

    private suspend fun requireCurrent() {
        currentCoroutineContext().ensureActive()
        if (!current()) throw CancellationException("Chat owner retired")
    }

    fun selectFilter(value: ChatListFilter) {
        val state = mutable.value
        if (!current() || state.filter == value) return
        filterGeneration++
        resetListFailureNotice()
        mutable.value = state.copy(filter = value, sustainedRefreshFailure = false)
        if (value == ChatListFilter.Unread && state.indicators == null) refreshIndicators()
    }

    internal fun markAllRead() {
        if (!current()) return
        val state = mutable.value
        val targets = state.markAllReadTargets()
        if (targets.isEmpty()) return
        val intents =
            targets.mapValues { (_, time) -> ChatReadIntent(ChatRowAction.MarkRead, time) }

        val write = CompletableDeferred<Unit>()
        intents.keys.forEach { readWrites[it] = write }
        mutable.value =
            state.copy(
                pendingRowActions =
                    state.pendingRowActions + targets.keys.associateWith { ChatRowAction.MarkRead },
                markingAllRead = true,
                markAllReadResult = null,
                readIntents = state.readIntents + intents,
            )
        viewModelScope.launch {
            var result: ChatMarkAllReadResult? = null
            try {
                val confirmations =
                    try {
                        coroutineScope {
                            intents
                                .map { (id, intent) ->
                                    async { writeReadIntent(id, intent, single = false) }
                                }
                                .awaitAll()
                        }
                    } finally {
                        targets.keys.forEach { readWrites.remove(it) }
                        write.complete(Unit)
                        if (current()) {
                            val state = mutable.value
                            mutable.value =
                                state.copy(
                                    pendingRowActions = state.pendingRowActions - targets.keys
                                )
                        }
                    }
                readIndicatorsAfterWrite()
                requireCurrent()
                result =
                    ChatMarkAllReadResult(
                        confirmations.count { it?.receiptCoversIntent == true },
                        targets.size,
                    )
            } finally {
                if (current()) {
                    mutable.value =
                        mutable.value.copy(markingAllRead = false, markAllReadResult = result)
                }
            }
        }
    }

    internal fun dismissMarkAllReadResult(result: ChatMarkAllReadResult) {
        if (current() && mutable.value.markAllReadResult == result) {
            mutable.value = mutable.value.copy(markAllReadResult = null)
        }
    }

    private suspend fun writeReadIntent(
        threadId: String,
        intent: ChatReadIntent,
        single: Boolean,
    ): ReadConfirmation? {
        val received =
            try {
                requireCurrent()
                if (intent.action == ChatRowAction.MarkUnread) {
                    service.markUnread(threadId).lastReadAt == null
                } else {
                    service.markRead(threadId).lastReadAt?.let(::chatTimestamp)?.let {
                        intent.through == null || it >= chatTimestamp(intent.through)
                    } == true
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
                requireCurrent()
                if (error is ApiFailure.Http && error.status in 400..499 && error.status != 408) {
                    val state = mutable.value
                    // A preceding write can still be awaiting its readback.
                    val earlier = readConfirmations[threadId]?.intent
                    mutable.value =
                        state.copy(
                            readIntents =
                                if (earlier == null) state.readIntents - threadId
                                else state.readIntents + (threadId to earlier),
                            failedRowAction = if (single) intent.action else state.failedRowAction,
                        )
                    return null
                }
                false
            }
        requireCurrent()
        return ReadConfirmation(intent, received, single).also { readConfirmations[threadId] = it }
    }

    private var undoSequence = 0L
    private var latestOfferedUndo = 0L

    internal fun undoRowAction(undo: ChatRowUndo) {
        val state = mutable.value
        if (!current() || state.rowUndo !== undo || undo.threadId in state.pendingRowActions) return
        val thread = state.undoTarget(undo)
        dismissRowUndo(undo)
        if (thread == null) return
        if (undo.inverse !in state.rowActions(thread)) {
            mutable.value = mutable.value.copy(failedRowAction = undo.inverse)
            return
        }
        performRowAction(undo.threadId, undo.inverse, title = null, offerUndo = false)
    }

    internal fun dismissRowUndo(undo: ChatRowUndo) {
        if (current() && mutable.value.rowUndo === undo)
            mutable.value = mutable.value.copy(rowUndo = null)
    }

    internal fun clearRowUndo() {
        // Commands from the previous list visit may still finish.
        latestOfferedUndo = undoSequence
        mutable.value.rowUndo?.let(::dismissRowUndo)
    }

    private fun ChatListUiState.undoTarget(undo: ChatRowUndo): ConfirmedChat? =
        threads
            .firstOrNull { it.id == undo.threadId && it.hidden != true }
            ?.takeIf { thread ->
                when (undo.action) {
                    ChatRowAction.Archive -> thread.archived
                    ChatRowAction.Unarchive -> !thread.archived
                    ChatRowAction.MarkRead -> !isUnread(thread.id) && thread.muted != true
                    else -> error("Chat action cannot be undone")
                }
            }

    private fun recordConfirmedUndo(threadId: String, candidate: ChatRowUndo?) {
        if (!current()) return
        val state = mutable.value
        if (
            candidate != null &&
                candidate.sequence > latestOfferedUndo &&
                state.undoTarget(candidate) != null
        ) {
            latestOfferedUndo = candidate.sequence
            mutable.value = state.copy(rowUndo = candidate)
        } else {
            val undo = state.rowUndo
            if (undo?.threadId == threadId && state.undoTarget(undo) == null) dismissRowUndo(undo)
        }
    }

    internal fun performRowAction(threadId: String, action: ChatRowAction): Boolean =
        performRowAction(threadId, action, title = null)

    internal fun renameThread(threadId: String, title: String) {
        performRowAction(threadId, ChatRowAction.Rename, title.trim())
    }

    private fun performRowAction(
        threadId: String,
        action: ChatRowAction,
        title: String?,
        offerUndo: Boolean = true,
    ): Boolean {
        if (!current()) return false
        val state = mutable.value
        val thread =
            state.threads.firstOrNull { it.id == threadId && it.hidden != true } ?: return false
        if (threadId in state.pendingRowActions) return false
        if (
            action == ChatRowAction.Rename &&
                (title.isNullOrBlank() || title == thread.title?.trim())
        )
            return false
        val pinGroup =
            if (action.changesPinOrder) chatListGroups(state).firstOrNull { thread in it.threads }
            else null
        val index = pinGroup?.threads?.indexOf(thread) ?: -1
        if (action !in state.rowActions(thread, pinGroup, index)) return false
        val archiveAction = action == ChatRowAction.Archive || action == ChatRowAction.Unarchive
        val undo =
            if (
                offerUndo &&
                    (archiveAction ||
                        action == ChatRowAction.MarkRead && state.filter == ChatListFilter.Unread)
            )
                ChatRowUndo(threadId, action, ++undoSequence)
            else null
        val acknowledgement =
            if (action == ChatRowAction.MarkUnread) history.stopAutomaticRead(threadId) else null
        val intent =
            if (!action.updatesChat) {
                ChatReadIntent(action, state.displayUnreadAt?.get(threadId))
            } else null
        val write =
            if (!action.updatesChat || action == ChatRowAction.Unmute) {
                CompletableDeferred<Unit>().also { readWrites[threadId] = it }
            } else null
        mutable.value =
            state.copy(
                pendingRowActions = state.pendingRowActions + (threadId to action),
                readIntents =
                    if (intent == null) state.readIntents
                    else state.readIntents + (threadId to intent),
            )
        viewModelScope.launch {
            try {
                val pinOrders =
                    try {
                        when (action) {
                            ChatRowAction.Pin ->
                                withContext(dispatcher) {
                                    val order =
                                        ChatPinOrder.first(checkNotNull(pinGroup).rankScope(state))
                                    listOf(ChatPinOrderUpdate(threadId, order))
                                }
                            ChatRowAction.MovePinUp,
                            ChatRowAction.MovePinDown ->
                                withContext(dispatcher) {
                                    val before = action == ChatRowAction.MovePinUp
                                    val group = checkNotNull(pinGroup)
                                    val target =
                                        checkNotNull(
                                            group.pinNeighbor(index, if (before) -1 else 1)
                                        )
                                    ChatPinOrder.move(
                                        group.rankScope(state),
                                        threadId,
                                        target.id,
                                        before,
                                    )
                                }
                            else -> emptyList()
                        }
                    } catch (_: IllegalArgumentException) {
                        requireCurrent()
                        mutable.value = mutable.value.copy(failedRowAction = action)
                        return@launch
                    }
                val edits =
                    when {
                        action.changesPinOrder && action != ChatRowAction.Unpin ->
                            pinOrders.map {
                                ChatRowEdit(it.threadId, newRowEventId(), action, it.pinOrder)
                            }
                        action.updatesChat ->
                            listOf(ChatRowEdit(threadId, newRowEventId(), action, title))
                        else -> emptyList()
                    }
                if (edits.isNotEmpty()) {
                    requireCurrent()
                    rowEdits = rowEdits + edits
                    publishRows()
                }
                var confirmation: ReadConfirmation? = null
                var writeRejected = false
                try {
                    acknowledgement?.join()
                    requireCurrent()
                    when (action) {
                        ChatRowAction.MarkRead,
                        ChatRowAction.MarkUnread ->
                            confirmation =
                                writeReadIntent(threadId, checkNotNull(intent), single = true)
                        ChatRowAction.Mute,
                        ChatRowAction.Unmute -> {
                            // Acknowledge replies that arrived while this chat was muted.
                            if (action == ChatRowAction.Unmute) markReadWithReceipt(threadId)
                            service.setMuted(
                                threadId,
                                action == ChatRowAction.Mute,
                                edits.single().eventId,
                            )
                        }
                        ChatRowAction.Archive,
                        ChatRowAction.Unarchive ->
                            service.setArchived(
                                threadId,
                                action == ChatRowAction.Archive,
                                edits.single().eventId,
                            )
                        ChatRowAction.Rename ->
                            service.renameThread(
                                threadId,
                                checkNotNull(title),
                                edits.single().eventId,
                            )
                        ChatRowAction.Delete ->
                            service.deleteThread(threadId, edits.single().eventId)
                        ChatRowAction.Pin,
                        ChatRowAction.Unpin ->
                            service.setPinned(
                                threadId,
                                edits.single().value,
                                edits.single().eventId,
                            )
                        ChatRowAction.MovePinUp,
                        ChatRowAction.MovePinDown -> {
                            // The tied suffix keeps its order even if the command stops partway.
                            for (edit in edits.asReversed()) {
                                requireCurrent()
                                service.reorderPinnedThread(
                                    edit.threadId,
                                    checkNotNull(edit.value),
                                    edit.eventId,
                                )
                            }
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    requireCurrent()
                    // The target may have disappeared while the workspace is still authorized.
                    if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
                    writeRejected =
                        error is ApiFailure.Http &&
                            (archiveAction && error.status in setOf(400, 401, 403, 404) ||
                                action == ChatRowAction.Delete &&
                                    error.status in setOf(400, 401, 404))
                    if (!action.updatesChat && current()) {
                        mutable.value = mutable.value.copy(failedRowAction = action)
                    }
                } finally {
                    if (write != null) {
                        readWrites.remove(threadId)
                        write.complete(Unit)
                    }
                    if (intent != null && current()) {
                        val state = mutable.value
                        mutable.value =
                            state.copy(pendingRowActions = state.pendingRowActions - threadId)
                    }
                }
                if (confirmation?.receiptCoversIntent == true) recordConfirmedUndo(threadId, undo)
                coroutineScope {
                    if (archiveAction) invalidateIndicators()
                    else if (action.updatesIndicators) launch { readIndicatorsAfterWrite() }
                    if (action.updatesChat && confirmRowEdits(action, edits, writeRejected))
                        recordConfirmedUndo(threadId, undo)
                }
                if (
                    confirmation?.receiptCoversIntent == false &&
                        current() &&
                        readConfirmations[threadId] === confirmation &&
                        mutable.value.readIntents[threadId] === confirmation.intent &&
                        mutable.value.indicatorsPhase == ChatReadPhase.Failed
                ) {
                    mutable.value = mutable.value.copy(failedRowAction = action)
                }
            } finally {
                if (intent == null && current()) {
                    mutable.value =
                        mutable.value.copy(
                            pendingRowActions = mutable.value.pendingRowActions - threadId
                        )
                }
            }
        }
        return true
    }

    private fun publishRows(state: ChatListUiState = mutable.value) {
        val rows = confirmedRows.withRowEdits(rowEdits)
        mutable.value = state.copy(threads = rows.threads, threadsByRecency = rows.byRecency)
    }

    internal fun reloadAfterRowActionFailure() {
        requestListRead(unconfirmedRowEvents + rejectedRowEvents, userRequested = true)
    }

    internal fun dismissRowActionFailure(action: ChatRowAction) {
        if (current() && mutable.value.failedRowAction == action) {
            mutable.value = mutable.value.copy(failedRowAction = null)
        }
    }

    private fun newRowEventId() = UUID.randomUUID().toString()

    private suspend fun markReadWithReceipt(threadId: String): ChatTimestamp? {
        val lastReadAt = service.markRead(threadId).lastReadAt
        requireCurrent()
        val watermark = lastReadAt?.let(::chatTimestamp) ?: return null
        // The current indicator request can still return unread evidence from before this receipt.
        if (indicatorsJob?.isActive == true) indicatorReadReceipts[threadId] = watermark
        val state = mutable.value
        val indicators = state.indicators
        val saved = state.cachedUnread
        if (indicators != null) {
            mutable.value =
                state.copy(indicators = indicators.acknowledgeUnread(threadId, watermark))
        } else if (saved != null) {
            val unreadAt = saved.unreadAt.acknowledgeUnread(threadId, watermark)
            mutable.value = state.copy(cachedUnread = saved.copy(unreadAt = unreadAt))
        }
        return watermark
    }

    private fun Indicators.acknowledgeUnread(
        threadId: String,
        watermark: ChatTimestamp,
    ): Indicators {
        val remainingUnread = unreadAt.acknowledgeUnread(threadId, watermark)
        if (remainingUnread === unreadAt) return this
        val remainingThreads =
            if (threads[threadId] == IndicatorsThreadsValue.UNREAD) threads - threadId else threads
        return copy(threads = remainingThreads, unreadAt = remainingUnread)
    }

    private fun Map<String, String>.acknowledgeUnread(
        threadId: String,
        watermark: ChatTimestamp,
    ): Map<String, String> {
        val unread = this[threadId] ?: return this
        return if (chatTimestamp(unread) <= watermark) this - threadId else this
    }

    fun refreshAfterSend(threadId: String) {
        refreshList()
        if (history.uiState.value.thread?.id == threadId) history.refreshAfterSend(threadId)
    }

    fun refresh() {
        if (!current()) return
        // Activity resume refreshes this owner even while workspace preferences are loading.
        expireCachedUnread()
        restoreCache()
        if (mutable.value.offline) return
        refreshList()
        refreshMetadata()
        refreshIndicators()
    }

    internal fun listVisibilityChanged(visible: Boolean, showingFilter: Boolean = visible) {
        listIsVisible = visible
        filterIsVisible = showingFilter
        updateListRetryVisibility()
    }

    private fun updateListRetryVisibility() {
        if (!current()) return
        if (!listIsVisible || !listInForeground || mutable.value.offline) {
            listRetry?.cancel()
            listRetry = null
            return
        }
        if (refreshOnReconnect) {
            refreshOnReconnect = false
            refresh()
        }
        val retryAt = listRetryAt ?: return
        if (listRetry != null) return
        val remaining = retryAt - monotonicMillis()
        if (remaining <= 0) {
            listRetryAt = null
            refreshList()
        } else {
            listRetry =
                viewModelScope.launch {
                    delay(remaining)
                    listRetry = null
                    listRetryAt = null
                    refreshList()
                }
        }
    }

    private fun restoreCache() {
        if (cacheRead) return
        cacheRead = true
        viewModelScope.launch { restoreUnread() }
        restoreJob =
            viewModelScope.launch {
                try {
                    val saved = cache.load() ?: return@launch
                    val projection = withContext(dispatcher) { replayChatList(saved.checkpoint) }
                    requireCurrent()
                    val state = mutable.value
                    confirmed = saved
                    confirmedRows = projection
                    publishRows(
                        state.copy(
                            confirmedAt = saved.confirmedAt,
                            source = ChatListSource.Cache,
                            agents =
                                if (state.agentsSource == ChatListSource.Network) state.agents
                                else saved.navigation.agents.orEmpty(),
                            agentsSource =
                                if (state.agentsSource == ChatListSource.Network)
                                    ChatListSource.Network
                                else saved.navigation.agents?.let { ChatListSource.Cache },
                        )
                    )
                    if (navigation() != saved.navigation) persistChats()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (current()) mutable.value = mutable.value.copy(cacheUnavailable = true)
                }
            }
        projectsRestoreJob =
            viewModelScope.launch {
                try {
                    val saved = cache.loadProjects() ?: return@launch
                    requireCurrent()
                    confirmedProjects = saved
                    showCachedProjects()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (current())
                        mutable.value = mutable.value.copy(projectCacheUnavailable = true)
                }
            }
    }

    private suspend fun restoreUnread() {
        val saved = cache.loadUnread() ?: return
        requireCurrent()
        val remaining = saved.remainingMillis(wallMillis())
        val state = mutable.value
        if (remaining == 0L || state.indicators != null) return
        mutable.value = state.copy(cachedUnread = saved)
        if (withTimeoutOrNull(remaining) { mutable.first { it.cachedUnread == null } } == null) {
            requireCurrent()
            mutable.value = mutable.value.copy(cachedUnread = null)
        }
    }

    private fun expireCachedUnread() {
        val state = mutable.value
        if (state.cachedUnread?.remainingMillis(wallMillis()) == 0L) {
            mutable.value = state.copy(cachedUnread = null)
        }
    }

    private suspend fun showCachedProjects() {
        val saved = confirmedProjects ?: return
        if (!current() || mutable.value.projectsSource == ChatListSource.Network) return
        val rows = withContext(dispatcher) { replayProjects(saved.checkpoint) }
        requireCurrent()
        if (mutable.value.projectsSource != ChatListSource.Network)
            mutable.value =
                mutable.value.copy(projects = rows, projectsSource = ChatListSource.Cache)
    }

    private fun listReadBatch(): ListReadBatch =
        pendingListRead ?: ListReadBatch().also { pendingListRead = it }

    fun refreshList() = requestListRead()

    internal fun retryList() = requestListRead(userRequested = true)

    private fun canRefreshList() = !mutable.value.offline && listRetryAt == null

    private fun requestListRead(
        discardOnSuccess: Set<String> = emptySet(),
        userRequested: Boolean = false,
    ) {
        if (!current() || (discardOnSuccess.isEmpty() && !canRefreshList())) return
        val batch = listReadBatch()
        batch.refresh = true
        batch.userRequested = batch.userRequested || userRequested
        batch.discardOnSuccess.addAll(discardOnSuccess)
        listReadRequests.trySend(Unit)
    }

    private suspend fun confirmRowEdits(
        action: ChatRowAction,
        edits: List<ChatRowEdit>,
        writeRejected: Boolean,
    ): Boolean {
        requireCurrent()
        if (edits.none { it in rowEdits }) return true
        // A missing response can still leave a committed event on the server.
        val completion = CompletableDeferred<Unit>(currentCoroutineContext()[Job])
        val batch = listReadBatch()
        batch.confirmations.add(ListConfirmation(edits, completion))
        if (writeRejected) {
            for (edit in edits) {
                if (edit in rowEdits) rejectedRowEvents.add(edit.eventId)
            }
        }
        listReadRequests.trySend(Unit)
        completion.await()
        requireCurrent()
        val unresolved = edits.filter { it in rowEdits }
        if (!writeRejected) unresolved.mapTo(unconfirmedRowEvents) { it.eventId }
        val deleted =
            action == ChatRowAction.Delete &&
                confirmedRows.byRecency.none { it.id == edits.single().threadId }
        if (!deleted && (writeRejected || unresolved.isNotEmpty())) {
            mutable.value = mutable.value.copy(failedRowAction = action)
        }
        return deleted || !writeRejected && unresolved.isEmpty()
    }

    private suspend fun readPendingListBatch() {
        val batch = pendingListRead
        pendingListRead = null
        val unconfirmed =
            batch?.confirmations.orEmpty().filter { confirmation ->
                if (confirmation.edits.any { it in rowEdits }) true
                else {
                    confirmation.done.complete(Unit)
                    false
                }
            }
        // Signals received during a read share the next batch. A write can skip it if an
        // earlier read settled its event IDs; cursorless refresh signals still need a read.
        if (batch != null && (batch.refresh || unconfirmed.isNotEmpty())) {
            val hasWriteReadback = unconfirmed.isNotEmpty() || batch.discardOnSuccess.isNotEmpty()
            if (!hasWriteReadback && !canRefreshList()) return
            listRebaseJob?.cancel()
            readyListRebase = null
            try {
                readList(batch, hasWriteReadback)
                unconfirmed.forEach { it.done.complete(Unit) }
            } finally {
                unconfirmed.forEach { it.done.cancel() }
            }
            return
        }

        // The same worker publishes both results, with pending refreshes taking priority.
        val rebased = readyListRebase ?: return
        readyListRebase = null
        if (confirmed?.checkpoint !== rebased.baseline) return
        // Keep unseen mutation IDs available to the next incremental confirmation read.
        if (
            rowEdits.isNotEmpty() &&
                rebased.result.checkpoint.snapshotCursor.seqId > rebased.baseline.cursor.seqId
        )
            return
        try {
            publishList(rebased.result, emptySet(), rebased.projection)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            requireCurrent()
            onFailure(error)
        }
    }

    private suspend fun readList(batch: ListReadBatch, hasWriteReadback: Boolean) {
        val generation = connectivityGeneration
        restoreJob?.join()
        requireCurrent()
        if (!hasWriteReadback && (mutable.value.offline || generation != connectivityGeneration))
            return
        val reportingFilterGeneration =
            filterGeneration.takeIf { !batch.userRequested && filterIsVisible && listInForeground }
        // A rejected edit stays recoverable if its first read fails. Only a read started after
        // the rejection can restore that row.
        val discardOnSuccess = batch.discardOnSuccess + rejectedRowEvents
        mutable.value = mutable.value.copy(listPhase = ChatReadPhase.Loading)
        try {
            val result = sync.synchronize(confirmed?.checkpoint)
            val retrying = mutable.value.listReadFailure == ChatListReadFailure.Retrying
            publishList(result, discardOnSuccess)
            if (retrying) refreshFailedListDependencies()
            if (result.shouldRebase && confirmed?.checkpoint === result.checkpoint) {
                startListRebase(result.checkpoint)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val retryAfter = if (hasWriteReadback) null else listRetryAfterMillis(error)
            fail(error) {
                it.copy(
                    listPhase = ChatReadPhase.Failed,
                    listReadFailure =
                        if (it.offline || generation != connectivityGeneration) it.listReadFailure
                        else if (retryAfter != null || listRetryAt != null)
                            ChatListReadFailure.Retrying
                        else ChatListReadFailure.NeedsRetry,
                )
            }
            if (
                !hasWriteReadback &&
                    current() &&
                    !mutable.value.offline &&
                    generation == connectivityGeneration
            ) {
                recordListReadFailure(retryAfter, reportingFilterGeneration)
            }
        }
    }

    private fun resetListReadFailures() {
        listRetry?.cancel()
        listRetry = null
        listRetryAt = null
        listFailures = 0
        resetListFailureNotice()
    }

    private fun resetListFailureNotice() {
        listFailureNotice?.cancel()
        listFailureNotice = null
        firstListFailureAt = null
        filterListFailures = 0
    }

    private fun recordListReadFailure(retryAfter: Long?, reportingFilterGeneration: Int?) {
        val now = monotonicMillis()
        if (reportingFilterGeneration == filterGeneration && filterListFailures < 3) {
            val firstFailure = firstListFailureAt ?: now.also { firstListFailureAt = it }
            filterListFailures++
            if (filterListFailures == 3) {
                val remaining = (30_000 - (now - firstFailure)).coerceAtLeast(0)
                listFailureNotice =
                    viewModelScope.launch {
                        delay(remaining)
                        if (current())
                            mutable.value = mutable.value.copy(sustainedRefreshFailure = true)
                    }
            }
        }
        if (retryAfter == null) return
        listFailures = (listFailures + 1).coerceAtMost(listRefreshRetryDelays.size)
        val delay = maxOf(listRefreshRetryDelays[listFailures - 1], retryAfter)
        listRetryAt = now + minOf(delay, Long.MAX_VALUE - now.coerceAtLeast(0L))
        updateListRetryVisibility()
    }

    private fun refreshFailedListDependencies() {
        val state = mutable.value
        if (
            state.agentsPhase == ChatReadPhase.Failed || state.projectsPhase == ChatReadPhase.Failed
        ) {
            refreshMetadata()
        }
        if (state.indicatorsPhase == ChatReadPhase.Failed) refreshIndicators()
    }

    private fun startListRebase(checkpoint: ChatCheckpoint) {
        listRebaseJob =
            viewModelScope.launch {
                try {
                    val rebased = sync.rebase(checkpoint) ?: return@launch
                    val projection = withContext(dispatcher) { replayChatList(rebased.checkpoint) }
                    requireCurrent()
                    readyListRebase = PreparedListRebase(checkpoint, rebased, projection)
                    listReadRequests.trySend(Unit)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    requireCurrent()
                    onFailure(error)
                }
            }
    }

    private suspend fun publishList(
        result: ChatListSync.Result,
        discardOnSuccess: Set<String>,
        preparedProjection: ReplayedChats? = null,
    ) {
        requireCurrent()
        val previous = confirmed
        val checkpoint = result.checkpoint
        val replayed =
            preparedProjection
                ?: if (checkpoint === previous?.checkpoint) confirmedRows
                else withContext(dispatcher) { replayChatList(checkpoint) }
        requireCurrent()
        val saved =
            if (!result.changed && previous != null && !mutable.value.cacheUnavailable) previous
            else {
                val confirmedAt =
                    previous?.confirmedAt?.takeUnless { result.changed }
                        ?: System.currentTimeMillis()
                confirmed = CachedChats(checkpoint, confirmedAt, navigation())
                checkNotNull(persistChats(adoptNewerCheckpoint = true))
            }
        val projection =
            if (saved.checkpoint === checkpoint) replayed
            else withContext(dispatcher) { replayChatList(saved.checkpoint) }
        requireCurrent()
        confirmed = saved
        confirmedRows = projection
        val editsAtPublish = rowEdits
        if (editsAtPublish.isNotEmpty()) {
            val observed = buildSet {
                checkpoint.snapshotCursor.eventId?.let(::add)
                checkpoint.events.forEach { it.cursor().eventId?.let(::add) }
                if (saved.checkpoint !== checkpoint) {
                    saved.checkpoint.snapshotCursor.eventId?.let(::add)
                    saved.checkpoint.events.forEach { it.cursor().eventId?.let(::add) }
                }
                addAll(result.eventIdsBeforeRebase)
                if (editsAtPublish.any { it.action == ChatRowAction.Delete }) {
                    val present = projection.byRecency.mapTo(hashSetOf()) { it.id }
                    for (edit in editsAtPublish) {
                        if (edit.action == ChatRowAction.Delete && edit.threadId !in present)
                            add(edit.eventId)
                    }
                }
            }
            settleRowEdits(observed, discardOnSuccess)
        }
        val state =
            mutable.value.copy(
                confirmedAt = saved.confirmedAt,
                source = ChatListSource.Network,
                listPhase = ChatReadPhase.Ready,
                listReadFailure = null,
                sustainedRefreshFailure = false,
            )
        resetListReadFailures()
        if (saved.checkpoint === previous?.checkpoint && rowEdits === editsAtPublish)
            mutable.value = state
        else publishRows(state)
    }

    private fun settleRowEdits(observed: Set<String>, discarded: Set<String>) {
        val settledThrough = mutableMapOf<Pair<String, ChatRowField>, Int>()
        rowEdits.forEachIndexed { index, edit ->
            if (edit.eventId in observed) settledThrough[edit.threadId to edit.field] = index
        }
        if (settledThrough.isEmpty() && discarded.isEmpty()) return
        rowEdits =
            rowEdits.filterIndexed { index, edit ->
                val settled =
                    edit.eventId in discarded ||
                        index <= (settledThrough[edit.threadId to edit.field] ?: -1)
                if (settled) {
                    unconfirmedRowEvents.remove(edit.eventId)
                    rejectedRowEvents.remove(edit.eventId)
                }
                !settled
            }
    }

    fun refreshMetadata() {
        if (!current() || mutable.value.offline) return
        if (agentsJob?.isActive != true) {
            mutable.value = mutable.value.copy(agentsPhase = ChatReadPhase.Loading)
            agentsJob =
                viewModelScope.launch {
                    try {
                        val result = service.agents()
                        withContext(dispatcher) { CachedChatNavigation(agents = result).validate() }
                        requireCurrent()
                        val changed =
                            mutable.value.agentsSource == null || result != mutable.value.agents
                        mutable.value =
                            mutable.value.copy(
                                agents = result,
                                agentsPhase = ChatReadPhase.Ready,
                                agentsSource = ChatListSource.Network,
                            )
                        if (changed || mutable.value.cacheUnavailable) persistChats()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        fail(error) { it.copy(agentsPhase = ChatReadPhase.Failed) }
                    }
                }
        }
        refreshProjects()
    }

    private fun refreshProjects() {
        if (current() && !mutable.value.offline && projectsJob?.isActive != true) {
            mutable.value = mutable.value.copy(projectsPhase = ChatReadPhase.Loading)
            projectsJob =
                viewModelScope.launch {
                    try {
                        projectsRestoreJob?.join()
                        requireCurrent()
                        val previous = confirmedProjects
                        val result = projectSync.synchronize(previous?.checkpoint)
                        val checkpoint = result.checkpoint
                        withContext(dispatcher) { replayProjects(checkpoint) }
                        requireCurrent()
                        val saved =
                            if (
                                !result.changed &&
                                    previous != null &&
                                    !mutable.value.projectCacheUnavailable
                            )
                                previous
                            else
                                persistProjects(
                                    CachedProjects(checkpoint, System.currentTimeMillis())
                                )
                        val rows = withContext(dispatcher) { replayProjects(saved.checkpoint) }
                        requireCurrent()
                        confirmedProjects = saved
                        mutable.value =
                            mutable.value.copy(
                                projects = rows,
                                projectsPhase = ChatReadPhase.Ready,
                                projectsSource = ChatListSource.Network,
                            )
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        // A missing Projects collection does not revoke the workspace session.
                        if (error is ApiFailure.Http && error.status == 404) {
                            if (current()) {
                                mutable.value =
                                    mutable.value.copy(
                                        projects = emptyList(),
                                        projectsSource = null,
                                        projectsPhase = ChatReadPhase.Failed,
                                    )
                            }
                        } else fail(error) { it.copy(projectsPhase = ChatReadPhase.Failed) }
                    }
                }
        }
    }

    private fun invalidateIndicators() {
        requestIndicators(immediate = true)
    }

    private fun requestIndicators(immediate: Boolean) {
        immediateIndicators = immediateIndicators || immediate
        indicatorInvalidations.trySend(Unit)
    }

    private suspend fun awaitIndicatorRead() {
        while (indicatorsJob?.isCompleted == false) indicatorsJob?.join()
    }

    private suspend fun readIndicatorsAfterWrite() {
        // A read already in flight may have started before the write.
        awaitIndicatorRead()
        requireCurrent()
        readIndicators()
        indicatorsJob?.join()
    }

    fun refreshIndicators() {
        if (!mutable.value.offline) readIndicators()
    }

    private fun readIndicators() {
        if (!current() || indicatorsJob?.isActive == true) return
        indicatorsStartedAt = monotonicMillis()
        mutable.value = mutable.value.copy(indicatorsPhase = ChatReadPhase.Loading)
        indicatorsJob =
            viewModelScope.launch {
                try {
                    // Responses can only settle writes that finished before this request.
                    val eligible = readConfirmations.toMap()
                    val result = service.indicators()
                    requireCurrent()
                    val unreadConfirmedAt = wallMillis()
                    val reconciled =
                        indicatorReadReceipts.entries.fold(result) { status, (id, watermark) ->
                            status.acknowledgeUnread(id, watermark)
                        }
                    val state = mutable.value
                    val settledVisible = mutableSetOf<String>()
                    var failed = state.failedRowAction
                    for ((id, confirmation) in eligible) {
                        if (readConfirmations[id] !== confirmation) continue
                        if (state.readIntents[id] === confirmation.intent) {
                            settledVisible.add(id)
                            // The unread list is bounded, so absence cannot prove a read write.
                            val observedUnread =
                                confirmation.intent.action == ChatRowAction.MarkUnread &&
                                    id in result.unreadAt
                            if (
                                confirmation.single &&
                                    !confirmation.receiptCoversIntent &&
                                    !observedUnread
                            ) {
                                failed = confirmation.intent.action
                            }
                        }
                        readConfirmations.remove(id)
                    }
                    mutable.value =
                        state.copy(
                            indicators = reconciled,
                            indicatorsPhase = ChatReadPhase.Ready,
                            cachedUnread = null,
                            readIntents = state.readIntents - settledVisible,
                            failedRowAction = failed,
                        )
                    unreadCacheWrites.trySend(CachedUnread(unreadConfirmedAt, reconciled.unreadAt))
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(error) { it.copy(indicatorsPhase = ChatReadPhase.Failed) }
                } finally {
                    indicatorReadReceipts.clear()
                }
            }
    }

    private fun fail(error: Exception, update: (ChatListUiState) -> ChatListUiState) {
        if (!current()) return
        onFailure(error)
        if (current()) mutable.value = update(mutable.value)
    }

    override fun onCleared() {
        retired = true
        updates.close()
        warming.close()
        listReadRequests.close()
        pendingListRead = null
        readyListRebase = null
        projectInvalidations.close()
        indicatorInvalidations.close()
        unreadCacheWrites.close()
        history.close()
        cache.close()
    }
}
