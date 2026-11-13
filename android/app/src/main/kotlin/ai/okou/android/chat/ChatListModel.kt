package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.ProjectsProjectsItem
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class ChatReadPhase {
    Idle,
    Loading,
    Ready,
    Failed,
}

enum class ChatListFilter {
    Recent,
    Unread,
    Archived,
    Muted,
}

enum class ChatListSource {
    Cache,
    Network,
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
    val agents: Agents = emptyList(),
    val agentsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val agentsSource: ChatListSource? = null,
    val projects: List<ProjectsProjectsItem> = emptyList(),
    val projectsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val projectsSource: ChatListSource? = null,
    val indicators: Indicators? = null,
    val indicatorsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val filter: ChatListFilter = ChatListFilter.Recent,
)

private data class PendingChatCacheWrite(
    val checkpoint: ChatCheckpoint,
    val confirmedAt: Long,
    val navigation: CachedChatNavigation,
    val revision: Long,
)

/** Workspace-retained HTTP observations; no row collector owns synchronization or durable state. */
class ChatListModel(
    private val service: ChatListService,
    cacheStore: ChatCacheStore,
    identity: WorkspaceIdentity,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    private val mutable = MutableStateFlow(ChatListUiState())
    val uiState = mutable.asStateFlow()
    @Volatile private var retired = false
    private val cache = cacheStore.open(identity) { current() }
    private val sync = ChatListSync(service, dispatcher)
    private var checkpoint: ChatCheckpoint? = null
    private var cacheRead = false
    private var projectsSettingsJob: Job? = null
    private var restoreJob: Job? = null
    private var listJob: Job? = null
    private var agentsJob: Job? = null
    private var projectsJob: Job? = null
    private var indicatorsJob: Job? = null
    private val writes = MutableStateFlow<PendingChatCacheWrite?>(null)
    private var writeRevision = 0L

    init {
        // A single latest-snapshot writer owns persistence from both list and reference reads.
        viewModelScope.launch {
            writes.collectLatest { pending ->
                if (pending != null) {
                    try {
                        cache.save(pending.checkpoint, pending.confirmedAt, pending.navigation)
                        currentCoroutineContext().ensureActive()
                        if (current()) mutable.value = mutable.value.copy(cacheUnavailable = false)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        currentCoroutineContext().ensureActive()
                        if (current()) mutable.value = mutable.value.copy(cacheUnavailable = true)
                    }
                }
            }
        }
    }

    private fun queueSave() {
        val confirmed = checkpoint ?: return
        val state = mutable.value
        val time = state.confirmedAt ?: return
        if (!current()) return
        writes.value =
            PendingChatCacheWrite(
                confirmed,
                time,
                CachedChatNavigation(
                    agents = state.agents.takeIf { state.agentsSource != null },
                    projects = state.projects.takeIf { state.projectsSource != null },
                    projectsEnabled = state.projectsEnabled,
                ),
                ++writeRevision,
            )
    }

    private fun current() = !retired && authorized()

    private suspend fun requireCurrent() {
        currentCoroutineContext().ensureActive()
        if (!current()) throw CancellationException("Chat owner retired")
    }

    fun selectFilter(value: ChatListFilter) {
        if (current()) mutable.value = mutable.value.copy(filter = value)
    }

    fun refresh() {
        if (!current()) return
        restoreCache()
        refreshList()
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
                    queueSave()
                    refreshProjects()
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
                    val threads = withContext(dispatcher) { replayChats(saved.checkpoint) }
                    currentCoroutineContext().ensureActive()
                    if (!current()) return@launch
                    val state = mutable.value
                    val networkSettings = state.projectsSettingsSource == ChatListSource.Network
                    val projectGroups =
                        if (networkSettings) state.projectsEnabled
                        else saved.navigation.projectsEnabled
                    val restoreList = state.source != ChatListSource.Network
                    if (restoreList) checkpoint = saved.checkpoint
                    mutable.value =
                        state.copy(
                            projectsSettingsSource =
                                if (networkSettings) ChatListSource.Network
                                else ChatListSource.Cache,
                            projectsEnabled = projectGroups,
                            threads = if (restoreList) threads else state.threads,
                            confirmedAt = if (restoreList) saved.confirmedAt else state.confirmedAt,
                            source = if (restoreList) ChatListSource.Cache else state.source,
                            agents =
                                if (state.agentsSource == ChatListSource.Network) state.agents
                                else saved.navigation.agents.orEmpty(),
                            agentsSource =
                                if (state.agentsSource == ChatListSource.Network)
                                    ChatListSource.Network
                                else saved.navigation.agents?.let { ChatListSource.Cache },
                            projects =
                                if (!projectGroups) emptyList()
                                else if (state.projectsSource == ChatListSource.Network)
                                    state.projects
                                else saved.navigation.projects.orEmpty(),
                            projectsSource =
                                if (!projectGroups) null
                                else if (state.projectsSource == ChatListSource.Network)
                                    ChatListSource.Network
                                else saved.navigation.projects?.let { ChatListSource.Cache },
                        )
                    if (
                        networkSettings ||
                            state.source == ChatListSource.Network ||
                            state.agentsSource == ChatListSource.Network ||
                            state.projectsSource == ChatListSource.Network
                    )
                        queueSave()
                    refreshProjects()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (current()) mutable.value = mutable.value.copy(cacheUnavailable = true)
                }
            }
    }

    fun refreshList() {
        if (!current() || listJob?.isActive == true) return
        mutable.value = mutable.value.copy(listPhase = ChatReadPhase.Loading)
        listJob =
            viewModelScope.launch {
                try {
                    restoreJob?.join()
                    requireCurrent()
                    val confirmed = sync.synchronize(checkpoint)
                    val threads = withContext(dispatcher) { replayChats(confirmed) }
                    requireCurrent()
                    val time = System.currentTimeMillis()
                    checkpoint = confirmed
                    mutable.value =
                        mutable.value.copy(
                            threads = threads,
                            confirmedAt = time,
                            source = ChatListSource.Network,
                            listPhase = ChatReadPhase.Ready,
                        )
                    queueSave()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(error) { it.copy(listPhase = ChatReadPhase.Failed) }
                }
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
                        mutable.value =
                            mutable.value.copy(
                                agents = result,
                                agentsPhase = ChatReadPhase.Ready,
                                agentsSource = ChatListSource.Network,
                            )
                        queueSave()
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
                        val result = service.projects().projects
                        val ordered =
                            withContext(dispatcher) {
                                requireChatWire(
                                    result.size <= MAX_CHAT_THREADS &&
                                        result.map { it.id }.distinct().size == result.size
                                )
                                val times =
                                    result.associate {
                                        requireChatId(it.id)
                                        it.id to chatTimestamp(it.createdAt)
                                    }
                                result.sortedWith(
                                    compareBy<ProjectsProjectsItem> { times[it.id] }
                                        .thenBy { it.id }
                                )
                            }
                        requireCurrent()
                        if (mutable.value.projectsEnabled)
                            mutable.value =
                                mutable.value.copy(
                                    projects = ordered,
                                    projectsPhase = ChatReadPhase.Ready,
                                    projectsSource = ChatListSource.Network,
                                )
                        queueSave()
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
                                queueSave()
                            }
                        } else fail(error) { it.copy(projectsPhase = ChatReadPhase.Failed) }
                    }
                }
        }
    }

    fun refreshIndicators() {
        if (!current() || indicatorsJob?.isActive == true) return
        mutable.value = mutable.value.copy(indicatorsPhase = ChatReadPhase.Loading)
        indicatorsJob =
            viewModelScope.launch {
                try {
                    val result = service.indicators()
                    requireChatWire(
                        result.agents.size <= MAX_CHAT_THREADS &&
                            result.threads.size <= MAX_CHAT_THREADS &&
                            result.unreadAt.size <= MAX_CHAT_THREADS
                    )
                    requireCurrent()
                    mutable.value =
                        mutable.value.copy(
                            indicators = result,
                            indicatorsPhase = ChatReadPhase.Ready,
                        )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(error) { it.copy(indicatorsPhase = ChatReadPhase.Failed) }
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
        cache.close()
    }
}
