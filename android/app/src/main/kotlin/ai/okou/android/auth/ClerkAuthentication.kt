package ai.okou.android.auth

import ai.okou.android.BuildConfig
import ai.okou.android.api.ApiFailure
import android.content.Context
import com.clerk.api.Clerk
import com.clerk.api.ClerkConfigurationOptions
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.SessionTaskKey
import com.clerk.api.session.pendingTaskKey
import com.clerk.api.user.getOrganizationMemberships
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

/** Application-lifetime SDK adapter. Its encrypted storage is the only credential owner. */
class ClerkAuthentication(private val context: Context) : Authentication {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val setupFailed = MutableStateFlow(false)

    override val state =
        combine(
                Clerk.isInitialized,
                Clerk.clientFlow,
                Clerk.isAuthFlowCompleteFlow,
                Clerk.initializationError,
                setupFailed,
            ) { initialized, client, complete, error, failed ->
                val session = client?.sessions?.firstOrNull { it.id == client.lastActiveSessionId }
                val user = session?.user
                AuthenticationState(
                    initialized = initialized,
                    session =
                        if (session != null && user != null)
                            NativeSession(
                                userId = user.id,
                                sessionId = session.id,
                                workspaceId = session.lastActiveOrganizationId,
                                active =
                                    session.status ==
                                        com.clerk.api.session.Session.SessionStatus.ACTIVE,
                                choosingWorkspace =
                                    session.pendingTaskKey == SessionTaskKey.CHOOSE_ORGANIZATION,
                            )
                        else null,
                    complete = complete,
                    failed = failed || error != null,
                    membershipAccess =
                        user
                            ?.organizationMemberships
                            ?.map {
                                MembershipAccess(
                                    it.organization.id,
                                    it.role,
                                    it.permissions?.sorted(),
                                )
                            }
                            ?.sortedBy { it.workspaceId },
                )
            }
            .stateIn(scope, SharingStarted.Eagerly, AuthenticationState())

    override fun initialize() {
        setupFailed.value = false
        try {
            if (Clerk.publishableKey != null) {
                if (Clerk.initializationError.value != null) Clerk.reinitialize()
                return
            }
            Clerk.initialize(
                context,
                BuildConfig.CLERK_PUBLISHABLE_KEY,
                ClerkConfigurationOptions(telemetryEnabled = false, enableDebugMode = false),
            )
        } catch (_: IllegalArgumentException) {
            setupFailed.value = true
        } catch (_: IllegalStateException) {
            setupFailed.value = true
        }
    }

    private fun requireSession(expected: NativeSession) {
        val session = Clerk.session
        if (
            session?.id != expected.sessionId ||
                session.user?.id != expected.userId ||
                session.lastActiveOrganizationId != expected.workspaceId
        ) {
            throw ApiFailure.Unauthenticated()
        }
    }

    override suspend fun refresh(expected: NativeSession) {
        requireSession(expected)
        Clerk.refreshClient().required()
        currentCoroutineContext().ensureActive()
        requireSession(expected)
    }

    override suspend fun memberships(expected: NativeSession): List<WorkspaceMembership> {
        requireSession(expected)
        val user = checkNotNull(Clerk.user)
        val result = mutableListOf<WorkspaceMembership>()
        var offset = 0
        do {
            val page = user.getOrganizationMemberships(limit = 100, offset = offset).required()
            currentCoroutineContext().ensureActive()
            requireSession(expected)
            result +=
                page.data.map {
                    WorkspaceMembership(it.organization.id, it.organization.name, it.role)
                }
            offset += page.data.size
            check(page.data.isNotEmpty() || offset >= page.totalCount) {
                "Membership pagination made no progress"
            }
        } while (offset < page.totalCount)
        return result.distinctBy { it.id }
    }

    override suspend fun selectWorkspace(expected: NativeSession, workspaceId: String) {
        requireSession(expected)
        Clerk.auth.setActive(expected.sessionId, workspaceId).required()
        currentCoroutineContext().ensureActive()
        val current = Clerk.session
        if (
            current?.id != expected.sessionId ||
                current.user?.id != expected.userId ||
                current.lastActiveOrganizationId != workspaceId
        ) {
            throw ApiFailure.Unauthenticated()
        }
    }

    override suspend fun token(expected: NativeSession): String {
        requireSession(expected)
        if (Clerk.activeSession == null || !Clerk.isAuthFlowComplete)
            throw ApiFailure.Unauthenticated()
        // Clerk reuses a valid cached token and owns refresh/deduplication. No forced mint per API
        // call.
        val token = Clerk.auth.getToken().required()
        currentCoroutineContext().ensureActive()
        requireSession(expected)
        return token
    }

    override suspend fun signOut() {
        Clerk.auth.signOut().required()
    }
}

private fun <T : Any, E : Any> ClerkResult<T, E>.required(): T =
    when (this) {
        is ClerkResult.Success -> value
        is ClerkResult.Failure -> {
            if (code == 401 || code == 403) throw ApiFailure.Unauthenticated()
            // Provider diagnostics may contain identifiers; the UI uses localized generic recovery.
            throw IllegalStateException("Authentication request failed")
        }
    }
