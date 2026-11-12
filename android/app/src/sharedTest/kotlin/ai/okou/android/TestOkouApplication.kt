package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.OrganizationRole
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.auth.NativeSession
import ai.okou.android.auth.WorkspaceBootstrap
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceMembership
import ai.okou.android.auth.WorkspaceSession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json

/** Compiled only into host/device tests. Production has no authentication bypass switch. */
open class TestOkouApplication : OkouApplication() {
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
        fun stored() = preferences.getOrPut(key) { testBootstrap(identity.workspaceId).preferences }
        return object : WorkspaceSession {

            override suspend fun bootstrap() =
                testBootstrap(identity.workspaceId).copy(preferences = stored())

            override suspend fun preferences() = stored()

            override suspend fun updatePreferences(
                update: UpdatePreferencesRequest
            ): UserPreferences {
                val updated =
                    stored()
                        .copy(
                            colorTheme =
                                update.colorTheme?.let {
                                    UserPreferencesColorTheme.valueOf(it.name)
                                } ?: stored().colorTheme,
                            locale =
                                update.locale?.let { UserPreferencesLocale.valueOf(it.name) }
                                    ?: stored().locale,
                        )
                preferences[key] = updated
                return updated
            }

            override fun close() = Unit
        }
    }
}

class PendingAuthenticationApplication : TestOkouApplication() {
    override fun createAuthentication(): Authentication = TestAuthentication(AuthenticationState())
}

class TestAuthentication(initial: AuthenticationState = testAuthenticationState()) :
    Authentication {
    override val state = MutableStateFlow(initial)
    var available =
        listOf(
            WorkspaceMembership("org-a", "Workspace A", "org:member"),
            WorkspaceMembership("org-b", "Workspace B", "org:member"),
        )
    var refreshAction: suspend (NativeSession) -> Unit = {}
    var tokenAction: suspend (NativeSession) -> String? = { "test-token" }
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

    override suspend fun refresh(expected: NativeSession) = refreshAction(expected)

    override suspend fun memberships(expected: NativeSession) = available

    override suspend fun token(expected: NativeSession) = tokenAction(expected)

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

fun testBootstrap(workspace: String = "org-a") =
    WorkspaceBootstrap(
        Organization(
            workspace,
            "Workspace ${workspace.last().uppercaseChar()}",
            role = OrganizationRole.MEMBER,
        ),
        Json.decodeFromString<UserPreferences>(TEST_PREFERENCES),
    )

const val TEST_PREFERENCES =
    """{"timezone":"UTC","locale":"en-US","supportedLocales":["en-US","pt-BR","ja-JP","ko-KR","id-ID","de-DE","es-ES","it-IT","fr-FR","hi-IN","zh-Hans","zh-Hant"],"pinnedAgentIds":[],"sendMode":"enter","cloudBrowserEnabledByDefault":false,"chatResourcesEnabledByDefault":false,"theme":"system","colorTheme":"default","captureNetworkBodiesRemaining":0,"memoryInitialized":true}"""
