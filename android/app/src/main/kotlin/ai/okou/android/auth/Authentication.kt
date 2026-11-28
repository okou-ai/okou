package ai.okou.android.auth

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow

data class NativeAccount(val userId: String, val email: String)

data class NativeSession(
    val userId: String,
    val sessionId: String,
    val workspaceId: String?,
    val active: Boolean,
    val choosingWorkspace: Boolean = false,
)

data class AuthenticationState(
    val initialized: Boolean = false,
    val session: NativeSession? = null,
    val complete: Boolean = false,
    val failed: Boolean = false,
    val membershipAccess: List<MembershipAccess>? = null,
)

data class MembershipAccess(
    val workspaceId: String,
    val role: String,
    val permissions: List<String>?,
)

data class WorkspaceMembership(
    val id: String,
    val name: String,
    val role: String,
    val uploadedImageUrl: String? = null,
)

/** Credentials, authentication attempts and protocol callbacks remain owned by the SDK. */
interface Authentication {
    val state: StateFlow<AuthenticationState>
    val account: Flow<NativeAccount?>
        get() = emptyFlow()

    fun initialize()

    suspend fun refresh(expected: NativeSession): MembershipAccess?

    /** Already hydrated presentation metadata for the selected workspace. */
    fun cachedWorkspaceMembership(expected: NativeSession): WorkspaceMembership? = null

    suspend fun memberships(expected: NativeSession): List<WorkspaceMembership>

    suspend fun selectWorkspace(expected: NativeSession, workspaceId: String)

    suspend fun token(expected: NativeSession): String?

    suspend fun renewToken(expected: NativeSession): String? = token(expected)

    suspend fun signOut()
}
