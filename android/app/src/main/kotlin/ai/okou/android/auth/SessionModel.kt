package ai.okou.android.auth

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.continuousRetryDelayMillis
import ai.okou.android.api.continuousRetryDelays
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.isTransientApiFailure
import ai.okou.android.api.retryAfterDelayMillis
import ai.okou.android.api.retryAfterSeconds
import ai.okou.android.artifacts.ArtifactCatalogModel
import ai.okou.android.chat.AssistantRecoveryModel
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ChatComposerModel
import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.ProjectExpansionModel
import ai.okou.android.chat.ProjectExpansionStore
import ai.okou.android.chat.RunControlOwners
import ai.okou.android.chat.RunControlsModel
import ai.okou.android.chat.SearchRecentChatsStore
import ai.okou.android.chat.WorkspaceNamePresentation
import ai.okou.android.chat.WorkspaceSearchModel
import ai.okou.android.connectors.ConnectorModel
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.instructions.PersonalInstructionsModel
import ai.okou.android.preferences.CachedMemberPreferences
import ai.okou.android.preferences.MemberPreferencesCache
import ai.okou.android.preferences.MemberPreferencesModel
import ai.okou.android.preferences.PreferenceChange
import ai.okou.android.settings.DefaultModelStore
import ai.okou.android.settings.WorkspaceSettingsCache
import ai.okou.android.settings.WorkspaceSettingsModel
import ai.okou.android.workflows.WorkflowModel
import ai.okou.android.workflows.WorkflowReadAnnouncements
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

enum class SessionStage {
    Restoring,
    SignIn,
    ChooseWorkspace,
    LoadingWorkspace,
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
    val projectExpansion: ProjectExpansionModel,
    val instructions: PersonalInstructionsModel,
    val composer: ChatComposerModel,
    val controls: RunControlsModel,
    val recovery: AssistantRecoveryModel,
    val artifacts: ArtifactCatalogModel,
    val chatArtifacts: ArtifactCatalogModel,
    val settings: WorkspaceSettingsModel,
    val workflows: WorkflowModel?,
    val connectors: ConnectorModel? = null,
    val search: WorkspaceSearchModel,
    internal val namePresentation: WorkspaceNamePresentation,
) {
    // Cached refresh results can outlive the workflow destination and the Activity.
    internal val workflowReadAnnouncements = workflows?.let { WorkflowReadAnnouncements() }
}

sealed interface OpeningWorkspace {
    val identity: WorkspaceIdentity

    data class CheckingAccess(override val identity: WorkspaceIdentity) : OpeningWorkspace

    data class Cached(
        override val identity: WorkspaceIdentity,
        val chats: ChatListModel,
        val projectExpansion: ProjectExpansionModel,
    ) : OpeningWorkspace

    data class Authorized(
        override val identity: WorkspaceIdentity,
        val role: String,
        val organization: Organization?,
        val chats: ChatListModel,
        val projectExpansion: ProjectExpansionModel,
        val composer: ChatComposerModel,
        val controls: RunControlsModel,
        val recovery: AssistantRecoveryModel,
        val artifacts: ArtifactCatalogModel,
        val chatArtifacts: ArtifactCatalogModel,
        val search: WorkspaceSearchModel,
        internal val namePresentation: WorkspaceNamePresentation,
    ) : OpeningWorkspace
}

data class SessionUiState(
    val generation: Long,
    val stage: SessionStage = SessionStage.Restoring,
    val memberships: List<WorkspaceMembership> = emptyList(),
    val ready: ReadyWorkspace? = null,
    val working: Boolean = false,
    val cachedPreferences: CachedMemberPreferences? = null,
    val opening: OpeningWorkspace? = null,
    val checkingWorkspace: Boolean = false,
    val entryFailure: SessionEntryFailure? = null,
    val entryReadFailed: Boolean = false,
    // An in-place check can retire its work while the entry page stays open.
    val entryPageGeneration: Long = generation,
    val workspaceSwitch: WorkspaceSwitch? = null,
    val signingOut: Boolean = false,
)

data class WorkspaceSwitch(val target: String, val failed: Boolean = false)

enum class SessionEntryFailure {
    Check,
    Selection,
    Browser,
    SignOut,
}

private class EntrySelection(
    private val session: NativeSession,
    private val workspaceId: String,
    val picker: SessionUiState,
) {
    fun matches(current: NativeSession?): Boolean =
        current != null &&
            current.sessionId == session.sessionId &&
            current.userId == session.userId &&
            current.workspaceId == workspaceId
}

