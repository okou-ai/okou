package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.IndicatorsThreadsValue
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Deferred
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

class ChatRowActionFailure
internal constructor(
    val action: ChatRowAction,
    internal val rejected: Boolean = false,
    internal val edits: List<ChatRowEdit> = emptyList(),
)

internal enum class ChatUndoPhase {
    Offered,
    Checking,
    Failed,
    Unconfirmed,
}

@ConsistentCopyVisibility
data class ChatRowUndo
internal constructor(
    val threadId: String,
    val action: ChatRowAction,
    internal val sequence: Long,
    internal val phase: ChatUndoPhase = ChatUndoPhase.Offered,
) {
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
    val agents: Agents = emptyList(),
    val agentsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val agentsSource: ChatListSource? = null,
    val projectList: ProjectListUiState = ProjectListUiState(),
    val indicators: Indicators? = null,
    val indicatorsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val filter: ChatListFilter = ChatListFilter.Inbox,
    val pendingRowActions: Map<String, ChatRowAction> = emptyMap(),
    val failedRowAction: ChatRowActionFailure? = null,
    val rowUndo: ChatRowUndo? = null,
    val markingAllRead: Boolean = false,
    val markAllReadResult: ChatMarkAllReadResult? = null,
    internal val cachedUnread: CachedUnread? = null,
    internal val readIntents: Map<String, ChatReadIntent> = emptyMap(),
    internal val threadsByRecency: List<ConfirmedChat> = emptyList(),
    internal val acceptedNewChats: List<ProvisionalChat> = emptyList(),
) {
    val projects: List<ConfirmedProject>
        get() = projectList.rows

    val projectsPhase: ChatReadPhase
        get() = projectList.phase

    val projectsSource: ChatListSource?
        get() = projectList.source

    val projectCacheUnavailable: Boolean
        get() = projectList.cacheUnavailable

    val renamingProjectId: String?
        get() = projectList.renamingId

    val unconfirmedProjectRenames: Set<String>
        get() = projectList.unconfirmedRenames

    internal val projectRenameRejection: ProjectRenameRejection?
        get() = projectList.renameRejection
}

