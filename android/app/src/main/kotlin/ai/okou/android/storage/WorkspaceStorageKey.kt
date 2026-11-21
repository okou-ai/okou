package ai.okou.android.storage

import ai.okou.android.auth.WorkspaceIdentity
import java.security.MessageDigest
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Stable across sign-ins to the same account and workspace on the same backend. */
internal fun WorkspaceIdentity.workspaceStorageKey(): String =
    scopeHash(listOf(apiOrigin.toHttpUrl().toString(), userId, workspaceId))

internal fun scopeHash(parts: List<String>): String =
    MessageDigest.getInstance("SHA-256")
        .digest(parts.joinToString("") { "${it.length}:$it" }.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
