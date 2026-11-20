package ai.okou.android.auth

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.Organization
import ai.okou.android.chat.AssistantRecoveryModel
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.RunControlJournalStore
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.chat.chatScopeHash
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.instructions.PersonalInstructionsModel
import ai.okou.android.preferences.MemberAppearance
import ai.okou.android.preferences.MemberAppearanceCache
import ai.okou.android.preferences.MemberPreferencesModel
import ai.okou.android.preferences.appearance
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
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map
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
    val composer: ChatComposerModel,
    val controls: RunControlsModel,
    val recovery: AssistantRecoveryModel,
)

sealed interface OpeningWorkspace {
    val identity: WorkspaceIdentity

    data class CheckingAccess(override val identity: WorkspaceIdentity) : OpeningWorkspace

    data class Authorized(
        override val identity: WorkspaceIdentity,
        val organization: Organization,
        val chats: ChatListModel,
    ) : OpeningWorkspace
}

data class SessionUiState(
    val generation: Long,
    val stage: SessionStage = SessionStage.Restoring,
    val memberships: List<WorkspaceMembership> = emptyList(),
    val ready: ReadyWorkspace? = null,
    val working: Boolean = false,
    val cachedAppearance: MemberAppearance? = null,
    val opening: OpeningWorkspace? = null,
)