internal val ChatListUiState.canRenameProject: Boolean
    get() = projectList.canRename(offline)

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
    if (source != null && pendingRowActions.values.none { it.changesPinOrder }) {
        val pinned = thread.pinnedAt != null
        if (pinned) add(ChatRowAction.Unpin)
        // A refresh retains the last synchronized rank scope while it fetches the next one.
        if (
            group != null &&
                source == ChatListSource.Network &&
                listPhase != ChatReadPhase.Failed &&
                listReadFailure == null &&
                projectsSource != null &&
                (group.projectId == null || group.project != null)
        ) {
            if (!pinned) add(ChatRowAction.Pin)
            else if (filter == ChatListFilter.Inbox) {
                if (group.pinNeighbor(index, -1) != null) add(ChatRowAction.MovePinUp)
                if (group.pinNeighbor(index, 1) != null) add(ChatRowAction.MovePinDown)
            }
        }
    }
    val canUpdateUnread = indicators != null || (cachedUnread != null && !offline)
    if (canUpdateUnread && indicatorsPhase != ChatReadPhase.Failed && thread.muted != true) {
        add(if (isUnread(thread.id)) ChatRowAction.MarkRead else ChatRowAction.MarkUnread)
    }
    if (source != null) {
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
    private val identity: WorkspaceIdentity,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    realtime: RealtimeService? = null,
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    connectivity: Flow<Boolean> = emptyFlow(),
    private val wallMillis: () -> Long = System::currentTimeMillis,
    initialFilter: ChatListFilter = ChatListFilter.Inbox,
) : ViewModel() {
    private val mutable = MutableStateFlow(ChatListUiState(filter = initialFilter))
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
    private val projection = ChatListProjection()
    private val rowMutations =
        ChatRowMutationOwner(
            service,
            projection,
            dispatcher,
            requireCurrent = ::requireCurrent,
            onFailure = onFailure,
            publishRows = { publishRows() },
            awaitListRead = ::awaitListRead,
        )
    private val projectOwner =
        ProjectListOwner(
            service,
            cache,
            viewModelScope,
            current = ::current,
            offline = { mutable.value.offline },
            onFailure = onFailure,
            dispatcher = dispatcher,
            wallMillis = wallMillis,
            readState = { mutable.value.projectList },
            publish = { mutable.value = mutable.value.copy(projectList = it) },
        )
    private var cacheRead = false
    private var restoreJob: Job? = null
    private var agentsJob: Job? = null
    private var indicatorsJob: Job? = null
    private val indicatorReadReceipts = mutableMapOf<String, ChatTimestamp>()
    private val readConfirmations = mutableMapOf<String, ReadConfirmation>()
    private val writes = Mutex()

    private class ListReadBatch {
        var refresh = false
        var userRequested = false
        val discardOnSuccess = mutableSetOf<String>()
        val confirmations = mutableListOf<ListConfirmation>()
    }

    private class ListConfirmation(
        val needsRead: () -> Boolean,
        val done: CompletableDeferred<Unit>,
    )

    private class ReadConfirmation(
        val intent: ChatReadIntent,
        val receiptCoversIntent: Boolean,
        val reportFailure: Boolean,
    ) {
        var observedUnread = false
    }

    private class PreparedListRebase(
        val baseline: ChatCheckpoint,
        val result: ChatListSync.Result,
        val projection: ReplayedChats,
    )

    private var pendingListRead: ListReadBatch? = null
    private val rowDiscardsAfterRead = mutableSetOf<String>()
    private val acceptedChatsToVerify = mutableSetOf<String>()
    private val verifyingAcceptedChats = mutableSetOf<String>()
    internal var onAcceptedChatMissing: ((String) -> Unit)? = null
    // Reconciliation survives transport backoff and lasts until a read publishes successfully.
    private var completedActivityReconciliation: Any? = null
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
                    projectOwner.invalidate()
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
                                    async { writeReadIntent(id, intent, reportFailure = false) }
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
        reportFailure: Boolean,
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
                            failedRowAction =
                                if (reportFailure) ChatRowActionFailure(intent.action)
                                else state.failedRowAction,
                        )
                    return null
                }
                false
            }
        requireCurrent()
        return ReadConfirmation(intent, received, reportFailure).also {
            readConfirmations[threadId] = it
        }
    }

    private var undoSequence = 0L
    private var latestOfferedUndo = 0L

    internal fun undoRowAction(undo: ChatRowUndo) {
        val state = mutable.value
        if (
            !current() ||
                state.offline ||
                state.rowUndo !== undo ||
                undo.phase != ChatUndoPhase.Offered ||
                undo.threadId in state.pendingRowActions
        )
            return
        if (
            state.undoTarget(undo) == null ||
                !performRowAction(undo.threadId, undo.inverse, title = null, undoRequest = undo)
        ) {
            mutable.value = state.copy(rowUndo = undo.copy(phase = ChatUndoPhase.Failed))
        }
    }

    internal fun dismissRowUndo(undo: ChatRowUndo) {
        if (current() && mutable.value.rowUndo?.sequence == undo.sequence)
            mutable.value = mutable.value.copy(rowUndo = null)
    }

    private fun completeRowUndo(undo: ChatRowUndo, phase: ChatUndoPhase?) {
        val state = mutable.value
        if (current() && state.rowUndo?.sequence == undo.sequence) {
            val notice =
                when (phase) {
                    null -> null
                    undo.phase -> undo
                    else -> undo.copy(phase = phase)
                }
            mutable.value = state.copy(rowUndo = notice)
        }
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
            if (
                undo?.phase == ChatUndoPhase.Offered &&
                    undo.threadId == threadId &&
                    state.undoTarget(undo) == null
            )
                dismissRowUndo(undo)
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
        undoRequest: ChatRowUndo? = null,
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
                undoRequest == null &&
                    (archiveAction ||
                        action == ChatRowAction.MarkRead && state.filter == ChatListFilter.Unread)
            )
                ChatRowUndo(threadId, action, ++undoSequence)
            else null
        val readSession =
            if (action == ChatRowAction.MarkUnread) history.readSessionFor(threadId) else null
        val acknowledgement = readSession?.pendingAutomaticRead
        val connectivityAtPress = connectivityGeneration
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
                rowUndo = undoRequest?.copy(phase = ChatUndoPhase.Checking) ?: state.rowUndo,
                readIntents =
                    if (intent == null || undoRequest != null) state.readIntents
                    else state.readIntents + (threadId to intent),
            )
        viewModelScope.launch {
            try {
                val edits =
                    try {
                        if (action.updatesChat)
                            rowMutations.prepareEdits(
                                threadId,
                                action,
                                title,
                                pinGroup,
                                index,
                                state,
                            )
                        else emptyList()
                    } catch (_: IllegalArgumentException) {
                        requireCurrent()
                        mutable.value =
                            mutable.value.copy(
                                failedRowAction = ChatRowActionFailure(action, rejected = true)
                            )
                        return@launch
                    }
                val confirmation: ReadConfirmation?
                val submission: ChatRowMutationOwner.Submission?
                try {
                    acknowledgement?.join()
                    requireCurrent()
                    if (undoRequest != null) {
                        // A disconnect while waiting for automatic read requires a fresh press.
                        val latest = mutable.value
                        val interrupted =
                            when {
                                connectivityAtPress != connectivityGeneration ->
                                    ChatUndoPhase.Offered
                                latest.undoTarget(undoRequest) == null -> ChatUndoPhase.Failed
                                else -> null
                            }
                        if (interrupted != null) {
                            completeRowUndo(undoRequest, interrupted)
                            return@launch
                        }
                        if (intent != null) {
                            mutable.value =
                                latest.copy(readIntents = latest.readIntents + (threadId to intent))
                        }
                    }
                    // New acknowledgements wait behind this write. Stop the original visit only
                    // once the inverse is going to be sent.
                    readSession?.stopAutomaticRead()
                    if (intent != null) {
                        confirmation =
                            writeReadIntent(threadId, intent, reportFailure = undoRequest == null)
                        submission = null
                    } else {
                        confirmation = null
                        submission =
                            rowMutations.submit(action, edits) {
                                // Acknowledge replies that arrived while this chat was muted.
                                markReadWithReceipt(threadId)
                            }
                    }
                } finally {
                    if (write != null) {
                        readWrites.remove(threadId)
                        write.complete(Unit)
                    }
                    if (intent != null && undoRequest == null && current()) {
                        val state = mutable.value
                        mutable.value =
                            state.copy(pendingRowActions = state.pendingRowActions - threadId)
                    }
                }
                requireCurrent()
                val rollback = submission?.let(rowMutations::discardRejected)
                val rolledBack = rollback != null
                if (rolledBack) {
                    val state = mutable.value
                    publishRows(
                        if (
                            rollback == ChatRowMutationOwner.Rollback.CheckMissingDelete ||
                                undoRequest != null
                        )
                            state
                        else
                            state.copy(
                                failedRowAction = ChatRowActionFailure(action, rejected = true)
                            )
                    )
                    if (rollback == ChatRowMutationOwner.Rollback.MissingTarget) refreshList()
                }
                val confirmedRead = confirmation?.receiptCoversIntent
                val settledRead = intent != null && (confirmation == null || confirmedRead == true)
                if (undoRequest != null && (settledRead || rolledBack)) {
                    if (rollback == ChatRowMutationOwner.Rollback.Rejected) refreshList()
                    completeRowUndo(
                        undoRequest,
                        if (confirmedRead == true) null else ChatUndoPhase.Failed,
                    )
                    invalidateIndicators()
                    return@launch
                }
                if (undoRequest == null && confirmedRead == true)
                    recordConfirmedUndo(threadId, undo)
                val confirmedEdits = coroutineScope {
                    if (archiveAction || rolledBack && action.updatesIndicators)
                        invalidateIndicators()
                    else if (action.updatesIndicators) launch { readIndicatorsAfterWrite() }
                    if (submission == null) return@coroutineScope false
                    val failure = rowMutations.confirm(submission, rollback)
                    if (undoRequest == null) {
                        if (failure != null)
                            mutable.value = mutable.value.copy(failedRowAction = failure)
                        else if (!rolledBack) recordConfirmedUndo(threadId, undo)
                    }
                    failure == null
                }
                requireCurrent()
                when {
                    undoRequest != null -> {
                        completeRowUndo(
                            undoRequest,
                            if (confirmedEdits || confirmation?.observedUnread == true) null
                            else ChatUndoPhase.Unconfirmed,
                        )
                    }
                    confirmation?.receiptCoversIntent == false &&
                        readConfirmations[threadId] === confirmation &&
                        mutable.value.readIntents[threadId] === confirmation.intent &&
                        mutable.value.indicatorsPhase == ChatReadPhase.Failed ->
                        mutable.value =
                            mutable.value.copy(failedRowAction = ChatRowActionFailure(action))
                }
            } finally {
                if ((intent == null || undoRequest != null) && current()) {
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
        val rows = projection.rows()
        mutable.value =
            state.copy(
                threads = rows.threads,
                threadsByRecency = rows.byRecency,
                acceptedNewChats = projection.acceptedNewChats,
            )
    }

    internal fun retainAcceptedNewChats(chats: List<ProvisionalChat>, restored: Boolean = false) {
        if (!current() || chats.isEmpty()) return
        // A new draft can replace the composer target while these chats await their list rows.
        val state = mutable.value
        projection.retainAcceptedNewChats(chats)
        mutable.value = state.copy(acceptedNewChats = projection.acceptedNewChats)
        if (restored) {
            chats.mapTo(acceptedChatsToVerify) { it.threadId }
            if (state.source == ChatListSource.Network) verifyAcceptedChats()
        }
    }

    private fun verifyAcceptedChats() {
        if (acceptedChatsToVerify.isEmpty()) return
        val accepted = projection.acceptedNewChats
        acceptedChatsToVerify.retainAll(accepted.map { it.threadId }.toSet())
        for (chat in accepted) {
            val id = chat.threadId
            if (id !in acceptedChatsToVerify || !verifyingAcceptedChats.add(id)) continue
            viewModelScope.launch {
                try {
                    verifyAcceptedChat(id)
                } finally {
                    verifyingAcceptedChats.remove(id)
                }
            }
        }
    }

    private suspend fun verifyAcceptedChat(id: String) {
        // Consume the current request before reading so a newer snapshot can request another read.
        while (acceptedChatsToVerify.remove(id)) {
            requireCurrent()
            if (projection.acceptedNewChats.none { it.threadId == id }) return
            try {
                service.threadDetail(id)
                requireCurrent()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                if (error is ApiFailure.Http && error.status == 404) {
                    acceptedChatsToVerify.remove(id)
                    if (projection.removeMissingAcceptedChat(id)) {
                        mutable.value =
                            mutable.value.copy(acceptedNewChats = projection.acceptedNewChats)
                        onAcceptedChatMissing?.invoke(id)
                    }
                    return
                }
                if (
                    error is ApiFailure.Unauthenticated ||
                        error is ApiFailure.UpdateRequired ||
                        error is ApiFailure.Http && error.status == 401
                ) {
                    onFailure(error)
                }
                // Wait for another list publication unless newer verification is already queued.
                if (acceptedChatsToVerify.add(id)) return
            }
        }
    }

    internal fun reloadAfterRowActionFailure() {
        requestListRead(projection.retryEvents(), userRequested = true)
    }

    internal fun dismissRowActionFailure(failure: ChatRowActionFailure) {
        if (current() && mutable.value.failedRowAction === failure) {
            mutable.value = mutable.value.copy(failedRowAction = null)
        }
    }

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

    internal fun showOutgoingActivity(pending: PendingText) {
        if (!current() || pending.create != null) return
        val id = pending.send.chatThreadSortEventId ?: return
        if (projection.showOutgoing(id, pending.threadId)) publishRows()
    }

    internal fun acknowledgeOutgoingActivity(pending: PendingText) {
        if (!current()) return
        // Send accepts the input before the server's list sort work finishes.
        projection.completeOutgoing(pending.send.chatThreadSortEventId)
    }

    internal fun refreshAfterSendFailure(pending: PendingText, rejected: Boolean) {
        if (!current()) return
        if (projection.completeOutgoing(pending.send.chatThreadSortEventId, rejected)) publishRows()
        refreshList()
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
        requestListRead(resetCompletedActivity = true)
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

    internal fun restoreStartupCache(prepared: Deferred<PreparedChatList?>) {
        restoreCache(prepared)
    }

    private fun restoreCache(prepared: Deferred<PreparedChatList?>? = null) {
        if (cacheRead) return
        cacheRead = true
        viewModelScope.launch { restoreUnread() }
        val chatRestore =
            viewModelScope.launch {
                try {
                    val startup = prepared?.await()?.takeIf { it.identity == identity }
                    val saved = startup?.saved ?: cache.load() ?: return@launch
                    val rows =
                        startup?.rows
                            ?: withContext(dispatcher) { replayChatList(saved.checkpoint) }
                    requireCurrent()
                    val state = mutable.value
                    confirmed = saved
                    projection.restore(saved.checkpoint, rows)
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
        restoreJob = chatRestore
        projectOwner.restore(afterChatCache = chatRestore)
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

    private fun listReadBatch(): ListReadBatch =
        pendingListRead ?: ListReadBatch().also { pendingListRead = it }

    fun refreshList() = requestListRead()

    internal fun retryList() = requestListRead(userRequested = true)

    private fun canRefreshList() = !mutable.value.offline && listRetryAt == null

    private fun requestListRead(
        discardOnSuccess: Set<String> = emptySet(),
        userRequested: Boolean = false,
        resetCompletedActivity: Boolean = userRequested,
    ) {
        if (!current()) return
        if (resetCompletedActivity) completedActivityReconciliation = Any()
        if (discardOnSuccess.isEmpty() && !canRefreshList()) return
        val batch = listReadBatch()
        batch.refresh = true
        batch.userRequested = batch.userRequested || userRequested
        batch.discardOnSuccess.addAll(discardOnSuccess)
        listReadRequests.trySend(Unit)
    }

    private suspend fun awaitListRead(needsRead: () -> Boolean) {
        val completion = CompletableDeferred<Unit>(currentCoroutineContext()[Job])
        val batch = listReadBatch()
        batch.confirmations.add(ListConfirmation(needsRead, completion))
        listReadRequests.trySend(Unit)
        completion.await()
    }

    private suspend fun readPendingListBatch() {
        val batch = pendingListRead
        pendingListRead = null
        val unconfirmed =
            batch?.confirmations.orEmpty().filter { confirmation ->
                if (confirmation.needsRead()) true
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
            projection.hasPendingMutations &&
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
        // Keep the exact IDs selected by an explicit refresh until a read succeeds.
        rowDiscardsAfterRead.addAll(batch.discardOnSuccess)
        val reportingFilterGeneration =
            filterGeneration.takeIf {
                (!hasWriteReadback || batch.refresh) &&
                    !batch.userRequested &&
                    filterIsVisible &&
                    listInForeground
            }
        mutable.value = mutable.value.copy(listPhase = ChatReadPhase.Loading)
        try {
            // A normal catch-up still needs the sort event. Resume or an explicit refresh can
            // restore the canonical order for completed attempts after a successful read.
            val reconciliation = completedActivityReconciliation
            val finishedActivity =
                if (reconciliation != null) projection.completedOutgoingAttempts() else emptyMap()
            val result = sync.synchronize(confirmed?.checkpoint)
            val retrying = mutable.value.listReadFailure == ChatListReadFailure.Retrying
            publishList(result, rowDiscardsAfterRead, finishedActivity = finishedActivity)
            rowDiscardsAfterRead.clear()
            if (completedActivityReconciliation === reconciliation)
                completedActivityReconciliation = null
            if (retrying) refreshFailedListDependencies()
            if (result.shouldRebase && confirmed?.checkpoint === result.checkpoint) {
                startListRebase(result.checkpoint)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val retryAfter = listRetryAfterMillis(error)
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
            if (current() && !mutable.value.offline && generation == connectivityGeneration) {
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
        val nextRetry = now + minOf(delay, Long.MAX_VALUE - now.coerceAtLeast(0L))
        listRetryAt = maxOf(nextRetry, listRetryAt ?: nextRetry)
        listRetry?.cancel()
        listRetry = null
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
        finishedActivity: Map<String, ChatListProjection.OutgoingAttempt> = emptyMap(),
    ) {
        requireCurrent()
        val previous = confirmed
        val checkpoint = result.checkpoint
        val replayed =
            preparedProjection
                ?: if (checkpoint === previous?.checkpoint) projection.confirmedRows
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
        val rows =
            if (saved.checkpoint === checkpoint) replayed
            else withContext(dispatcher) { replayChatList(saved.checkpoint) }
        requireCurrent()
        confirmed = saved
        val projectionChanged =
            projection.reconcile(result, saved.checkpoint, rows, discardOnSuccess, finishedActivity)
        val previousState = mutable.value
        val state =
            previousState.copy(
                confirmedAt = saved.confirmedAt,
                source = ChatListSource.Network,
                listPhase = ChatReadPhase.Ready,
                listReadFailure = null,
                sustainedRefreshFailure = false,
                failedRowAction =
                    previousState.failedRowAction?.takeUnless {
                        it.edits.isNotEmpty() && !projection.hasUnsettledEdits(it.edits)
                    },
            )
        resetListReadFailures()
        if (projectionChanged) publishRows(state) else mutable.value = state
        // Snapshot absence can also mean a creation raced the read. Verify by thread ID.
        if (result.replacedSnapshot)
            projection.acceptedNewChats.mapTo(acceptedChatsToVerify) { it.threadId }
        verifyAcceptedChats()
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
        projectOwner.refresh()
    }

    internal fun renameProject(id: String, input: String) = projectOwner.renameProject(id, input)

    internal fun retryProjectRename(id: String) = projectOwner.retryProjectRename(id)

    internal fun dismissProjectRenameRejection(rejection: ProjectRenameRejection) =
        projectOwner.dismissProjectRenameRejection(rejection)

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
                            confirmation.observedUnread =
                                confirmation.intent.action == ChatRowAction.MarkUnread &&
                                    id in result.unreadAt
                            if (
                                confirmation.reportFailure &&
                                    !confirmation.receiptCoversIntent &&
                                    !confirmation.observedUnread
                            ) {
                                failed = ChatRowActionFailure(confirmation.intent.action)
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
        projectOwner.close()
        indicatorInvalidations.close()
        unreadCacheWrites.close()
        history.close()
        cache.close()
    }
}
