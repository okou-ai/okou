package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.Indicators
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
    val projectCacheUnavailable: Boolean = false,
    val agents: Agents = emptyList(),
    val agentsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val agentsSource: ChatListSource? = null,
    val projects: List<ConfirmedProject> = emptyList(),
    val projectsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val projectsSource: ChatListSource? = null,
    val indicators: Indicators? = null,
    val indicatorsPhase: ChatReadPhase = ChatReadPhase.Idle,
    val filter: ChatListFilter = ChatListFilter.Recent,
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
    private var confirmed: CachedChats? = null
    private var confirmedProjects: CachedProjects? = null
    private var cacheRead = false
    private var projectsSettingsJob: Job? = null
    private var restoreJob: Job? = null
    private var projectsRestoreJob: Job? = null
    private var listJob: Job? = null
    private var agentsJob: Job? = null
    private var projectsJob: Job? = null
    private var indicatorsJob: Job? = null
    private val writes = Mutex()
    private val projectSync = ProjectSync(service, dispatcher)

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
                    val threads = withContext(dispatcher) { replayChats(saved.checkpoint) }
                    requireCurrent()
                    val state = mutable.value
                    val networkSettings = state.projectsSettingsSource == ChatListSource.Network
                    confirmed = saved
                    mutable.value =
                        state.copy(
                            projectsSettingsSource =
                                if (networkSettings) ChatListSource.Network
                                else ChatListSource.Cache,
                            projectsEnabled =
                                if (networkSettings) state.projectsEnabled
                                else saved.navigation.projectsEnabled,
                            threads = threads,
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

    fun refreshList() {
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
                    withContext(dispatcher) { replayChats(checkpoint) }
                    requireCurrent()
                    val saved =
                        if (!result.changed && previous != null && !mutable.value.cacheUnavailable)
                            previous
                        else {
                            confirmed =
                                CachedChats(checkpoint, System.currentTimeMillis(), navigation())
                            checkNotNull(persistChats(readBack = true))
                        }
                    val threads = withContext(dispatcher) { replayChats(saved.checkpoint) }
                    requireCurrent()
                    confirmed = saved
                    mutable.value =
                        mutable.value.copy(
                            threads = threads,
                            confirmedAt = saved.confirmedAt,
                            source = ChatListSource.Network,
                            listPhase = ChatReadPhase.Ready,
                        )
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

    fun refreshIndicators() {
        if (!current() || indicatorsJob?.isActive == true) return
        mutable.value = mutable.value.copy(indicatorsPhase = ChatReadPhase.Loading)
        indicatorsJob =
            viewModelScope.launch {
                try {
                    val result = service.indicators()
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
