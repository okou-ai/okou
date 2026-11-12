package ai.okou.android.auth

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.InitializePreferencesRequest
import ai.okou.android.api.generated.InitializePreferencesRequestLocale
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.UserPreferences
import java.io.Closeable
import java.util.Locale
import java.util.TimeZone
import okhttp3.HttpUrl.Companion.toHttpUrl

data class WorkspaceIdentity(
    val apiOrigin: String,
    val userId: String,
    val sessionId: String,
    val workspaceId: String,
)

data class WorkspaceBootstrap(val organization: Organization, val preferences: UserPreferences)

interface WorkspaceSession : Closeable {
    suspend fun bootstrap(): WorkspaceBootstrap
}

fun interface WorkspaceSessionFactory {
    fun create(identity: WorkspaceIdentity, tokens: WorkspaceTokenProvider): WorkspaceSession
}

class CanonicalWorkspaceSession(
    private val identity: WorkspaceIdentity,
    tokens: WorkspaceTokenProvider,
    private val locale: InitializePreferencesRequestLocale = initialLocale(Locale.getDefault()),
    private val timezone: String = TimeZone.getDefault().id,
) : WorkspaceSession {
    private val api = ApiClient(identity.apiOrigin.toHttpUrl(), tokens)

    override suspend fun bootstrap(): WorkspaceBootstrap {
        val organization = api.organization()
        check(organization.id == identity.workspaceId) {
            "Workspace response belongs to another identity"
        }
        val existing =
            try {
                api.preferences()
            } catch (error: ApiFailure.Http) {
                if (error.status != 409) throw error
                null
            }
        val preferences =
            if (existing != null && existing.initialized()) existing
            else {
                api.initializePreferences(
                    InitializePreferencesRequest(timezone = timezone, locale = locale)
                )
            }
        check(preferences.initialized()) { "Workspace initialization is incomplete" }
        return WorkspaceBootstrap(organization, preferences)
    }

    override fun close() = api.close()
}

private fun UserPreferences.initialized(): Boolean =
    memoryInitialized &&
        locale != null &&
        // The canonical API validates IANA names. Older Android tzdata must not reject newer zones.
        !timezone.isNullOrBlank()

/** Bootstrap fallback only. Server preference presentation/synchronization belongs to A5. */
internal fun initialLocale(locale: Locale): InitializePreferencesRequestLocale =
    when (locale.language) {
        "pt" -> InitializePreferencesRequestLocale.PT_BR
        "ja" -> InitializePreferencesRequestLocale.JA_JP
        "ko" -> InitializePreferencesRequestLocale.KO_KR
        "id",
        "in" -> InitializePreferencesRequestLocale.ID_ID
        "de" -> InitializePreferencesRequestLocale.DE_DE
        "es" -> InitializePreferencesRequestLocale.ES_ES
        "it" -> InitializePreferencesRequestLocale.IT_IT
        "fr" -> InitializePreferencesRequestLocale.FR_FR
        "hi" -> InitializePreferencesRequestLocale.HI_IN
        "zh" ->
            if (
                locale.script == "Hant" ||
                    locale.script != "Hans" && locale.country in setOf("TW", "HK", "MO")
            )
                InitializePreferencesRequestLocale.ZH_HANT
            else InitializePreferencesRequestLocale.ZH_HANS
        else -> InitializePreferencesRequestLocale.EN_US
    }