private class VerifiedWorkspaceAccess(val membership: MembershipAccess?)

private fun NativeSession?.sameSignIn(other: NativeSession?): Boolean =
    this?.sessionId == other?.sessionId && this?.userId == other?.userId

/** One owner for authorization, pending work and the currently permitted workspace resource. */
class SessionModel(
    private val authentication: Authentication,
    private val factory: WorkspaceSessionFactory,
    private val apiOrigin: String,
    private val chatCache: ChatCacheStore,
    private val instructionsDrafts: PersonalInstructionsDraftStore,
    private val composerJournal: ComposerJournalStore,
    private val runControlOwners: RunControlOwners,
    private val preferencesCache: MemberPreferencesCache,
    private val projectExpansionStore: ProjectExpansionStore,
    private val defaultModelStore: DefaultModelStore,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    updatesRequired: Flow<Boolean> = emptyFlow(),
    private val settingsCache: WorkspaceSettingsCache? = null,
    private val searchRecents: SearchRecentChatsStore? = null,
) : ViewModel() {
    @Volatile private var generation = 0L
    private val mutable = MutableStateFlow(SessionUiState(generation))
    val uiState = mutable.asStateFlow()
    val account = authentication.account
    private val workspaceFilters = mutableMapOf<Pair<String, String>, ChatListFilter>()
    private val pendingPreferences = mutableMapOf<Pair<String, String>, PreferenceChange>()
    private var observed: AuthenticationState? = null
    private var operation: Job? = null
    private var membershipLoad: Job? = null
    private var membershipsComplete = false
    private var workspace: WorkspaceSession? = null
    private var presentation: ViewModelStore? = null
    private var requiredUpdate = false
    private var workspaceSetupReturn: Long? = null
    private var entrySelection: EntrySelection? = null
    private var workspaceSwitchJob: Job? = null
    private var signOutJob: Job? = null
    private val foreground = MutableStateFlow(false)

    init {
        viewModelScope.launch { authentication.state.collect { reconcile(it) } }
        viewModelScope.launch {
            updatesRequired.collect { required ->
                if (required && !requiredUpdate) enterRequiredUpdate()
            }
        }
    }

    private fun retire() {
        val state = mutable.value
        val ready = state.ready
        val opened = state.opening as? OpeningWorkspace.Authorized
        val cached = state.opening as? OpeningWorkspace.Cached
        val identity = ready?.identity ?: opened?.identity ?: cached?.identity
        if (identity != null) {
            val key = identity.userId to identity.workspaceId
            val filter = (ready?.chats ?: opened?.chats ?: cached?.chats)?.uiState?.value?.filter
            if (filter != null) workspaceFilters[key] = filter
            if (ready != null) {
                val intent = ready.preferences.pendingForWorkspaceRestore()
                if (intent == null) pendingPreferences.remove(key)
                else pendingPreferences[key] = intent
            }
        }
        generation++
        workspaceSetupReturn = null
        entrySelection = null
        workspaceSwitchJob?.cancel()
        workspaceSwitchJob = null
        operation?.cancel()
        operation = null
        membershipLoad?.cancel()
        membershipLoad = null
        membershipsComplete = false
        val retiredWorkspace = workspace
        val retiredPresentation = presentation
        workspace = null
        presentation = null
        try {
            retiredWorkspace?.close()
        } finally {
            retiredPresentation?.clear()
        }
    }

    private fun cancelSignOut() {
        signOutJob?.cancel()
        signOutJob = null
    }

    private fun publishSessionState(state: SessionUiState) {
        // A workspace can retire while its Clerk sign-out is still pending.
        val signingOut = signOutJob != null
        mutable.value =
            if (state.signingOut == signingOut) state else state.copy(signingOut = signingOut)
    }

    private fun enterRequiredUpdate() {
        val state = mutable.value
        val cachedPreferences =
            state.ready?.preferences?.uiState?.value?.localSnapshot ?: state.cachedPreferences
        requiredUpdate = true
        cancelSignOut()
        retire()
        mutable.value =
            SessionUiState(
                generation,
                SessionStage.UpdateRequired,
                cachedPreferences = cachedPreferences,
            )
    }

    private fun reconcile(snapshot: AuthenticationState, force: Boolean = false) {
        if (requiredUpdate) return
        // SDK token refreshes do not replace a stable identity or its presentation owner.
        if (!force && observed == snapshot) return
        val session = snapshot.session
        val selection = entrySelection?.takeIf { it.matches(session) }
        val awaitingSelection = entrySelection != null && selection == null
        if (
            !force &&
                (workspaceSetupReturn != null || awaitingSelection) &&
                observed?.copy(membershipAccess = snapshot.membershipAccess) == snapshot
        ) {
            // Keep the entry action pending while Clerk publishes membership metadata.
            observed = snapshot
            return
        }
        val checkingFrom =
            mutable.value.takeIf {
                it.checkingWorkspace && observed?.session == snapshot.session
            }
        if (signOutJob != null && !session.sameSignIn(observed?.session)) cancelSignOut()
        observed = snapshot
        retire()
        when {
            snapshot.failed ->
                publishSessionState(SessionUiState(generation, SessionStage.Unavailable))
            !snapshot.initialized -> publishSessionState(SessionUiState(generation))
            session == null -> publishSessionState(SessionUiState(generation, SessionStage.SignIn))
            !snapshot.complete && !session.choosingWorkspace ->
                publishSessionState(SessionUiState(generation, SessionStage.SignIn))
            else ->
                prepare(
                    snapshot,
                    checkingFrom?.copy(generation = generation, checkingWorkspace = false),
                    selection,
                )
        }
    }

    private fun prepare(
        snapshot: AuthenticationState,
        checkingFrom: SessionUiState? = null,
        selection: EntrySelection? = null,
        verifiedAccess: VerifiedWorkspaceAccess? = null,
    ) {
        val session = checkNotNull(snapshot.session)
        val ticket = generation
        entrySelection = selection
        val initialIdentity =
            session.workspaceId
                ?.takeIf { snapshot.complete && session.active }
                ?.let { WorkspaceIdentity(apiOrigin, session.userId, session.sessionId, it) }
        publishSessionState(
            checkingFrom?.copy(checkingWorkspace = true)
                ?: SessionUiState(
                    ticket,
                    SessionStage.LoadingWorkspace,
                    working = true,
                    opening =
                        initialIdentity
                            ?.takeIf { selection == null }
                            ?.let {
                                OpeningWorkspace.CheckingAccess(it)
                            },
                ),
        )
        operation = viewModelScope.launch {
            val knownAccess = initialIdentity?.let { identity ->
                val memberships =
                    if (verifiedAccess == null) snapshot.membershipAccess.orEmpty()
                    else listOfNotNull(verifiedAccess.membership)
                memberships.firstOrNull {
                    it.workspaceId == identity.workspaceId && it.permissions != null
                }
            }
            val preparedIdentity = knownAccess?.let { access ->
                checkNotNull(initialIdentity).withAccess(access.role, access)
            }
            var preparation = preparedIdentity?.let { identity ->
                async { prepareChatList(identity) }
            }
            fun restorePreferences(identity: WorkspaceIdentity) = launch {
                val preferences = preferencesCache.load(identity) ?: return@launch
                val state = mutable.value
                if (
                    current(ticket, snapshot) &&
                        state.opening?.identity?.workspaceId == identity.workspaceId
                ) {
                    mutable.value = state.copy(cachedPreferences = preferences)
                }
            }
            var preferencesRead =
                initialIdentity?.takeIf { mutable.value.opening != null }?.let(::restorePreferences)
            val cacheWarm =
                initialIdentity
                    ?.takeIf { preparedIdentity == null }
                    ?.let {
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
                val initialEntry = initialIdentity == null && checkingFrom == null
                val cached =
                    if (
                        verifiedAccess == null &&
                            preparedIdentity != null &&
                            checkingFrom == null &&
                            selection == null
                    ) {
                        val gate = CompletableDeferred<Unit>(currentCoroutineContext()[Job])
                        val owner = createWorkspace(preparedIdentity, ticket, snapshot, gate)
                        val store = ViewModelStore()
                        presentation = store
                        val cached =
                            OpeningWorkspace.Cached(
                                preparedIdentity,
                                store.chatList(owner, preparedIdentity, ticket, snapshot, gate),
                                store.workspaceModel {
                                    ProjectExpansionModel(projectExpansionStore, preparedIdentity)
                                },
                            )
                        cached.chats.restoreStartupCache(checkNotNull(preparation))
                        preparation = null
                        mutable.value = mutable.value.copy(opening = cached)
                        try {
                            val verified =
                                readWorkspacePreparation(ticket, snapshot) {
                                    VerifiedWorkspaceAccess(authentication.refresh(session))
                                } ?: return@launch
                            requireCurrent(ticket, snapshot)
                            if (verified.membership != knownAccess) {
                                retire()
                                prepare(snapshot, verifiedAccess = verified)
                                return@launch
                            }
                            gate.complete(Unit)
                            cached
                        } finally {
                            if (!gate.isCompleted) gate.cancel()
                        }
                    } else null
                val refreshedAccess =
                    when {
                        cached != null -> knownAccess
                        verifiedAccess != null -> verifiedAccess.membership
                        initialEntry -> null
                        else -> authentication.refresh(session)
                    }
                requireCurrent(ticket, snapshot)
                val fastAccess = refreshedAccess?.takeIf {
                    it.workspaceId == initialIdentity?.workspaceId && it.permissions != null
                }
                val memberships =
                    when {
                        initialEntry -> readEntryMemberships(ticket, snapshot, session)
                        fastAccess == null -> authentication.memberships(session)
                        else -> emptyList()
                    }
                requireCurrent(ticket, snapshot)
                membershipsComplete = fastAccess == null
                val membership = initialIdentity?.let { identity ->
                    memberships.firstOrNull { it.id == identity.workspaceId }
                }
                val role = fastAccess?.role ?: membership?.role
                if (initialIdentity == null || role == null) {
                    entrySelection = null
                    val entryFeedback =
                        mutable.value.entryFailure?.takeIf {
                            it == SessionEntryFailure.SignOut ||
                                (memberships.isEmpty() && it == SessionEntryFailure.Browser)
                        }
                    publishSessionState(
                        SessionUiState(
                            generation,
                            SessionStage.ChooseWorkspace,
                            memberships,
                            entryFailure =
                                selection?.let { SessionEntryFailure.Selection } ?: entryFeedback,
                            entryPageGeneration = checkingFrom?.entryPageGeneration ?: generation,
                        ),
                    )
                    return@launch
                }
                val identity = initialIdentity.withAccess(role, refreshedAccess)
                if (identity != preparedIdentity) {
                    preparation?.cancel()
                    preparation = async { prepareChatList(identity) }
                }
                val owner =
                    if (cached != null) checkNotNull(workspace)
                    else createWorkspace(identity, ticket, snapshot)
                // Fresh selected permissions authorize the scoped list while metadata loads.
                val organization = if (fastAccess == null) owner.organization() else null
                currentCoroutineContext().ensureActive()
                requireCurrent(ticket, snapshot)
                val store = presentation ?: ViewModelStore()
                presentation = store
                val projectExpansion =
                    cached?.projectExpansion
                        ?: store.workspaceModel {
                            ProjectExpansionModel(projectExpansionStore, identity)
                        }
                val chats = cached?.chats ?: store.chatList(owner, identity, ticket, snapshot)
                val controls = store.workspaceModel {
                    RunControlsModel(
                        owner,
                        runControlOwners,
                        identity,
                        chats.history,
                        { current(ticket, snapshot) },
                        { workspaceFailure(ticket, snapshot, it) },
                        dispatcher,
                    )
                }
                val recovery = store.workspaceModel {
                    AssistantRecoveryModel(
                        owner,
                        chats.history,
                        controls,
                        { current(ticket, snapshot) },
                        { workspaceFailure(ticket, snapshot, it) },
                        dispatcher,
                        retryWhenActive = foreground,
                    )
                }
                val composer = store.workspaceModel {
                    ChatComposerModel(
                        owner,
                        composerJournal,
                        identity,
                        { current(ticket, snapshot) },
                        { workspaceFailure(ticket, snapshot, it) },
                        chats::refreshAfterSend,
                        recovery,
                        chats.history,
                        chats,
                        owner.connectors,
                    )
                }
                var clearWorkspaceArtifacts: () -> Unit = {}
                val chatArtifacts =
                    store.workspaceModel("chat-artifacts") {
                        ArtifactCatalogModel(
                            owner.artifacts,
                            cache = chats.cache,
                            catalogChanges = chats.artifactCatalogChanges,
                            unavailableChat =
                                chats.history.uiState
                                    .map { history ->
                                        if (history.phase == HistoryPhase.Missing)
                                            history.thread?.id
                                        else null
                                    }
                                    .distinctUntilChanged(),
                            onCatalogDenied = { clearWorkspaceArtifacts() },
                        ) {
                            workspaceFailure(ticket, snapshot, it)
                        }
                    }
                val artifacts = store.workspaceModel {
                    ArtifactCatalogModel(
                        owner.artifacts,
                        onCatalogDenied = chatArtifacts::evictDeniedCatalogs,
                    ) {
                        workspaceFailure(ticket, snapshot, it)
                    }
                }
                clearWorkspaceArtifacts = artifacts::evictDeniedCatalogs
                val opened =
                    OpeningWorkspace.Authorized(
                        identity,
                        role,
                        organization,
                        chats,
                        projectExpansion,
                        composer,
                        controls,
                        recovery,
                        artifacts,
                        chatArtifacts,
                        store.workspaceModel {
                            WorkspaceSearchModel(
                                owner,
                                identity,
                                searchRecents,
                                { current(ticket, snapshot) },
                                { workspaceFailure(ticket, snapshot, it) },
                            )
                        },
                        store.workspaceModel { WorkspaceNamePresentation() },
                    )
                entrySelection = null
                mutable.value =
                    mutable.value.copy(
                        stage = SessionStage.LoadingWorkspace,
                        working = true,
                        memberships = memberships,
                        opening = opened,
                        checkingWorkspace = false,
                        entryFailure = null,
                    )
                preferencesRead = preferencesRead ?: restorePreferences(identity)
                preparation?.let(chats::restoreStartupCache)
                // The list owns restoration after handoff, including during bootstrap retries.
                preparation = null
                chats.refresh()
                loadRemainingMemberships(ticket, snapshot)
                finishPreparation(ticket, snapshot, opened)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (
                    current(ticket, snapshot) &&
                        checkingFrom != null &&
                        mutable.value.checkingWorkspace &&
                        error !is ApiFailure.UpdateRequired
                ) {
                    retire()
                    publishSessionState(
                        checkingFrom.copy(
                            generation = generation,
                            entryFailure = SessionEntryFailure.Check,
                        ),
                    )
                } else if (
                    current(ticket, snapshot) && !workspaceFailure(ticket, snapshot, error)
                ) {
                    val picker = entrySelection?.picker
                    if (picker != null) {
                        restoreEntryPicker(picker)
                        return@launch
                    }
                    val state = mutable.value
                    retire()
                    publishSessionState(
                        SessionUiState(
                            generation,
                            SessionStage.Unavailable,
                            cachedPreferences = state.cachedPreferences,
                            opening = initialIdentity?.let { OpeningWorkspace.CheckingAccess(it) },
                            entryFailure =
                                state.entryFailure?.takeIf {
                                    it == SessionEntryFailure.SignOut
                                },
                            entryReadFailed = initialIdentity == null,
                        ),
                    )
                }
            } finally {
                preferencesRead?.cancel()
                cacheWarm?.cancel()
                preparation?.cancel()
            }
        }
    }

    private fun createWorkspace(
        identity: WorkspaceIdentity,
        ticket: Long,
        snapshot: AuthenticationState,
        verification: CompletableDeferred<Unit>? = null,
    ): WorkspaceSession {
        val session = checkNotNull(snapshot.session)
        return factory
            .create(
                identity,
                object : WorkspaceTokenProvider {
                    private val renewal = Mutex()

                    override suspend fun token(): String? = whileCurrent {
                        authentication.token(session)
                    }

                    override suspend fun renew(rejectedToken: String): String? = renewal.withLock {
                        token()?.takeIf { it != rejectedToken }
                            ?: whileCurrent { authentication.renewToken(session) }
                    }

                    private suspend fun whileCurrent(read: suspend () -> String?): String? {
                        verification?.await()
                        requireCurrent(ticket, snapshot)
                        val credential = read()
                        currentCoroutineContext().ensureActive()
                        requireCurrent(ticket, snapshot)
                        return credential
                    }
                },
            )
            .also { workspace = it }
    }

    private fun ViewModelStore.chatList(
        owner: WorkspaceSession,
        identity: WorkspaceIdentity,
        ticket: Long,
        snapshot: AuthenticationState,
        verification: CompletableDeferred<Unit>? = null,
    ) = workspaceModel {
        ChatListModel(
            owner,
            chatCache,
            identity,
            authorized = { current(ticket, snapshot) },
            onFailure = { error -> workspaceFailure(ticket, snapshot, error) },
            dispatcher = dispatcher,
            realtime = owner,
            initialFilter =
                workspaceFilters[identity.userId to identity.workspaceId] ?: ChatListFilter.Inbox,
            remoteAccessVerified = {
                verification == null || (verification.isCompleted && !verification.isCancelled)
            },
            initiallyInForeground = foreground.value,
        )
    }

    private suspend fun readEntryMemberships(
        ticket: Long,
        snapshot: AuthenticationState,
        session: NativeSession,
    ): List<WorkspaceMembership> {
        var failures = 0
        while (true) {
            requireCurrent(ticket, snapshot)
            try {
                authentication.refresh(session)
                requireCurrent(ticket, snapshot)
                return authentication.memberships(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent(ticket, snapshot)
                if (!error.isTransientApiFailure()) throw error
                val retryDelay = continuousRetryDelayMillis(failures, error.retryAfterSeconds())
                failures = (failures + 1).coerceAtMost(continuousRetryDelays.size)
                if (failures == 3) {
                    mutable.value =
                        mutable.value.copy(
                            stage = SessionStage.Unavailable,
                            working = false,
                            entryReadFailed = true,
                        )
                }
                delay(retryDelay)
                combine(foreground, mutable) { active, state -> active && !state.signingOut }
                    .first { it }
            }
        }
    }

    private suspend fun prepareChatList(identity: WorkspaceIdentity) =
        try {
            chatCache.prepareChatList(identity, dispatcher)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The authorized cache read owns reporting and recovery.
            null
        }

    private fun WorkspaceIdentity.withAccess(role: String, access: MembershipAccess?) =
        copy(
            authorizationScope =
                scopeHash(
                    listOf(role) +
                        access
                            ?.let {
                                listOf(
                                    it.role,
                                    if (it.permissions == null) "unknown" else "known",
                                ) + it.permissions.orEmpty().sorted()
                            }
                            .orEmpty(),
                ),
        )

    private fun loadRemainingMemberships(ticket: Long, snapshot: AuthenticationState) {
        if (membershipsComplete || membershipLoad?.isActive == true) return
        val session = checkNotNull(snapshot.session)
        membershipLoad = viewModelScope.launch {
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
                publishSessionState(
                    SessionUiState(generation, SessionStage.ChooseWorkspace, memberships),
                )
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
        var organization = opened.organization
        val initial =
            readWorkspacePreparation(ticket, snapshot) {
                if (organization == null) {
                    val resolved = owner.organization()
                    currentCoroutineContext().ensureActive()
                    requireCurrent(ticket, snapshot)
                    val state = mutable.value
                    val memberships =
                        if (membershipsComplete) state.memberships
                        else listOf(WorkspaceMembership(resolved.id, resolved.name, opened.role))
                    organization = resolved
                    mutable.value =
                        state.copy(
                            memberships = memberships,
                            opening = opened.copy(organization = resolved),
                        )
                }
                owner.preferences()
            } ?: return
        currentCoroutineContext().ensureActive()
        requireCurrent(ticket, snapshot)
        val resolvedOrganization = checkNotNull(organization)
        val preferences = store.workspaceModel {
            MemberPreferencesModel(
                    initial,
                    owner,
                    authorized = { current(ticket, snapshot) },
                    onFailure = { error -> workspaceFailure(ticket, snapshot, error) },
                    initialPending =
                        pendingPreferences[opened.identity.userId to opened.identity.workspaceId],
                )
                .also { it.foreground(foreground.value) }
        }
        val instructions = store.workspaceModel {
            PersonalInstructionsModel(
                owner,
                instructionsDrafts,
                opened.identity,
                { current(ticket, snapshot) },
                { workspaceFailure(ticket, snapshot, it) },
            )
        }
        val settings = store.workspaceModel {
            WorkspaceSettingsModel(
                    owner,
                    opened.identity,
                    defaultModelStore,
                    opened.role == "org:admin",
                    {
                        authentication.memberships(checkNotNull(snapshot.session)).any {
                            it.id == opened.identity.workspaceId && it.role == "org:admin"
                        }
                    },
                    { current(ticket, snapshot) },
                    { workspaceFailure(ticket, snapshot, it) },
                    cache = settingsCache,
                )
                .also { it.defaultModel.foreground(foreground.value) }
        }
        val workflows =
            owner.workflowService?.let { service ->
                store.workspaceModel {
                    WorkflowModel(
                        service,
                        authorized = { current(ticket, snapshot) },
                        onFailure = { workspaceFailure(ticket, snapshot, it) },
                    )
                }
            }
        val connectors =
            owner.connectors?.let { service ->
                store.workspaceModel {
                    ConnectorModel(
                        service,
                        authorized = { current(ticket, snapshot) },
                        sessionFailure = { error -> workspaceFailure(ticket, snapshot, error) },
                    )
                }
            }
        mutable.value =
            mutable.value.copy(
                stage = SessionStage.Ready,
                ready =
                    ReadyWorkspace(
                        opened.identity,
                        resolvedOrganization,
                        preferences,
                        opened.chats,
                        opened.projectExpansion,
                        instructions,
                        opened.composer,
                        opened.controls,
                        opened.recovery,
                        opened.artifacts,
                        opened.chatArtifacts,
                        settings,
                        workflows = workflows,
                        connectors = connectors,
                        search = opened.search,
                        namePresentation = opened.namePresentation,
                    ),
                working = false,
                cachedPreferences = null,
                opening = null,
            )
        preferences.uiState
            .map { it.localSnapshot }
            .distinctUntilChanged()
            .collect { preferencesCache.save(opened.identity, it) }
    }

    private suspend fun <T : Any> readWorkspacePreparation(
        ticket: Long,
        snapshot: AuthenticationState,
        read: suspend () -> T,
    ): T? {
        var backoff = 5_000L
        while (true) {
            requireCurrent(ticket, snapshot)
            try {
                return read()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!current(ticket, snapshot) || workspaceFailure(ticket, snapshot, error))
                    return null
                val retryable = error.isTransientApiFailure()
                mutable.value =
                    mutable.value.copy(
                        stage = SessionStage.Unavailable,
                        working = retryable,
                    )
                if (!retryable) return null
                val retryAfter = retryAfterDelayMillis(error.retryAfterSeconds())
                val interrupted =
                    if (retryAfter != null) {
                        delay(retryAfter)
                        false
                    } else {
                        withTimeoutOrNull(backoff) { foreground.first { !it } } != null
                    }
                foreground.first { it }
                backoff = if (interrupted) 5_000L else (backoff * 2).coerceAtMost(60_000L)
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

    fun foregroundChanged(active: Boolean) {
        foreground.value = active
        mutable.value.ready?.settings?.defaultModel?.foreground(active)
        if (active && workspaceSetupReturn != null) {
            reconcile(authentication.state.value)
            workspaceSetupReturn?.let(::retry)
        }
        val state = mutable.value
        state.ready?.preferences?.foreground(active)
        val openingChats =
            when (val opening = state.opening) {
                is OpeningWorkspace.Authorized -> opening.chats
                is OpeningWorkspace.Cached -> opening.chats
                else -> null
            }
        (state.ready?.chats ?: openingChats)?.activityForegroundChanged(active)
        if (!active) return
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
                error is ApiFailure.Http && error.status == 401 -> SessionStage.Unavailable
                error is ApiFailure.Unauthenticated ||
                    error is ApiFailure.Http && error.status in setOf(403, 404) ->
                    SessionStage.AccessRemoved
                else -> return false
            }
        retire()
        publishSessionState(SessionUiState(generation, stage))
        return true
    }

    fun retry(expectedGeneration: Long) {
        if (!acceptsAction(expectedGeneration)) return
        val state = mutable.value
        if (state.signingOut || state.checkingWorkspace) return
        val snapshot = checkNotNull(observed)
        if (
            snapshot.session != null &&
                (state.stage == SessionStage.ChooseWorkspace ||
                    state.stage == SessionStage.AccessRemoved)
        ) {
            workspaceSetupReturn = null
            prepare(snapshot, state.copy(entryFailure = null))
            return
        }
        val opened = state.opening as? OpeningWorkspace.Authorized
        if (opened != null) {
            if (state.working) return
            mutable.value = state.copy(stage = SessionStage.LoadingWorkspace, working = true)
            operation = viewModelScope.launch {
                finishPreparation(expectedGeneration, snapshot, opened)
            }
            return
        }
        authentication.initialize()
        reconcile(authentication.state.value, force = true)
    }

    fun openWorkspaceSetup(expectedGeneration: Long, launchBrowser: () -> Boolean) {
        if (!acceptsAction(expectedGeneration)) return
        val state = mutable.value
        if (
            state.signingOut ||
                state.stage != SessionStage.ChooseWorkspace ||
                state.memberships.isNotEmpty()
        )
            return
        if (launchBrowser()) {
            // A read started before web setup cannot confirm changes made in the browser.
            if (state.checkingWorkspace) retire()
            workspaceSetupReturn = generation
            if (state.checkingWorkspace || state.entryFailure == SessionEntryFailure.Browser) {
                mutable.value =
                    state.copy(
                        generation = generation,
                        checkingWorkspace = false,
                        entryFailure = null,
                    )
            }
        } else {
            mutable.value = state.copy(entryFailure = SessionEntryFailure.Browser)
        }
    }

    fun chooseWorkspace(id: String, expectedGeneration: Long) {
        if (!acceptsAction(expectedGeneration)) return
        val snapshot = authentication.state.value
        val session = snapshot.session ?: return
        val previous = mutable.value
        if (previous.signingOut || previous.working || previous.memberships.none { it.id == id })
            return
        if (mutable.value.ready?.identity?.workspaceId == id) return
        if (previous.ready != null) {
            if (previous.workspaceSwitch?.failed == false) return
            mutable.value = previous.copy(workspaceSwitch = WorkspaceSwitch(id))
            workspaceSwitchJob = viewModelScope.launch {
                try {
                    authentication.selectWorkspace(session, id)
                    currentCoroutineContext().ensureActive()
                    reconcile(authentication.state.value)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (acceptsAction(expectedGeneration)) {
                        mutable.value =
                            mutable.value.copy(workspaceSwitch = WorkspaceSwitch(id, failed = true))
                    }
                }
            }
            return
        }
        retire()
        val ticket = generation
        val selection =
            if (previous.stage == SessionStage.ChooseWorkspace && previous.opening == null)
                EntrySelection(session, id, previous)
            else null
        entrySelection = selection
        mutable.value = SessionUiState(generation, SessionStage.LoadingWorkspace, working = true)
        operation = viewModelScope.launch {
            try {
                if (
                    selection == null ||
                        !snapshot.complete ||
                        !session.active ||
                        !selection.matches(session)
                ) {
                    authentication.selectWorkspace(session, id)
                }
                currentCoroutineContext().ensureActive()
                val confirmed = authentication.state.value
                if (
                    generation == ticket &&
                        (selection == null || selection.matches(confirmed.session))
                ) {
                    reconcile(confirmed, force = true)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (selection != null && ticket == generation) {
                    reconcile(authentication.state.value)
                }
                if (acceptsAction(ticket)) {
                    if (selection != null) restoreEntryPicker(selection.picker)
                    else mutable.value = SessionUiState(ticket, SessionStage.Unavailable)
                }
            }
        }
    }

    private fun restoreEntryPicker(picker: SessionUiState) {
        retire()
        publishSessionState(
            picker.copy(
                generation = generation,
                checkingWorkspace = false,
                entryFailure = SessionEntryFailure.Selection,
            ),
        )
    }

    fun signOut(expectedGeneration: Long) {
        if (!acceptsAction(expectedGeneration)) return
        val previous = mutable.value
        if (previous.signingOut || previous.workspaceSwitch?.failed == false) return
        val session = observed?.session
        // Keep the current workspace or scheduled entry retry available if sign-out fails.
        val readingEntry = previous.entryReadFailed && operation?.isActive == true
        if (
            !readingEntry &&
                previous.ready == null &&
                previous.opening !is OpeningWorkspace.Authorized &&
                previous.opening !is OpeningWorkspace.Cached
        ) {
            retire()
        }
        val request =
            viewModelScope.launch(start = CoroutineStart.LAZY) {
                val before = authentication.state.value
                if (!session.sameSignIn(before.session)) {
                    reconcile(before)
                    return@launch
                }
                try {
                    authentication.signOut()
                    currentCoroutineContext().ensureActive()
                    // A signed-in request stays pending until Clerk publishes a session change.
                    if (session == null) {
                        signOutJob = null
                        reconcile(authentication.state.value, force = true)
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    reconcile(authentication.state.value)
                    if (signOutJob == currentCoroutineContext()[Job]) {
                        signOutJob = null
                        mutable.value =
                            mutable.value.copy(
                                signingOut = false,
                                entryFailure = SessionEntryFailure.SignOut,
                            )
                    }
                }
            }
        signOutJob = request
        publishSessionState(
            previous.copy(
                generation = generation,
                checkingWorkspace = false,
                entryFailure = null,
            ),
        )
        request.start()
    }

    override fun onCleared() {
        cancelSignOut()
        retire()
    }
}

private inline fun <reified T : ViewModel> ViewModelStore.workspaceModel(
    key: String = T::class.java.name,
    crossinline create: () -> T,
): T = ViewModelProvider(this, viewModelFactory { initializer { create() } })[key, T::class.java]
