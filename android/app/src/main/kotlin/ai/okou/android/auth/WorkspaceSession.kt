package ai.okou.android.auth

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.SignedTransferClient
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatMessageSearchResponseResultsItemMatchedMessageRole
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.EmailSubscription
import ai.okou.android.api.generated.EmailSubscriptionUpdate
import ai.okou.android.api.generated.FeatureSwitches
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
import ai.okou.android.api.generated.RunActivitySummaryStatus
import ai.okou.android.api.generated.SendRequest
import ai.okou.android.api.generated.SendRequestVariant1
import ai.okou.android.api.generated.SetThreadModelRequest
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.api.generated.UpdateInstructionsRequest
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.uploadChatAttachment
import ai.okou.android.artifacts.ArtifactQuery
import ai.okou.android.artifacts.ArtifactService
import ai.okou.android.chat.AblyRealtimeConnection
import ai.okou.android.chat.AssistantRecoveryService
import ai.okou.android.chat.ChatAttachmentReference
import ai.okou.android.chat.ChatAttachmentService
import ai.okou.android.chat.ChatComposerService
import ai.okou.android.chat.ChatListService
import ai.okou.android.chat.ChatSnapshotUnavailable
import ai.okou.android.chat.ComposerWorkflowService
import ai.okou.android.chat.DraftChatAttachment
import ai.okou.android.chat.HistoryBatch
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.HistoryPage
import ai.okou.android.chat.InputObservation
import ai.okou.android.chat.RealtimeService
import ai.okou.android.chat.RealtimeSnapshot
import ai.okou.android.chat.RunControlService
import ai.okou.android.chat.RunOutputSignal
import ai.okou.android.chat.RunOutputTarget
import ai.okou.android.chat.SearchArtifactHit
import ai.okou.android.chat.SearchArtifactPage
import ai.okou.android.chat.SearchMessageHit
import ai.okou.android.chat.ServerDraftTarget
import ai.okou.android.chat.TextDisposition
import ai.okou.android.chat.WorkspaceSearchService
import ai.okou.android.chat.asConfirmedProject
import ai.okou.android.chat.historyJson
import ai.okou.android.chat.readHistoryNdjson
import ai.okou.android.chat.workspaceSearchMarkdownExcerpt
import ai.okou.android.connectors.ConnectorService
import ai.okou.android.instructions.PersonalInstructionsService
import ai.okou.android.settings.BuiltInToolsService
import ai.okou.android.settings.CanonicalBuiltInToolsService
import ai.okou.android.settings.ProactivePreferencesService
import ai.okou.android.workflows.WorkflowService
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

interface WorkspaceSession :
    Closeable,
    ChatListService,
    PersonalInstructionsService,
    ChatComposerService,
    RealtimeService,
    RunControlService,
    WorkspaceSearchService,
    AssistantRecoveryService {
    val artifacts: ArtifactService
    val connectors: ConnectorService?
        get() = null

    val workflowService: WorkflowService?
        get() = null

    val proactivePreferences: ProactivePreferencesService?
        get() = null

    val builtInTools: BuiltInToolsService?
        get() = null

    suspend fun usagePackCredits(): ai.okou.android.api.generated.UsagePackCredits

    suspend fun activateModelAccount(
        accountId: String,
    ): ai.okou.android.api.generated.ActivatedModelAccount

    suspend fun organization(): Organization

    suspend fun preferences(): UserPreferences

    suspend fun defaultModelPreference(): DefaultModelPreference

    suspend fun updateDefaultModelPreference(
        update: UpdateDefaultModelPreference,
    ): DefaultModelPreference

    suspend fun emailSubscription(): EmailSubscription

    suspend fun updateEmailSubscription(subscribed: Boolean): EmailSubscriptionUpdate

    suspend fun featureSwitches(): FeatureSwitches

    suspend fun updatePreferences(update: UpdatePreferencesRequest): UserPreferences

    /**
     * Safe to call on Main. Stop accepting work and initiate cancellation before returning.
     * Transport owners release sockets on their own workers.
     */
    override fun close()
}

fun interface WorkspaceSessionFactory {
    fun create(identity: WorkspaceIdentity, tokens: WorkspaceTokenProvider): WorkspaceSession
}

