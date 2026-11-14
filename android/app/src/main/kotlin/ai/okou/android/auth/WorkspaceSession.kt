package ai.okou.android.auth

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.SignedTransferClient
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.InitializePreferencesRequest
import ai.okou.android.api.generated.InitializePreferencesRequestLocale
import ai.okou.android.api.generated.InputStatusVariant1
import ai.okou.android.api.generated.InputStatusVariant2
import ai.okou.android.api.generated.InputStatusVariant2Status
import ai.okou.android.api.generated.InputStatusVariant3
import ai.okou.android.api.generated.InputStatusVariant3Status
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.api.generated.ProjectArchive
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.api.generated.UpdateInstructionsRequest
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.chat.ChatComposerService
import ai.okou.android.chat.ChatListService
import ai.okou.android.chat.ChatSnapshotUnavailable
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.HistoryPage
import ai.okou.android.chat.InputObservation
import ai.okou.android.chat.TextDisposition
import ai.okou.android.chat.historyJson
import ai.okou.android.chat.readHistoryNdjson
import ai.okou.android.instructions.PersonalInstructionsService
import java.io.Closeable
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
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

interface WorkspaceSession :
    Closeable, ChatListService, PersonalInstructionsService, ChatComposerService {
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

    override suspend fun newChatAgent(): String? {
        if (api.featureSwitches().effectiveSwitches["singleAgent"] != true) return null
        val status = api.onboardingStatus()
        return status.defaultAgentId?.takeIf {
            status.hasOrg && status.hasDefaultAgent && status.onboardingComplete
        }
    }

    override suspend fun createThread(request: CreateThreadRequest) = api.createThread(request)

    override suspend fun sendInput(request: SendRequestVariant1) = api.sendInput(request)

    override suspend fun observeInput(threadId: String, eventId: String): InputObservation {
        val observed = api.inputStatus(threadId, eventId)
        val result =
            when (observed) {
                is InputStatusVariant1 ->
                    InputObservation(observed.threadId, observed.eventId, TextDisposition.Consumed)
                is InputStatusVariant2 ->
                    InputObservation(
                        observed.threadId,
                        observed.eventId,
                        when (observed.status) {
                            InputStatusVariant2Status.COMPLETED -> TextDisposition.Completed
                            InputStatusVariant2Status.FAILED -> TextDisposition.Failed
                            InputStatusVariant2Status.CANCELLED -> TextDisposition.Cancelled
                        },
                    )
                is InputStatusVariant3 ->
                    InputObservation(
                        observed.threadId,
                        observed.eventId,
                        when (observed.status) {
                            InputStatusVariant3Status.QUEUED -> TextDisposition.Queued
                            InputStatusVariant3Status.REJECTED -> TextDisposition.Rejected
                            InputStatusVariant3Status.REVOKED -> TextDisposition.Revoked
                            InputStatusVariant3Status.UNAVAILABLE -> null
                        },
                    )
            }
        if (result.threadId != threadId || result.eventId != eventId)
            throw ApiFailure.IncompatibleResponse()
        return result
    }

    override suspend fun projectSnapshot() = api.projectSnapshot()

    override suspend fun projectEvents(since: Long) = api.projectEvents(since)

    override suspend fun featureSwitches() = api.featureSwitches()

    override suspend fun personalInstructionsEnabled() =
        api.featureSwitches().effectiveSwitches["singleAgent"] == true

    override suspend fun personalInstructions() = api.personalInstructions().owned()

    override suspend fun updatePersonalInstructions(content: String, ifVersion: String) =
        api.updatePersonalInstructions(UpdateInstructionsRequest(content, ifVersion)).owned()

    private fun PersonalInstructions.owned(): PersonalInstructions {
        if (orgId != identity.workspaceId || userId != identity.userId)
            throw ApiFailure.IncompatibleResponse()
        return this
    }

    override suspend fun historySnapshot(threadId: String) = api.historySnapshot(threadId)

    override suspend fun threadDetail(threadId: String) = api.threadDetail(threadId)

    override suspend fun markRead(threadId: String) = api.markRead(threadId)

    override suspend fun historyRows(threadId: String, cursor: HistoryCursor): HistoryPage =
        withContext(Dispatchers.Default) {
            val page = api.historyRows(threadId, cursor)
            val next = historyJson.encodeToJsonElement(page.cursor).jsonObject
            HistoryPage(
                page.rows.map {
                    HistoryEvent.decode(historyJson.encodeToJsonElement(it).jsonObject)
                },
                HistoryCursor(
                    next.getValue("lastEventId").jsonPrimitive.contentOrNull,
                    next.getValue("lastSeqId").jsonPrimitive.long,
                ),
                page.hasMore,
            )
        }

    override suspend fun historyArchive(url: String): List<HistoryEvent> =
        withContext(Dispatchers.IO) {
            val address = url.toHttpUrlOrNull() ?: throw ApiFailure.IncompatibleResponse()
            try {
                transfers.download(address, ::readHistoryNdjson)
            } catch (error: ApiFailure.Http) {
                throw ChatSnapshotUnavailable(error.status)
            } catch (_: SerializationException) {
                throw ApiFailure.IncompatibleResponse()
            } catch (_: IllegalArgumentException) {
                throw ApiFailure.IncompatibleResponse()
            }
        }

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
