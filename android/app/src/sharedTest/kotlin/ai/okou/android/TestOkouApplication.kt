package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.OrganizationRole
import ai.okou.android.api.generated.SendRequest
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.auth.CanonicalWorkspaceSession
import ai.okou.android.auth.MembershipAccess
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.NativeSession
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceMembership
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.ChatComposerService
import ai.okou.android.chat.ChatListService
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.RealtimeService
import ai.okou.android.chat.RunControlService
import ai.okou.android.connectors.ConnectorService
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.instructions.PersonalInstructionsService
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import ai.okou.android.workflows.WorkflowService
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json

/** Compiled only into host/device tests. Production has no authentication bypass switch. */
open class TestOkouApplication : OkouApplication() {
    override fun startCrashReporting() = Unit

    var updateService: UpdateService? = null
    var updateOwner: AppUpdates? = null
    override val updates
        get() = updateOwner ?: testUpdates

    private val testUpdates by lazy {
        val service =
            object : UpdateService {
                override suspend fun initialize(retainedRelease: AndroidUpdatesRelease?) {
                    updateService?.initialize(retainedRelease)
                }

                override suspend fun check() =
                    updateService?.check()
                        ?: AndroidUpdates(
                            null,
                            AndroidUpdatesRelease(
                                BuildConfig.VERSION_NAME,
                                24,
                                1,
                                "0".repeat(64),
                                "https://static.okou.io/unused",
                                "",
                            ),
                        )

                override suspend fun recover(release: AndroidUpdatesRelease) =
                    updateService?.recover(release)

                override suspend fun download(
                    release: AndroidUpdatesRelease,
                    progress: (Long) -> Unit,
                ): File = checkNotNull(updateService).download(release, progress)

                override fun close() {
                    updateService?.close()
                }
            }
        AppUpdates(
            service,
            object : UpdateStore {
                override suspend fun load(): UpdateRecord? = null

                override suspend fun save(record: UpdateRecord) = Unit
            },
            BuildConfig.VERSION_NAME,
            android.os.Build.VERSION.SDK_INT,
        )
    }
    var chatService: ChatListService = TestChatService()
    var workflows: WorkflowService? = null
    var initialPreferences: UserPreferences? = null
    internal var preferenceWrite:
        suspend (UpdatePreferencesRequest, () -> UserPreferences) -> UserPreferences =
        { _, save ->
            save()
        }
    var workspaceRole = OrganizationRole.MEMBER
    var connectorService: ConnectorService? = null
    var screenshotBuiltInTools: ai.okou.android.settings.BuiltInToolsService? = null
    var searchService: ai.okou.android.chat.WorkspaceSearchService = EmptyWorkspaceSearchService
    var realtimeService: RealtimeService = TestRealtimeService()
    var composerService: ChatComposerService = TestChatComposerService()
    var journalStore: ComposerJournalStore? = null
    var controlService: RunControlService? = null
    var recoveryService: ai.okou.android.chat.AssistantRecoveryService =
        TestAssistantRecoveryService()
    override val composerJournal
        get() = journalStore ?: super.composerJournal

    var instructionsService: PersonalInstructionsService? = null
    internal var proactivePreferencesService:
        ai.okou.android.settings.ProactivePreferencesService? =
        null
    var instructionsStore: PersonalInstructionsDraftStore? = null
    override val instructionsDrafts
        get() = instructionsStore ?: super.instructionsDrafts

    // External API fixture data survives a new Activity/session owner, as the real server does.
    private val preferences = mutableMapOf<Triple<String, String, String>, UserPreferences>()

    fun snapshotApiPreferences() = preferences.toMap()

    fun restoreApiPreferences(saved: Map<Triple<String, String, String>, UserPreferences>) {
        preferences.clear()
        preferences.putAll(saved)
    }

    override fun createAuthentication(): Authentication = TestAuthentication()

