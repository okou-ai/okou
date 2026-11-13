package ai.okou.android.auth

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.SignedTransferClient
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.InitializePreferencesRequest
import ai.okou.android.api.generated.InitializePreferencesRequestLocale
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.chat.ChatListService
import ai.okou.android.chat.ChatSnapshotUnavailable
import java.io.Closeable
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

data class WorkspaceIdentity(
    val apiOrigin: String,
    val userId: String,
    val sessionId: String,
    val workspaceId: String,
    val authorizationScope: String = "",
)

data class WorkspaceBootstrap(val organization: Organization, val preferences: UserPreferences)

interface WorkspaceSession : Closeable, ChatListService {
    suspend fun bootstrap(): WorkspaceBootstrap

    suspend fun preferences(): UserPreferences

    suspend fun updatePreferences(update: UpdatePreferencesRequest): UserPreferences
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
    private val transfers = SignedTransferClient()
    private val archiveJson = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
    }

    override suspend fun chatSnapshot() = api.chatSnapshot()

    override suspend fun chatEvents(since: Long?) = api.chatEvents(since)

    override suspend fun indicators() = api.indicators()

    override suspend fun agents() = api.agents()

    override suspend fun projectSnapshot() = api.projectSnapshot()

    override suspend fun projectEvents(since: Long) = api.projectEvents(since)

    override suspend fun featureSwitches() = api.featureSwitches()

    override suspend fun chatArchive(url: String): ChatArchive = archive(url)

    override suspend fun projectArchive(url: String): ProjectArchive = archive(url)

    @OptIn(ExperimentalSerializationApi::class)
    private suspend inline fun <reified T> archive(url: String): T =
        withContext(Dispatchers.IO) {
            val address = url.toHttpUrlOrNull() ?: throw ApiFailure.IncompatibleResponse()
            try {
                transfers.download(address) { archiveJson.decodeFromStream<T>(it) }
            } catch (error: ApiFailure.Http) {
                throw ChatSnapshotUnavailable(error.status)
            } catch (_: SerializationException) {
                throw ApiFailure.IncompatibleResponse()
            } catch (_: IllegalArgumentException) {
                throw ApiFailure.IncompatibleResponse()
            }
        }

    override suspend fun bootstrap(): WorkspaceBootstrap {
        val organization = api.organization()
        check(organization.id == identity.workspaceId) {
            "Workspace response belongs to another identity"
        }
        return WorkspaceBootstrap(organization, preferences())
    }

    override suspend fun preferences(): UserPreferences {
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
        return preferences
    }

    override suspend fun updatePreferences(update: UpdatePreferencesRequest): UserPreferences =
        api.updatePreferences(update).also {
            check(it.initialized()) { "Workspace preferences are incomplete" }
        }

    override fun close() {
        api.close()
        transfers.close()
    }
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
