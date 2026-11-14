package ai.okou.android.auth

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.Organization
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.chatScopeHash
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.instructions.PersonalInstructionsModel
import ai.okou.android.preferences.MemberPreferencesModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class SessionStage {
    Restoring,
    SignIn,
    ChooseWorkspace,
    LoadingWorkspace,
    SigningOut,
    Ready,
    Unavailable,
    AccessRemoved,
    UpdateRequired,
}

data class ReadyWorkspace(
    val identity: WorkspaceIdentity,
    val organization: Organization,
    val preferences: MemberPreferencesModel,
    val chats: ChatListModel,
    val instructions: PersonalInstructionsModel,
)

data class SessionUiState(
    val generation: Long,
    val stage: SessionStage = SessionStage.Restoring,
    val memberships: List<WorkspaceMembership> = emptyList(),
    val ready: ReadyWorkspace? = null,
    val working: Boolean = false,
)

/** One owner for authorization, pending work and the currently permitted workspace resource. */
class SessionModel(
    private val authentication: Authentication,
    private val factory: WorkspaceSessionFactory,
    private val apiOrigin: String,
    private val chatCache: ChatCacheStore,
    private val instructionsDrafts: PersonalInstructionsDraftStore,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    @Volatile private var generation = 0L
    private val mutable = MutableStateFlow(SessionUiState(generation))
    val uiState = mutable.asStateFlow()
    private var observed: AuthenticationState? = null
    private var operation: Job? = null
    private var workspace: WorkspaceSession? = null
    private var presentation: ViewModelStore? = null

    init {
        viewModelScope.launch { authentication.state.collect { reconcile(it) } }
    }

    private fun retire() {
        generation++
        operation?.cancel()
        operation = null
        workspace?.close()
        workspace = null
        presentation?.clear()
        presentation = null
    }

    private fun reconcile(snapshot: AuthenticationState, force: Boolean = false) {
        // SDK token refreshes do not replace a stable identity or its presentation owner.
        if (!force && observed == snapshot) return
        observed = snapshot
        retire()
        val session = snapshot.session
        when {
            snapshot.failed -> mutable.value = SessionUiState(generation, SessionStage.Unavailable)
            !snapshot.initialized -> mutable.value = SessionUiState(generation)
            session == null -> mutable.value = SessionUiState(generation, SessionStage.SignIn)
            !snapshot.complete && !session.choosingWorkspace ->
                mutable.value = SessionUiState(generation, SessionStage.SignIn)
            else -> prepare(snapshot)
        }
    }

    private fun prepare(snapshot: AuthenticationState) {
        val session = checkNotNull(snapshot.session)
        val ticket = generation
        mutable.value = SessionUiState(generation, SessionStage.LoadingWorkspace, working = true)
        operation =
            viewModelScope.launch {
                try {
                    authentication.refresh(session)
                    requireCurrent(ticket, snapshot)
                    val memberships = authentication.memberships(session)
                    requireCurrent(ticket, snapshot)
                    if (
                        !snapshot.complete ||
                            !session.active ||
                            session.workspaceId == null ||
                            memberships.none { it.id == session.workspaceId }
                    ) {
                        mutable.value =
                            SessionUiState(generation, SessionStage.ChooseWorkspace, memberships)
                        return@launch
                    }
                    val identity =
                        WorkspaceIdentity(
                            apiOrigin,
                            session.userId,
                            session.sessionId,
                            session.workspaceId,
                            chatScopeHash(
                                listOf(memberships.first { it.id == session.workspaceId }.role) +
                                    snapshot.membershipAccess
                                        ?.firstOrNull { it.workspaceId == session.workspaceId }
                                        ?.let {
                                            listOf(
                                                it.role,
                                                if (it.permissions == null) "unknown" else "known",
                                            ) + it.permissions.orEmpty().sorted()
                                        }
                                        .orEmpty()
                            ),
                        )
                    val owner =
                        factory.create(
                            identity,
                            WorkspaceTokenProvider {
                                requireCurrent(ticket, snapshot)
                                val token = authentication.token(session)
                                currentCoroutineContext().ensureActive()
                                requireCurrent(ticket, snapshot)
                                token
                            },
                        )
                    workspace = owner
                    val data = owner.bootstrap()
                    currentCoroutineContext().ensureActive()
                    requireCurrent(ticket, snapshot)
                    val store = ViewModelStore()
                    presentation = store
                    val preferences =
                        ViewModelProvider(
                            store,
                            viewModelFactory {
                                initializer {
                                    MemberPreferencesModel(
                                        data.preferences,
                                        owner,
                                        authorized = { current(ticket, snapshot) },
                                        onFailure = { error ->
                                            workspaceFailure(ticket, snapshot, error)
                                        },
                                    )
                                }
                            },
                        )[MemberPreferencesModel::class.java]
                    val chats =
                        ViewModelProvider(
                            store,
                            viewModelFactory {
                                initializer {
                                    ChatListModel(
                                        owner,
                                        chatCache,
                                        identity,
                                        authorized = { current(ticket, snapshot) },
                                        onFailure = { error ->
                                            workspaceFailure(ticket, snapshot, error)
                                        },
                                        dispatcher = dispatcher,
                                    )
                                }
                            },
                        )[ChatListModel::class.java]
                    mutable.value =
                        SessionUiState(
                            generation,
                            SessionStage.Ready,
                            memberships,
                            ReadyWorkspace(
                                identity,
                                data.organization,
                                preferences,
                                chats,
                                ViewModelProvider(
                                    store,
                                    viewModelFactory {
                                        initializer {
                                            PersonalInstructionsModel(
                                                owner,
                                                instructionsDrafts,
                                                identity,
                                                { current(ticket, snapshot) },
                                                { error ->
                                                    workspaceFailure(ticket, snapshot, error)
                                                },
                                            )
                                        }
                                    },
                                )[PersonalInstructionsModel::class.java],
                            ),
                        )
                    chats.refresh()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current(ticket, snapshot)) {
                        workspace?.close()
                        workspace = null
                        val stage =
                            when {
                                error is ApiFailure.UpdateRequired -> SessionStage.UpdateRequired
                                error is ApiFailure.Unauthenticated ||
                                    error is ApiFailure.Http &&
                                        error.status in setOf(401, 403, 404) ->
                                    SessionStage.AccessRemoved
                                else -> SessionStage.Unavailable
                            }
                        mutable.value = SessionUiState(generation, stage)
                    }
                }
            }
    }

    private fun current(ticket: Long, snapshot: AuthenticationState): Boolean {
        return ticket == generation &&
            snapshot.initialized &&
            !snapshot.failed &&
            authentication.state.value == snapshot &&
            (snapshot.complete || snapshot.session?.choosingWorkspace == true)
    }

    private fun requireCurrent(ticket: Long, snapshot: AuthenticationState) {
        if (!current(ticket, snapshot)) throw CancellationException("Workspace owner retired")
    }

    private fun acceptsAction(expectedGeneration: Long): Boolean =
        expectedGeneration == generation && authentication.state.value == observed

    fun isPresentationCurrent(expectedGeneration: Long): Boolean = acceptsAction(expectedGeneration)

    fun refreshPreferences() {
        mutable.value.ready?.preferences?.refreshFromForeground()
        mutable.value.ready?.chats?.refresh()
    }

    private fun workspaceFailure(ticket: Long, snapshot: AuthenticationState, error: Exception) {
        if (!current(ticket, snapshot)) return
        val stage =
            when {
                error is ApiFailure.UpdateRequired -> SessionStage.UpdateRequired
                error is ApiFailure.Unauthenticated ||
                    error is ApiFailure.Http && error.status in setOf(401, 403, 404) ->
                    SessionStage.AccessRemoved
                else -> return
            }
        retire()
        mutable.value = SessionUiState(generation, stage)
    }

    fun retry(expectedGeneration: Long) {
        if (!acceptsAction(expectedGeneration)) return
        authentication.initialize()
        reconcile(authentication.state.value, force = true)
    }

    fun chooseWorkspace(id: String, expectedGeneration: Long) {
        if (!acceptsAction(expectedGeneration)) return
        val snapshot = authentication.state.value
        val session = snapshot.session ?: return
        if (mutable.value.working || mutable.value.memberships.none { it.id == id }) return
        if (mutable.value.ready?.identity?.workspaceId == id) return
        retire()
        val ticket = generation
        mutable.value = SessionUiState(generation, SessionStage.LoadingWorkspace, working = true)
        operation =
            viewModelScope.launch {
                try {
                    authentication.selectWorkspace(session, id)
                    currentCoroutineContext().ensureActive()
                    if (generation == ticket) reconcile(authentication.state.value, force = true)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (generation == ticket)
                        mutable.value = SessionUiState(generation, SessionStage.Unavailable)
                }
            }
    }

    fun signOut(expectedGeneration: Long) {
        if (!acceptsAction(expectedGeneration)) return
        if (mutable.value.stage == SessionStage.SigningOut) return
        retire()
        val ticket = generation
        mutable.value = SessionUiState(generation, SessionStage.SigningOut, working = true)
        operation =
            viewModelScope.launch {
                try {
                    authentication.signOut()
                    currentCoroutineContext().ensureActive()
                    if (generation == ticket) reconcile(authentication.state.value, force = true)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (generation == ticket)
                        mutable.value = SessionUiState(generation, SessionStage.Unavailable)
                }
            }
    }

    override fun onCleared() {
        retire()
    }
}