/** One owner for authorization, pending work and the currently permitted workspace resource. */
class SessionModel(
    private val authentication: Authentication,
    private val factory: WorkspaceSessionFactory,
    private val apiOrigin: String,
    private val chatCache: ChatCacheStore,
    private val instructionsDrafts: PersonalInstructionsDraftStore,
    private val composerJournal: ComposerJournalStore,
    private val runControlJournal: RunControlJournalStore,
    private val appearanceCache: MemberAppearanceCache,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    updatesRequired: Flow<Boolean> = emptyFlow(),
) : ViewModel() {
    @Volatile private var generation = 0L
    private val mutable = MutableStateFlow(SessionUiState(generation))
    val uiState = mutable.asStateFlow()
    private var observed: AuthenticationState? = null
    private var operation: Job? = null
    private var membershipLoad: Job? = null
    private var membershipsComplete = false
    private var workspace: WorkspaceSession? = null
    private var presentation: ViewModelStore? = null
    private var requiredUpdate = false

    init {
        viewModelScope.launch { authentication.state.collect { reconcile(it) } }
        viewModelScope.launch {
            updatesRequired.collect { required ->
                if (required && !requiredUpdate) enterRequiredUpdate()
            }
        }
    }

    private fun retire() {
        generation++
        operation?.cancel()
        operation = null
        membershipLoad?.cancel()
        membershipLoad = null
        membershipsComplete = false
        workspace?.close()
        workspace = null
        presentation?.clear()
        presentation = null
    }

    private fun enterRequiredUpdate() {
        val state = mutable.value
        val appearance =
            state.ready?.preferences?.uiState?.value?.confirmed?.appearance
                ?: state.cachedAppearance
        requiredUpdate = true
        retire()
        mutable.value =
            SessionUiState(generation, SessionStage.UpdateRequired, cachedAppearance = appearance)
    }

    private fun reconcile(snapshot: AuthenticationState, force: Boolean = false) {
        if (requiredUpdate) return
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
        val initialIdentity =
            session.workspaceId
                ?.takeIf { snapshot.complete && session.active }
                ?.let { WorkspaceIdentity(apiOrigin, session.userId, session.sessionId, it) }
        mutable.value =
            SessionUiState(
                ticket,
                SessionStage.LoadingWorkspace,
                working = true,
                opening = initialIdentity?.let { OpeningWorkspace.CheckingAccess(it) },
            )
        operation =
            viewModelScope.launch {
                val appearanceRead =
                    initialIdentity?.let { identity ->
                        launch readCache@{
                            val appearance = appearanceCache.load(identity) ?: return@readCache
                            val state = mutable.value
                            if (current(ticket, snapshot) && state.opening != null) {
                                mutable.value = state.copy(cachedAppearance = appearance)
                            }
                        }
                    }
                val cacheWarm =
                    initialIdentity?.let {
                        launch {
                            try {
                                chatCache.warmConnection()
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Exception) {
                                // Scoped restore handles storage errors after authorization.
                            }
                        }
                    }
                try {
                    val refreshedAccess = authentication.refresh(session)
                    requireCurrent(ticket, snapshot)
                    val access =
                        snapshot.membershipAccess?.firstOrNull {
                            it.workspaceId == initialIdentity?.workspaceId
                        }
                    val fastAccess =
                        access?.takeIf { it.permissions != null && it == refreshedAccess }
                    val memberships =
                        if (fastAccess == null) authentication.memberships(session) else emptyList()
                    requireCurrent(ticket, snapshot)
                    membershipsComplete = fastAccess == null
                    val membership =
                        initialIdentity?.let { identity ->
                            memberships.firstOrNull { it.id == identity.workspaceId }
                        }
                    val role = fastAccess?.role ?: membership?.role
                    if (initialIdentity == null || role == null) {
                        mutable.value =
                            SessionUiState(generation, SessionStage.ChooseWorkspace, memberships)
                        return@launch
                    }
                    val identity =
                        initialIdentity.copy(
                            authorizationScope =
                                chatScopeHash(
                                    listOf(role) +
                                        refreshedAccess
                                            ?.let {
                                                listOf(
                                                    it.role,
                                                    if (it.permissions == null) "unknown"
                                                    else "known",
                                                ) + it.permissions.orEmpty().sorted()
                                            }
                                            .orEmpty()
                                )
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
                    val organization = owner.organization()
                    currentCoroutineContext().ensureActive()
                    requireCurrent(ticket, snapshot)
                    val store = ViewModelStore()
                    presentation = store
                    val chats =
                        store.workspaceModel {
                            ChatListModel(
                                owner,
                                chatCache,
                                identity,
                                authorized = { current(ticket, snapshot) },
                                onFailure = { error -> workspaceFailure(ticket, snapshot, error) },
                                dispatcher = dispatcher,
                                realtime = owner,
                            )
                        }
                    val opened = OpeningWorkspace.Authorized(identity, organization, chats)
                    val knownMemberships =
                        if (fastAccess == null) memberships
                        else
                            listOf(
                                WorkspaceMembership(identity.workspaceId, organization.name, role)
                            )
                    mutable.value =
                        mutable.value.copy(memberships = knownMemberships, opening = opened)
                    chats.refresh()
                    loadRemainingMemberships(ticket, snapshot)
                    finishPreparation(ticket, snapshot, opened)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (current(ticket, snapshot) && !workspaceFailure(ticket, snapshot, error)) {
                        val state = mutable.value
                        retire()
                        mutable.value =
                            SessionUiState(
                                generation,
                                SessionStage.Unavailable,
                                cachedAppearance = state.cachedAppearance,
                                opening =
                                    initialIdentity?.let { OpeningWorkspace.CheckingAccess(it) },
                            )
                    }
                } finally {
                    appearanceRead?.cancel()
                    cacheWarm?.cancel()
                }
            }
    }

    private fun loadRemainingMemberships(ticket: Long, snapshot: AuthenticationState) {
        if (membershipsComplete || membershipLoad?.isActive == true) return
        val session = checkNotNull(snapshot.session)
        membershipLoad =
            viewModelScope.launch {
                val memberships =
                    try {
                        authentication.memberships(session)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        workspaceFailure(ticket, snapshot, error)
                        return@launch
                    }
                requireCurrent(ticket, snapshot)
                membershipsComplete = true
                if (memberships.none { it.id == session.workspaceId }) {
                    retire()
                    mutable.value =
                        SessionUiState(generation, SessionStage.ChooseWorkspace, memberships)
                } else {
                    mutable.value = mutable.value.copy(memberships = memberships)
                }
            }
    }

    private suspend fun finishPreparation(
        ticket: Long,
        snapshot: AuthenticationState,
        opened: OpeningWorkspace.Authorized,
    ) {
        requireCurrent(ticket, snapshot)
        val owner = checkNotNull(workspace)
        val store = checkNotNull(presentation)
        val initial =
            try {
                owner.preferences()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (current(ticket, snapshot) && !workspaceFailure(ticket, snapshot, error)) {
                    mutable.value =
                        mutable.value.copy(stage = SessionStage.Unavailable, working = false)
                }
                return
            }
        currentCoroutineContext().ensureActive()
        requireCurrent(ticket, snapshot)
        val preferences =
            store.workspaceModel {
                MemberPreferencesModel(
                    initial,
                    owner,
                    authorized = { current(ticket, snapshot) },
                    onFailure = { error -> workspaceFailure(ticket, snapshot, error) },
                )
            }
        val identity = opened.identity
        val chats = opened.chats
        val controls =
            store.workspaceModel {
                RunControlsModel(
                    owner,
                    runControlJournal,
                    identity,
                    chats.history,
                    { current(ticket, snapshot) },
                    { workspaceFailure(ticket, snapshot, it) },
                    dispatcher,
                )
            }
        val recovery =
            store.workspaceModel {
                AssistantRecoveryModel(
                    owner,
                    chats.history,
                    controls,
                    { current(ticket, snapshot) },
                    { workspaceFailure(ticket, snapshot, it) },
                    dispatcher,
                )
            }
        val instructions =
            store.workspaceModel {
                PersonalInstructionsModel(
                    owner,
                    instructionsDrafts,
                    identity,
                    { current(ticket, snapshot) },
                    { workspaceFailure(ticket, snapshot, it) },
                )
            }
        val composer =
            store.workspaceModel {
                ChatComposerModel(
                    owner,
                    composerJournal,
                    identity,
                    { current(ticket, snapshot) },
                    { workspaceFailure(ticket, snapshot, it) },
                    chats::refreshAfterSend,
                    recovery,
                    chats.history,
                )
            }
        mutable.value =
            mutable.value.copy(
                stage = SessionStage.Ready,
                ready =
                    ReadyWorkspace(
                        identity,
                        opened.organization,
                        preferences,
                        chats,
                        instructions,
                        composer,
                        controls,
                        recovery,
                    ),
                working = false,
                cachedAppearance = null,
                opening = null,
            )
        preferences.uiState
            .map { it.confirmed.appearance }
            .distinctUntilChanged()
            .collect { appearanceCache.save(identity, it) }
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
        val state = mutable.value
        state.ready?.preferences?.refreshFromForeground()
        (state.ready?.chats ?: (state.opening as? OpeningWorkspace.Authorized)?.chats)?.refresh()
        if (state.ready != null) observed?.let { loadRemainingMemberships(state.generation, it) }
    }

    private fun workspaceFailure(
        ticket: Long,
        snapshot: AuthenticationState,
        error: Exception,
    ): Boolean {
        if (!current(ticket, snapshot)) return false
        if (error is ApiFailure.UpdateRequired) {
            enterRequiredUpdate()
            return true
        }
        val stage =
            when {
                error is ApiFailure.Unauthenticated ||
                    error is ApiFailure.Http && error.status in setOf(401, 403, 404) ->
                    SessionStage.AccessRemoved
                else -> return false
            }
        retire()
        mutable.value = SessionUiState(generation, stage)
        return true
    }

    fun retry(expectedGeneration: Long) {
        if (!acceptsAction(expectedGeneration)) return
        val state = mutable.value
        val opened = state.opening as? OpeningWorkspace.Authorized
        if (opened != null) {
            if (state.working) return
            val snapshot = checkNotNull(observed)
            mutable.value = state.copy(stage = SessionStage.LoadingWorkspace, working = true)
            operation =
                viewModelScope.launch { finishPreparation(expectedGeneration, snapshot, opened) }
            return
        }
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

private inline fun <reified T : ViewModel> ViewModelStore.workspaceModel(
    crossinline create: () -> T
): T = ViewModelProvider(this, viewModelFactory { initializer { create() } })[T::class.java]
