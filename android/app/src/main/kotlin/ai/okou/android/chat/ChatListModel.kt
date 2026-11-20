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
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

enum class ChatReadPhase {
    Idle,
    Loading,
    Ready,
    Failed,
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
    Rename(updatesIndicators = false),
    Pin(updatesIndicators = false, changesPinOrder = true),
    Unpin(updatesIndicators = false, changesPinOrder = true),
    MovePinUp(updatesIndicators = false, changesPinOrder = true),
    MovePinDown(updatesIndicators = false, changesPinOrder = true),
}

data class ChatListUiState(
    val projectsEnabled: Boolean = false,
    val projectsSettingsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val projectsSettingsSource: ChatListSource? = null,
    val threads: List<ConfirmedChat> = emptyList(),
    val listPhase: ChatReadPhase = ChatReadPhase.Idle,
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
    val markingAllRead: Boolean = false,
    val markAllReadResult: ChatMarkAllReadResult? = null,
    internal val threadsByRecency: List<ConfirmedChat> = emptyList(),
)

internal fun ChatListUiState.rowActions(
    thread: ConfirmedChat,
    group: ChatListGroup? = null,
    index: Int = -1,
): List<ChatRowAction> = buildList {
    val unreadAt = indicators?.unreadAt
    if (unreadAt != null && indicatorsPhase != ChatReadPhase.Failed && thread.muted != true) {
        add(if (thread.id in unreadAt) ChatRowAction.MarkRead else ChatRowAction.MarkUnread)
    }
    if (listPhase != ChatReadPhase.Failed) {
        add(ChatRowAction.Rename)
        add(if (thread.muted == true) ChatRowAction.Unmute else ChatRowAction.Mute)
        add(if (thread.archived) ChatRowAction.Unarchive else ChatRowAction.Archive)
    }
    // A refresh retains the last synchronized rank scope while it fetches the next one.
    if (
        group != null &&
            source == ChatListSource.Network &&
            listPhase != ChatReadPhase.Failed &&
            projectsSettingsSource != null &&
            (!projectsEnabled || projectsSource != null) &&
            pendingRowActions.values.none { it.changesPinOrder }
    ) {
        val pinned = thread.pinnedAt != null
        add(if (pinned) ChatRowAction.Unpin else ChatRowAction.Pin)
        if (pinned && filter == ChatListFilter.Inbox) {
            if (group.pinNeighbor(index, -1) != null) add(ChatRowAction.MovePinUp)
            if (group.pinNeighbor(index, 1) != null) add(ChatRowAction.MovePinDown)
        }
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
    private var confirmedProjects: CachedProjects? = null
    private var cacheRead = false
    private var projectsSettingsJob: Job? = null
    private var restoreJob: Job? = null
    private var projectsRestoreJob: Job? = null
    private var listJob: Job? = null
    private var agentsJob: Job? = null
    private var projectsJob: Job? = null
    private var indicatorsJob: Job? = null
    private val indicatorReadReceipts = mutableMapOf<String, ChatTimestamp>()
    private val writes = Mutex()
    private val projectSync = ProjectSync(service, dispatcher)
    private val listInvalidations = Channel<Unit>(Channel.CONFLATED)
    private val projectInvalidations = Channel<Unit>(Channel.CONFLATED)
    private val indicatorInvalidations = Channel<Unit>(Channel.CONFLATED)
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
        )
    val updates =
        ChatUpdatesModel(
            realtime,
            viewModelScope,
            { current() },
            onFailure,
            history.output,
            foregroundChanged = warming::foreground,
        ) { changes ->
            if (current()) {
                if (changes.resync || changes.list) {
                    listInvalidations.trySend(Unit)
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
            for (ignored in listInvalidations) {
                awaitListRead()
                if (current()) {
                    refreshList()
                    listJob?.join()
                }
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
            CachedChatNavigation(
                agents = state.agents.takeIf { state.agentsSource != null },
                projectsEnabled = state.projectsEnabled,
            )
        }

    /** Await commit and readback before a new network list becomes visible, as on Web. */
    private suspend fun persistChats(readBack: Boolean = false): CachedChats? =
        writes.withLock {
            val saved = confirmed ?: return@withLock null
            requireCurrent()
            val refs = navigation()
            try {
                cache.save(saved.checkpoint, saved.confirmedAt, refs)
                val disk = if (readBack) cache.load() else null
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
        if (current()) mutable.value = mutable.value.copy(filter = value)
    }

    internal fun markAllRead() {
        if (!current()) return
        val state = mutable.value
        val targets = state.markAllReadTargets()
        if (targets.isEmpty()) return

        val write = CompletableDeferred<Unit>()
        targets.keys.forEach { readWrites[it] = write }
        mutable.value =
            state.copy(
                pendingRowActions =
                    state.pendingRowActions + targets.keys.associateWith { ChatRowAction.MarkRead },
                markingAllRead = true,
                markAllReadResult = null,
            )
        viewModelScope.launch {
            var result: ChatMarkAllReadResult? = null
            try {
                val confirmed =
                    try {
                        coroutineScope {
                            targets
                                .map { (id, unreadAt) -> async { acknowledgeUnread(id, unreadAt) } }
                                .awaitAll()
                                .count { it }
                        }
                    } finally {
                        targets.keys.forEach { readWrites.remove(it) }
                        write.complete(Unit)
                    }
                readIndicatorsAfterWrite()
                requireCurrent()
                result = ChatMarkAllReadResult(confirmed, targets.size)
            } finally {
                if (current()) {
                    mutable.value =
                        mutable.value.copy(
                            pendingRowActions = mutable.value.pendingRowActions - targets.keys,
                            markingAllRead = false,
                            markAllReadResult = result,
                        )
                }
            }
        }
    }

    internal fun dismissMarkAllReadResult(result: ChatMarkAllReadResult) {
        if (current() && mutable.value.markAllReadResult == result) {
            mutable.value = mutable.value.copy(markAllReadResult = null)
        }
    }

    private suspend fun acknowledgeUnread(threadId: String, unreadAt: String): Boolean {
        return try {
            requireCurrent()
            val observed = chatTimestamp(unreadAt)
            markReadWithReceipt(threadId)?.let { it >= observed } == true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            requireCurrent()
            if (error !is ApiFailure.Http || error.status != 404) onFailure(error)
            false
        }
    }

    internal fun performRowAction(threadId: String, action: ChatRowAction) =
        performRowAction(threadId, action, title = null)

    internal fun renameThread(threadId: String, title: String) =
        performRowAction(threadId, ChatRowAction.Rename, title.trim())

    private fun performRowAction(threadId: String, action: ChatRowAction, title: String?) {
        if (!current()) return
        val state = mutable.value
        val thread = state.threads.firstOrNull { it.id == threadId && it.hidden != true } ?: return
        if (threadId in state.pendingRowActions) return
        if (
            action == ChatRowAction.Rename &&
                (title.isNullOrBlank() || title == thread.title?.trim())
        )
            return
        val pinGroup =
            if (action.changesPinOrder) chatListGroups(state).firstOrNull { thread in it.threads }
            else null
        val index = pinGroup?.threads?.indexOf(thread) ?: -1
        if (action !in state.rowActions(thread, pinGroup, index)) return
        val acknowledgement =
            if (action == ChatRowAction.MarkUnread) history.stopAutomaticRead(threadId) else null
        val write =
            if (!action.updatesChat || action == ChatRowAction.Unmute) {
                CompletableDeferred<Unit>().also { readWrites[threadId] = it }
            } else null
        mutable.value =
            state.copy(pendingRowActions = state.pendingRowActions + (threadId to action))
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
                try {
                    acknowledgement?.join()
                    requireCurrent()
                    when (action) {
                        ChatRowAction.MarkRead -> markReadWithReceipt(threadId)
                        ChatRowAction.MarkUnread -> service.markUnread(threadId)
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
                    if (!action.updatesChat && current()) {
                        mutable.value = mutable.value.copy(failedRowAction = action)
                    }
                } finally {
                    if (write != null) {
                        readWrites.remove(threadId)
                        write.complete(Unit)
                    }
                }
                if (action.updatesIndicators) readIndicatorsAfterWrite()
                if (action.updatesChat) {
                    // A missing response can still leave a committed event on the server.
                    awaitListRead()
                    requireCurrent()
                    refreshList()
                    listJob?.join()
                    requireCurrent()
                    val unresolved = edits.filter { it in rowEdits }
                    if (unresolved.isNotEmpty()) {
                        unconfirmedRowEvents.addAll(unresolved.map { it.eventId })
                        mutable.value = mutable.value.copy(failedRowAction = action)
                    }
                }
            } finally {
                if (current()) {
                    mutable.value =
                        mutable.value.copy(
                            pendingRowActions = mutable.value.pendingRowActions - threadId
                        )
                }
            }
        }
    }

    private fun publishRows(state: ChatListUiState = mutable.value) {
        val rows = confirmedRows.withRowEdits(rowEdits)
        mutable.value = state.copy(threads = rows.threads, threadsByRecency = rows.byRecency)
    }

    internal fun reloadAfterRowActionFailure() {
        val unresolved = unconfirmedRowEvents.toSet()
        viewModelScope.launch {
            awaitListRead()
            requireCurrent()
            refreshList(discardOnSuccess = unresolved)
        }
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
        state.indicators?.let {
            mutable.value = state.copy(indicators = it.acknowledgeUnread(threadId, watermark))
        }
        return watermark
    }

    private fun Indicators.acknowledgeUnread(
        threadId: String,
        watermark: ChatTimestamp,
    ): Indicators {
        val unread = unreadAt[threadId] ?: return this
        if (chatTimestamp(unread) > watermark) return this
        val remainingThreads =
            if (threads[threadId] == IndicatorsThreadsValue.UNREAD) threads - threadId else threads
        return copy(threads = remainingThreads, unreadAt = unreadAt - threadId)
    }

    fun refreshAfterSend(threadId: String) {
        viewModelScope.launch {
            listJob?.join()
            if (current()) refreshList()
        }
        if (history.uiState.value.thread?.id == threadId) history.refreshAfterSend(threadId)
    }

    fun refresh() = refresh(userInitiated = false)

    internal fun refresh(userInitiated: Boolean) {
        if (!current()) return
        restoreCache()
        if (userInitiated) reloadAfterRowActionFailure() else refreshList()
        refreshMetadata()
        refreshIndicators()
    }

    private fun refreshProjectsSettings() {
        if (!current() || projectsSettingsJob?.isActive == true) return
        mutable.value = mutable.value.copy(projectsSettingsPhase = ChatReadPhase.Loading)
        projectsSettingsJob =
            viewModelScope.launch {
                try {
                    val flags = service.featureSwitches().effectiveSwitches
                    currentCoroutineContext().ensureActive()
                    if (!current()) return@launch
                    val projects = flags["projects"] == true
                    val changed = projects != mutable.value.projectsEnabled
                    if (!projects) projectsJob?.cancel()
                    mutable.value =
                        mutable.value.copy(
                            projectsSettingsSource = ChatListSource.Network,
                            projectsSettingsPhase = ChatReadPhase.Ready,
                            projectsEnabled = projects,
                            projects = if (projects) mutable.value.projects else emptyList(),
                            projectsSource = if (projects) mutable.value.projectsSource else null,
                            projectsPhase =
                                if (projects) mutable.value.projectsPhase else ChatReadPhase.Idle,
                        )
                    showCachedProjects()
                    refreshProjects()
                    if (changed || mutable.value.cacheUnavailable) persistChats()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(error) { it.copy(projectsSettingsPhase = ChatReadPhase.Failed) }
                }
            }
    }

    private fun restoreCache() {
        if (cacheRead) return
        cacheRead = true
        restoreJob =
            viewModelScope.launch {
                try {
                    val saved = cache.load() ?: return@launch
                    val projection = withContext(dispatcher) { replayChatList(saved.checkpoint) }
                    requireCurrent()
                    val state = mutable.value
                    val networkSettings = state.projectsSettingsSource == ChatListSource.Network
                    confirmed = saved
                    confirmedRows = projection
                    publishRows(
                        state.copy(
                            projectsSettingsSource =
                                if (networkSettings) ChatListSource.Network
                                else ChatListSource.Cache,
                            projectsEnabled =
                                if (networkSettings) state.projectsEnabled
                                else saved.navigation.projectsEnabled,
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
                    showCachedProjects()
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

    private suspend fun showCachedProjects() {
        val saved = confirmedProjects ?: return
        if (
            !current() ||
                !mutable.value.projectsEnabled ||
                mutable.value.projectsSource == ChatListSource.Network
        )
            return
        val rows = withContext(dispatcher) { replayProjects(saved.checkpoint) }
        requireCurrent()
        if (mutable.value.projectsEnabled && mutable.value.projectsSource != ChatListSource.Network)
            mutable.value =
                mutable.value.copy(projects = rows, projectsSource = ChatListSource.Cache)
    }

    private suspend fun awaitListRead() {
        while (listJob?.isCompleted == false) listJob?.join()
    }

    fun refreshList() = refreshList(discardOnSuccess = emptySet())

    private fun refreshList(discardOnSuccess: Set<String>) {
        if (!current() || listJob?.isActive == true) return
        mutable.value = mutable.value.copy(listPhase = ChatReadPhase.Loading)
        listJob =
            viewModelScope.launch {
                try {
                    restoreJob?.join()
                    requireCurrent()
                    val previous = confirmed
                    val result = sync.synchronize(previous?.checkpoint)
                    val checkpoint = result.checkpoint
                    val replayed = withContext(dispatcher) { replayChatList(checkpoint) }
                    requireCurrent()
                    val saved =
                        if (!result.changed && previous != null && !mutable.value.cacheUnavailable)
                            previous
                        else {
                            confirmed =
                                CachedChats(checkpoint, System.currentTimeMillis(), navigation())
                            checkNotNull(persistChats(readBack = true))
                        }
                    val projection =
                        if (saved.checkpoint === checkpoint) replayed
                        else withContext(dispatcher) { replayChatList(saved.checkpoint) }
                    requireCurrent()
                    confirmed = saved
                    confirmedRows = projection
                    if (rowEdits.isNotEmpty()) {
                        val observed = buildSet {
                            addAll(discardOnSuccess)
                            saved.checkpoint.snapshotCursor.eventId?.let(::add)
                            checkpoint.snapshotCursor.eventId?.let(::add)
                            saved.checkpoint.events.forEach { it.cursor().eventId?.let(::add) }
                            checkpoint.events.forEach { it.cursor().eventId?.let(::add) }
                            addAll(result.eventIdsBeforeRebase)
                        }
                        settleRowEdits(observed)
                    }
                    publishRows(
                        mutable.value.copy(
                            confirmedAt = saved.confirmedAt,
                            source = ChatListSource.Network,
                            listPhase = ChatReadPhase.Ready,
                        )
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(error) { it.copy(listPhase = ChatReadPhase.Failed) }
                }
            }
    }

    private fun settleRowEdits(observed: Set<String>) {
        val settledThrough = mutableMapOf<Pair<String, ChatRowField>, Int>()
        rowEdits.forEachIndexed { index, edit ->
            if (edit.eventId in observed) settledThrough[edit.threadId to edit.field] = index
        }
        rowEdits =
            rowEdits.filterIndexed { index, edit ->
                val settled = index <= (settledThrough[edit.threadId to edit.field] ?: -1)
                if (settled) unconfirmedRowEvents.remove(edit.eventId)
                !settled
            }
    }

    fun refreshMetadata() {
        if (!current()) return
        refreshProjectsSettings()
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
        if (current() && mutable.value.projectsEnabled && projectsJob?.isActive != true) {
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
                        if (mutable.value.projectsEnabled)
                            mutable.value =
                                mutable.value.copy(
                                    projects = rows,
                                    projectsPhase = ChatReadPhase.Ready,
                                    projectsSource = ChatListSource.Network,
                                )
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        // The Projects collection itself returns 404 when its rollout is off.
                        // A stale switch read must not turn that into workspace revocation.
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
        refreshIndicators()
        indicatorsJob?.join()
    }

    fun refreshIndicators() {
        if (!current() || indicatorsJob?.isActive == true) return
        indicatorsStartedAt = monotonicMillis()
        mutable.value = mutable.value.copy(indicatorsPhase = ChatReadPhase.Loading)
        indicatorsJob =
            viewModelScope.launch {
                try {
                    val result = service.indicators()
                    requireCurrent()
                    val reconciled =
                        indicatorReadReceipts.entries.fold(result) { status, (id, watermark) ->
                            status.acknowledgeUnread(id, watermark)
                        }
                    mutable.value =
                        mutable.value.copy(
                            indicators = reconciled,
                            indicatorsPhase = ChatReadPhase.Ready,
                        )
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
        listInvalidations.close()
        projectInvalidations.close()
        indicatorInvalidations.close()
        history.close()
        cache.close()
    }
}