    override fun createWorkspaceSession(
        identity: WorkspaceIdentity,
        tokens: WorkspaceTokenProvider,
    ): WorkspaceSession {
        val key = Triple(identity.apiOrigin, identity.userId, identity.workspaceId)
        fun stored() = preferences.getOrPut(key) { initialPreferences ?: testPreferences() }
        val fixture = chatService as? WorkspaceSession
        val canonical = lazy { CanonicalWorkspaceSession(identity, tokens) }
        return object :
            WorkspaceSession,
            ai.okou.android.chat.AssistantRecoveryService by recoveryService,
            RealtimeService by realtimeService,
            ChatListService by chatService,
            ai.okou.android.chat.WorkspaceSearchService by searchService,
            ChatComposerService by composerService {

            override val artifacts = (fixture ?: canonical.value).artifacts
            override val workflowService = workflows
            override val connectors = connectorService
            override val builtInTools = screenshotBuiltInTools
            override val proactivePreferences = proactivePreferencesService

            override suspend fun usagePackCredits() =
                (fixture ?: canonical.value).usagePackCredits()

            override suspend fun defaultModelPreference() =
                fixture?.defaultModelPreference()
                    ?: ai.okou.android.api.generated.DefaultModelPreference(null, null, emptyMap())

            override suspend fun updateDefaultModelPreference(
                update: ai.okou.android.api.generated.UpdateDefaultModelPreference,
            ) = (fixture ?: canonical.value).updateDefaultModelPreference(update)

            override suspend fun featureSwitches() =
                fixture?.featureSwitches()
                    ?: ai.okou.android.api.generated.FeatureSwitches(emptyMap())

            override suspend fun activateModelAccount(accountId: String) =
                (fixture ?: canonical.value).activateModelAccount(accountId)

            override suspend fun emailSubscription() =
                checkNotNull(fixture) { "No email subscription backend in this fixture" }
                    .emailSubscription()

            override suspend fun updateEmailSubscription(subscribed: Boolean) =
                checkNotNull(fixture) { "No email subscription backend in this fixture" }
                    .updateEmailSubscription(subscribed)

            override suspend fun sendControl(request: SendRequest) =
                checkNotNull(controlService) { "No control backend in this external fixture" }
                    .sendControl(request)

            override suspend fun personalInstructions() =
                checkNotNull(instructionsService).personalInstructions()

            override suspend fun updatePersonalInstructions(content: String, ifVersion: String) =
                checkNotNull(instructionsService).updatePersonalInstructions(content, ifVersion)

            override suspend fun organization() =
                testOrganization(identity.workspaceId).copy(role = workspaceRole)

            override suspend fun preferences() = stored()

            override suspend fun updatePreferences(
                update: UpdatePreferencesRequest,
            ): UserPreferences =
                preferenceWrite(update) {
                    val updated =
                        stored()
                            .copy(
                                timezone = update.timezone ?: stored().timezone,
                                colorTheme =
                                    update.colorTheme?.let {
                                        UserPreferencesColorTheme.valueOf(it.name)
                                    } ?: stored().colorTheme,
                                locale =
                                    update.locale?.let { UserPreferencesLocale.valueOf(it.name) }
                                        ?: stored().locale,
                                theme =
                                    update.theme?.let { UserPreferencesTheme.valueOf(it.name) }
                                        ?: stored().theme,
                                cloudBrowserEnabledByDefault =
                                    update.cloudBrowserEnabledByDefault
                                        ?: stored().cloudBrowserEnabledByDefault,
                            )
                    preferences[key] = updated
                    updated
                }

            override fun close() {
                if (canonical.isInitialized()) canonical.value.close()
            }
        }
    }
}

class PendingAuthenticationApplication : TestOkouApplication() {
    override fun createAuthentication(): Authentication = TestAuthentication(AuthenticationState())
}

class TestAuthentication(initial: AuthenticationState = testAuthenticationState()) :
    Authentication {
    override val state = MutableStateFlow(initial)
    override val account = MutableStateFlow<NativeAccount?>(null)
    var available =
        listOf(
            WorkspaceMembership("org-a", "Workspace A", "org:member"),
            WorkspaceMembership("org-b", "Workspace B", "org:member"),
        )
    var refreshAction: suspend (NativeSession) -> Unit = {}
    var refreshedMembership: (NativeSession) -> MembershipAccess? = { expected ->
        state.value.membershipAccess?.firstOrNull { it.workspaceId == expected.workspaceId }
    }
    var membershipsAction: suspend () -> List<WorkspaceMembership> = { available }
    var tokenAction: suspend (NativeSession) -> String? = { "test-token" }
    var renewTokenAction: suspend (NativeSession) -> String? = { tokenAction(it) }
    var selectAction: suspend (NativeSession, String) -> Unit = { session, id ->
        state.value =
            state.value.copy(
                session = session.copy(workspaceId = id, active = true, choosingWorkspace = false),
                complete = true,
            )
    }
    var signOutAction: suspend () -> Unit = {
        state.value = AuthenticationState(initialized = true)
    }

    override fun initialize() = Unit

    override suspend fun refresh(expected: NativeSession): MembershipAccess? {
        refreshAction(expected)
        return refreshedMembership(expected)
    }

    override suspend fun memberships(expected: NativeSession) = membershipsAction()

    override suspend fun token(expected: NativeSession) = tokenAction(expected)

    override suspend fun renewToken(expected: NativeSession) = renewTokenAction(expected)

    override suspend fun selectWorkspace(expected: NativeSession, workspaceId: String) =
        selectAction(expected, workspaceId)

    override suspend fun signOut() = signOutAction()
}

fun testAuthenticationState(
    user: String = "user-a",
    session: String = "session-a",
    workspace: String? = "org-a",
) =
    AuthenticationState(
        initialized = true,
        session = NativeSession(user, session, workspace, active = true),
        complete = true,
    )

fun testOrganization(workspace: String = "org-a") =
    Organization(
        workspace,
        "Workspace ${workspace.last().uppercaseChar()}",
        role = OrganizationRole.MEMBER,
    )

fun testPreferences() = Json.decodeFromString<UserPreferences>(TEST_PREFERENCES)

const val TEST_PREFERENCES =
    """{"timezone":"UTC","locale":"en-US","supportedLocales":["en-US","pt-BR","ja-JP","ko-KR","id-ID","de-DE","es-ES","it-IT","fr-FR","hi-IN","zh-Hans","zh-Hant"],"sendMode":"enter","cloudBrowserEnabledByDefault":false,"chatResourcesEnabledByDefault":false,"theme":"system","colorTheme":"default","forYouCoverId":null,"captureNetworkBodiesRemaining":0,"memoryInitialized":true}"""