class CanonicalWorkspaceSession(
    private val identity: WorkspaceIdentity,
    tokens: WorkspaceTokenProvider,
    private val locale: InitializePreferencesRequestLocale = initialLocale(Locale.getDefault()),
    private val timezone: String? = initialTimezone(),
    onUpdateRequired: (RequiredUpdate) -> Unit = {},
) : WorkspaceSession, WorkflowService, ChatAttachmentService, ComposerWorkflowService {
    override val attachmentService: ChatAttachmentService
        get() = this

    override val workflowService: WorkflowService
        get() = this

    override val composerWorkflowService: ComposerWorkflowService
        get() = this

    override suspend fun composerWorkflows() = api.composerWorkflows()

    override suspend fun recentComposerWorkflows() = api.recentComposerWorkflows()

    override suspend fun recordComposerWorkflowUse(ids: List<String>) =
        api.recordComposerWorkflowUse(ids)

    private val api =
        ApiClient(identity.apiOrigin.toHttpUrl(), tokens, onUpdateRequired = onUpdateRequired)
    override val proactivePreferences = ProactivePreferencesService(api)
    private val builtInToolsService =
        CanonicalBuiltInToolsService(api, identity.apiOrigin.toHttpUrl())
    override val builtInTools: BuiltInToolsService
        get() = builtInToolsService

    override val connectors = ConnectorService(api)
    private val transfers = SignedTransferClient()
    override val artifacts = ArtifactService(api, transfers, identity.apiOrigin)
    private val archiveJson = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
    }

    override suspend fun chatSnapshot() = api.chatSnapshot()

    override suspend fun workflows() = api.workflows()

    override suspend fun workflow(id: String) = api.workflow(id)

    override suspend fun workflowRunHistory(id: String, cursor: String?) =
        api.workflowRunHistory(id, cursor)

    override suspend fun workflowAutomations() = api.workspaceWorkflowAutomations()

    override suspend fun workflowConnections() = api.workflowConnections()

    override suspend fun updateWorkflow(id: String, request: UpdateWorkflowRequest) =
        api.updateWorkflow(id, request)

    override suspend fun createAutomation(
        workflowId: String,
        request: CreateWorkflowAutomationRequest,
    ) = api.createWorkflowAutomation(workflowId, request)

    override suspend fun updateAutomation(id: String, request: UpdateWorkflowAutomationRequest) =
        api.updateWorkflowAutomation(id, request)

    override suspend fun setAutomationEnabled(id: String, enabled: Boolean) =
        api.setWorkflowAutomationEnabled(id, enabled)

    override suspend fun searchArtifacts(keyword: String, cursor: String?): SearchArtifactPage {
        val page = artifacts.page(ArtifactQuery(keyword = keyword), cursor = cursor, limit = 25)
        return SearchArtifactPage(
            page.items.map { SearchArtifactHit(it.id, it.title, it.kind) },
            page.nextCursor,
        )
    }

    override suspend fun searchMessages(keyword: String): List<SearchMessageHit> {
        val results = api.searchChatMessages(keyword).results
        if (results.isEmpty()) return emptyList()
        return withContext(Dispatchers.Default) {
            results.mapNotNull { result ->
                ensureActive()
                val match = result.matchedMessage
                if (result.chatThreadId != match.chatThreadId) return@mapNotNull null
                val ranges =
                    result.matchedRanges.mapNotNull { range ->
                        if (
                            range.start < 0 ||
                                range.end <= range.start ||
                                range.end > match.content.length
                        )
                            null
                        else range.start.toInt() until range.end.toInt()
                    }
                val excerpt =
                    if (
                        match.role ==
                            ChatMessageSearchResponseResultsItemMatchedMessageRole.ASSISTANT
                    )
                        workspaceSearchMarkdownExcerpt(match.content, ranges)
                    else null
                SearchMessageHit(
                    match.chatThreadId,
                    match.seqId,
                    excerpt?.text ?: match.content,
                    excerpt?.ranges ?: ranges,
                    sourceRange = excerpt?.sourceRange ?: ranges.minByOrNull { it.first },
                )
            }
        }
    }

    override suspend fun observeRealtime(
        target: StateFlow<RunOutputTarget?>,
        output: suspend (RunOutputTarget, RunOutputSignal) -> Unit,
        observe: suspend (RealtimeSnapshot) -> Unit,
    ): Nothing =
        withContext(Dispatchers.IO) {
            AblyRealtimeConnection(
                    identity.userId,
                    identity.workspaceId,
                    currentCoroutineContext(),
                ) {
                    archiveJson.encodeToString(api.realtimeToken())
                }
                .use { connection ->
                    coroutineScope {
                        launch {
                            target.collectLatest { selected ->
                                if (selected != null)
                                    connection.runOutput(selected).collect { signal ->
                                        withContext(Dispatchers.Main.immediate) {
                                            output(selected, signal)
                                        }
                                    }
                            }
                        }
                        connection.state.collect {
                            val next = connection.takeObservation()
                            next.failure?.let { throw it }
                            withContext(Dispatchers.Main.immediate) { observe(next) }
                        }
                    }
                }
        }

    override suspend fun chatEvents(since: Long?) = api.chatEvents(since)

    override suspend fun indicators() = api.indicators()

    override suspend fun draftThreadIds() = api.draftThreadIds()

    override suspend fun newChatReady(): Boolean {
        val status = api.onboardingStatus()
        return status.hasOrg && !status.needsOnboarding
    }

    override suspend fun createThread(request: CreateThreadRequest) = api.createThread(request)

    override suspend fun composerDraft(target: ServerDraftTarget) = api.composerDraft(target)

    override suspend fun saveComposerDraft(target: ServerDraftTarget, text: String) =
        api.saveComposerDraft(target, text)

    override suspend fun saveAttachmentDraft(
        target: ServerDraftTarget,
        text: String,
        attachments: List<ChatAttachmentReference>,
    ) = api.saveComposerDraft(target, text, attachments)

    override suspend fun uploadChatAttachment(
        file: File,
        attachment: DraftChatAttachment,
        progress: (Long) -> Unit,
    ) =
        uploadChatAttachment(
            api,
            transfers,
            file,
            attachment.filename,
            attachment.contentType,
            checkNotNull(attachment.size),
            progress,
        )

    override suspend fun sendInput(request: SendRequestVariant1) = api.sendInput(request)

    override suspend fun sendControl(request: SendRequest) = api.sendInput(request)

    override suspend fun recoveryCatalog() = api.recoveryCatalog()

    override suspend fun recoveryModels() = api.recoveryModels()

    override suspend fun defaultModelPreference() = api.defaultModelPreference()

    override suspend fun updateDefaultModelPreference(update: UpdateDefaultModelPreference) =
        api.updateDefaultModelPreference(update)

    override suspend fun emailSubscription() = api.emailSubscription()

    override suspend fun updateEmailSubscription(subscribed: Boolean) =
        api.updateEmailSubscription(subscribed)

    override suspend fun featureSwitches() = api.featureSwitches()

    override suspend fun recoverySubscriptions() = api.recoverySubscriptions()

    override suspend fun recoveryBilling() = api.recoveryBilling()

    override suspend fun usagePackCredits() = api.usagePackCredits()

    override suspend fun activateModelAccount(accountId: String) =
        api.activateModelAccount(accountId)

    override suspend fun resetSubscription(accountId: String, idempotencyKey: String) =
        api.resetSubscription(accountId, idempotencyKey)

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
                        observed.input?.seqId,
                    )
            }
        if (result.threadId != threadId || result.eventId != eventId)
            throw ApiFailure.IncompatibleResponse()
        return result
    }

    override suspend fun projectSnapshot() = api.projectSnapshot()

    override suspend fun projectEvents(since: Long) = api.projectEvents(since)

    override suspend fun personalInstructions() = api.personalInstructions().owned()

    override suspend fun updatePersonalInstructions(content: String, ifVersion: String) =
        api.updatePersonalInstructions(UpdateInstructionsRequest(content, ifVersion)).owned()

    private fun PersonalInstructions.owned(): PersonalInstructions {
        if (orgId != identity.workspaceId || userId != identity.userId)
            throw ApiFailure.IncompatibleResponse()
        return this
    }

    override suspend fun historySnapshot(threadId: String) = api.historySnapshot(threadId)

    override suspend fun historyCatchUp(cursors: Map<String, HistoryCursor>): HistoryBatch =
        withContext(Dispatchers.Default) {
            val batch = api.historyCatchUp(cursors)
            HistoryBatch(
                batch.events.mapValues { (_, rows) ->
                    rows.map { HistoryEvent.decode(historyJson.encodeToJsonElement(it).jsonObject) }
                },
                batch.notFoundThreads,
            )
        }

    override suspend fun threadDetail(threadId: String) = api.threadDetail(threadId)

    override suspend fun summarizeRunActivity(threadId: String, runId: String): String? {
        val summary = api.summarizeRunActivity(threadId, runId)
        if (summary.runId != runId) throw ApiFailure.IncompatibleResponse()
        return summary.messages
            .firstOrNull { it.text.isNotBlank() }
            ?.text
            .takeIf { summary.status == RunActivitySummaryStatus.AVAILABLE }
    }

    override suspend fun markRead(threadId: String) = api.markRead(threadId)

    override suspend fun markUnread(threadId: String) = api.markUnread(threadId)

    override suspend fun setMuted(threadId: String, muted: Boolean, eventId: String) =
        api.setMuted(threadId, muted, eventId)

    override suspend fun setArchived(threadId: String, archived: Boolean, eventId: String) =
        api.setArchived(threadId, archived, eventId)

    override suspend fun deleteThread(threadId: String, eventId: String) =
        api.deleteThread(threadId, eventId)

    override suspend fun createProject(projectId: String, name: String) =
        api.createProject(projectId, name).asConfirmedProject(projectId)

    override suspend fun projectDetail(projectId: String) =
        api.projectDetail(projectId).asConfirmedProject(projectId)

    override suspend fun renameProject(projectId: String, name: String, eventId: String) =
        api.renameProject(projectId, name, eventId).asConfirmedProject(projectId)

    override suspend fun moveThreadToProject(
        threadId: String,
        projectId: String?,
        eventId: String,
    ) = api.moveThreadToProject(threadId, projectId, eventId)

    override suspend fun deleteProject(projectId: String, eventId: String) =
        api.deleteProject(projectId, eventId)

    override suspend fun renameThread(threadId: String, title: String, eventId: String) =
        api.renameThread(threadId, title, eventId)

    override suspend fun setThreadModel(threadId: String, request: SetThreadModelRequest) =
        api.setThreadModel(threadId, request)

    override suspend fun setPinned(threadId: String, pinOrder: String?, eventId: String) =
        api.setPinned(threadId, pinOrder, eventId)

    override suspend fun reorderPinnedThread(threadId: String, pinOrder: String, eventId: String) =
        api.reorderPinnedThread(threadId, pinOrder, eventId)

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
        downloadArchive(url, ::readHistoryNdjson)

    override suspend fun chatArchive(url: String): ChatArchive = archive(url)

    override suspend fun projectArchive(url: String): ProjectArchive = archive(url)

    @OptIn(ExperimentalSerializationApi::class)
    private suspend inline fun <reified T> archive(url: String): T =
        downloadArchive(url) { archiveJson.decodeFromStream<T>(it) }

    private suspend fun <T> downloadArchive(url: String, read: (InputStream) -> T): T =
        withContext(Dispatchers.IO) {
            val address = url.toHttpUrlOrNull() ?: throw ApiFailure.IncompatibleResponse()
            try {
                transfers.download(address, read)
            } catch (error: ApiFailure.Http) {
                throw ChatSnapshotUnavailable(error.status, error.retryAfterSeconds)
            } catch (error: IOException) {
                throw ApiFailure.Network(error)
            } catch (_: SerializationException) {
                throw ApiFailure.IncompatibleResponse()
            } catch (_: IllegalArgumentException) {
                throw ApiFailure.IncompatibleResponse()
            }
        }

    override suspend fun organization(): Organization {
        val organization = api.organization()
        if (organization.id != identity.workspaceId) throw ApiFailure.Unauthenticated()
        return organization
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
                    InitializePreferencesRequest(timezone = timezone, locale = locale),
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
        try {
            api.close()
        } finally {
            try {
                transfers.close()
            } finally {
                builtInToolsService.close()
            }
        }
    }
}

private fun UserPreferences.initialized(): Boolean =
    memoryInitialized &&
        locale != null &&
        // The canonical API validates IANA names. Older Android tzdata must not reject newer zones.
        !timezone.isNullOrBlank()

/** Use the same device language match for initialization and the Settings preview. */
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

internal fun initialTimezone(id: String = TimeZone.getDefault().id): String? = id.takeIf {
    it in TimeZone.getAvailableIDs()
}
