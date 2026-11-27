package ai.okou.android.auth

import ai.okou.android.BuildConfig
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.retryAfter
import android.content.Context
import com.clerk.api.Clerk
import com.clerk.api.ClerkConfigurationOptions
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.session.Session
import com.clerk.api.session.SessionTaskKey
import com.clerk.api.session.pendingTaskKey
import com.clerk.api.user.getOrganizationMemberships
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import okhttp3.Response

/** Application-lifetime SDK adapter. Its encrypted storage is the only credential owner. */
class ClerkAuthentication(private val context: Context) : Authentication {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val setupFailed = MutableStateFlow(false)

    override val account =
        Clerk.userFlow.map { user ->
            user?.primaryEmailAddress?.emailAddress?.let { NativeAccount(user.id, it) }
        }

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

    private fun requireSession(
        expected: NativeSession,
        session: Session? = Clerk.session,
    ): Session {
        if (
            session?.id != expected.sessionId ||
                session.user?.id != expected.userId ||
                session.lastActiveOrganizationId != expected.workspaceId
        ) {
            throw ApiFailure.Unauthenticated()
        }
        return session
    }

    override suspend fun refresh(expected: NativeSession): MembershipAccess? {
        requireSession(expected)
        val client = Clerk.refreshClient().required()
        currentCoroutineContext().ensureActive()
        requireSession(expected)
        val refreshed =
            requireSession(
                expected,
                client.sessions.firstOrNull { it.id == client.lastActiveSessionId },
            )
        if (expected.active && refreshed.status != Session.SessionStatus.ACTIVE) {
            throw ApiFailure.Unauthenticated()
        }
        return refreshed.user
            ?.organizationMemberships
            ?.firstOrNull { it.organization.id == expected.workspaceId }
            ?.let { MembershipAccess(it.organization.id, it.role, it.permissions?.sorted()) }
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

    override suspend fun token(expected: NativeSession): String = token(expected, null)

    override suspend fun renewToken(expected: NativeSession): String =
        token(expected, GetTokenOptions(skipCache = true))

    private suspend fun token(expected: NativeSession, options: GetTokenOptions?): String {
        requireSession(expected)
        if (Clerk.activeSession == null || !Clerk.isAuthFlowComplete)
            throw ApiFailure.Unauthenticated()
        // Clerk reuses a valid cached token and owns refresh/deduplication. No forced mint per API
        // call.
        val token = Clerk.auth.getToken(options).required()
        currentCoroutineContext().ensureActive()
        requireSession(expected)
        return token
    }

    override suspend fun signOut() {
        val sessionId = state.value.session?.sessionId
        val result = Clerk.auth.signOut()
        // Clerk can clear its local session even when remote revocation reports an error.
        // Wait for that change to reach the app before returning the operation result.
        if (sessionId != null && Clerk.session?.id != sessionId) {
            state.first { it.session?.sessionId != sessionId }
        }
        result.required()
    }
}

internal fun <T : Any, E : Any> ClerkResult<T, E>.required(): T =
    when (this) {
        is ClerkResult.Success -> value
        is ClerkResult.Failure -> {
            val status = code
            if (status == 401 || status == 403) throw ApiFailure.Unauthenticated()
            if (status != null && (status == 408 || status == 429 || status in 500..599)) {
                val response = tags[Response::class] as? Response
                throw ApiFailure.Http(
                    status,
                    null,
                    null,
                    retryAfter(response?.header("Retry-After")),
                )
            }
            val cause = throwable
            if (cause is IOException) throw ApiFailure.Network(cause)
            // Provider diagnostics may contain identifiers; the UI uses localized generic recovery.
            throw IllegalStateException("Authentication request failed")
        }
    }
