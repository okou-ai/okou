package ai.okou.android.api

import ai.okou.android.BuildConfig
import ai.okou.android.api.generated.ActivateModelAccountRequest
import ai.okou.android.api.generated.AndroidUpgradeRequired
import ai.okou.android.api.generated.ApiError
import ai.okou.android.api.generated.ApiHeaders
import ai.okou.android.api.generated.ArtifactCatalogQuery
import ai.okou.android.api.generated.ArtifactDetailQuery
import ai.okou.android.api.generated.CanonicalApi
import ai.okou.android.api.generated.CanonicalZero
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.ComposerDraft
import ai.okou.android.api.generated.CreateProjectRequest
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.DeleteProjectRequest
import ai.okou.android.api.generated.HistoryCatchUpRequestItem
import ai.okou.android.api.generated.HistoryRowsQueryVariant1
import ai.okou.android.api.generated.HistoryRowsQueryVariant2
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.InitializePreferencesRequest
import ai.okou.android.api.generated.MoveThreadToProjectRequest
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.api.generated.ProjectEvents
import ai.okou.android.api.generated.ProjectSnapshot
import ai.okou.android.api.generated.RealtimeTokenRequest
import ai.okou.android.api.generated.RenameProjectRequest
import ai.okou.android.api.generated.RenameThreadRequest
import ai.okou.android.api.generated.ReorderPinnedThreadRequest
import ai.okou.android.api.generated.ResolveArtifactReferenceQuery
import ai.okou.android.api.generated.RunActivityRequest
import ai.okou.android.api.generated.SaveThreadDraft
import ai.okou.android.api.generated.SaveWorkspaceDraft
import ai.okou.android.api.generated.SendRequest
import ai.okou.android.api.generated.SetMorningBriefPreference
import ai.okou.android.api.generated.SetProactiveSuggestionsPreference
import ai.okou.android.api.generated.SetThreadModelRequest
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.api.generated.UpdateEmailSubscriptionRequest
import ai.okou.android.api.generated.UpdateInstructionsRequest
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.WorkflowsQuery
import ai.okou.android.api.generated.artifactCatalog
import ai.okou.android.api.generated.artifactDetail
import ai.okou.android.api.generated.historyRows
import ai.okou.android.api.generated.resolveArtifactReference
import ai.okou.android.api.generated.workflows
import ai.okou.android.chat.ChatAttachmentReference
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.ServerDraftTarget
import ai.okou.android.chat.plainDraftDocument
import ai.okou.android.updates.isAndroidVersion
import java.io.Closeable
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.time.Duration
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

fun interface WorkspaceTokenProvider {
    /**
     * Resolve the current token for this client's identity/workspace; unexpired tokens may be
     * reused.
     */
    suspend fun token(): String?

    /** Resolve a replacement after the API rejected a credential for this workspace. */
    suspend fun renew(rejectedToken: String): String? = null
}

data class RequiredUpdate(val minimumSupportedVersion: String?)

internal val finiteReadRetryDelays = listOf(3_000L, 3_000L)

sealed class ApiFailure(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class Unauthenticated : ApiFailure("An authenticated workspace session is required")

    class Http(
        val status: Int,
        val code: String?,
        val serverMessage: String?,
        val retryAfterSeconds: Long?,
    ) : ApiFailure("API request failed with HTTP $status")

    class Network(cause: IOException) : ApiFailure("API transport failed", cause) {
        // The mutation transport disables connection retries and redirects. Timeouts and
        // interrupted response bodies still leave delivery uncertain.
        internal val connectionFailed =
            cause is ConnectException ||
                cause is NoRouteToHostException ||
                cause is UnknownHostException
    }

    class IncompatibleResponse(cause: Throwable? = null) :
        ApiFailure("Incompatible API response", cause)

    class UpdateRequired(val requirement: RequiredUpdate) :
        ApiFailure("An Android app update is required")
}

/** Lazy, origin-bound transport. The auth owner supplies tokens and owns replacement/teardown. */
class ApiClient(
    private val origin: HttpUrl,
    private val tokens: WorkspaceTokenProvider,
    version: String = BuildConfig.VERSION_NAME,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    callTimeout: Duration = DEFAULT_CALL_TIMEOUT,
    private val onUpdateRequired: (RequiredUpdate) -> Unit = {},
) : Closeable {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
        encodeDefaults = false
    }
    private val sessionId = UUID.randomUUID().toString()
    private val closed = AtomicBoolean(false)
    private val required = MutableStateFlow<RequiredUpdate?>(null)
    val updateRequired = required.asStateFlow()
    private val http: okhttp3.OkHttpClient
    private val writes: CanonicalApi
    private val reads: CanonicalApi

    init {
        validateTransportUrl(origin)
        require(origin.encodedPath == "/" && origin.query == null && origin.fragment == null) {
            "API URL must be an origin"
        }
        require(Regex("\\d+\\.\\d+\\.\\d+").matches(version)) {
            "Client version must be stable x.y.z"
        }
        http =
            httpClient(callTimeout)
                .addInterceptor { chain ->
                    val request = chain.request()
                    check(
                        request.url.scheme == origin.scheme &&
                            request.url.host == origin.host &&
                            request.url.port == origin.port,
                    ) {
                        "API request escaped its origin"
                    }
                    chain.proceed(
                        request
                            .newBuilder()
                            .header(ApiHeaders.TYPE_HEADER, ApiHeaders.CLIENT_TYPE)
                            .header(ApiHeaders.VERSION_HEADER, version)
                            .header(ApiHeaders.SESSION_HEADER, sessionId)
                            .header(ApiHeaders.REQUEST_HEADER, UUID.randomUUID().toString())
                            .header("Accept", "application/json")
                            .build(),
                    )
                }
                .build()
        val retrofit =
            Retrofit.Builder()
                .baseUrl(origin)
                .client(http)
                .addConverterFactory(StreamingJsonConverterFactory(json))
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
        writes = retrofit.create(CanonicalApi::class.java)
        reads =
            retrofit
                .newBuilder()
                .client(http.forCanonicalReads())
                .build()
                .create(CanonicalApi::class.java)
    }

    suspend fun organization(): Organization = read { organization(it) }

    suspend fun workflows() = read { workflows(it, WorkflowsQuery()) }

    internal suspend fun composerWorkflows() = read { composerWorkflows(it) }

    internal suspend fun recentComposerWorkflows() = read {
        recentComposerWorkflows(it)
    }
        .workflowIds
        .orEmpty()

    internal suspend fun recordComposerWorkflowUse(ids: List<String>) = write {
        recordComposerWorkflowUse(
            it,
            ai.okou.android.api.generated.RecordComposerWorkflowUseRequest(ids),
        )
    }
        .workflowIds

    suspend fun workflow(id: String) = read { workflow(it, id) }

    internal suspend fun workflowRunHistory(id: String, cursor: String?) = read {
        workflowRunHistory(it, id, cursor)
    }

    suspend fun workspaceWorkflowAutomations() = read {
        workspaceWorkflowAutomations(it)
    }

    suspend fun workflowConnections() = read {
        connectedConnectors(it)
    }
        .builtinConnectors
        .mapTo(mutableSetOf()) { it.slug }

    suspend fun updateWorkflow(id: String, body: UpdateWorkflowRequest) = write {
        updateWorkflow(it, id, body)
    }

    suspend fun createWorkflowAutomation(id: String, body: CreateWorkflowAutomationRequest) =
        write(201) { createWorkflowAutomation(it, id, body) }

    suspend fun updateWorkflowAutomation(id: String, body: UpdateWorkflowAutomationRequest) =
        write {
            updateWorkflowAutomation(it, id, body)
        }

    suspend fun setWorkflowAutomationEnabled(id: String, enabled: Boolean) = write {
        if (enabled) enableWorkflowAutomation(it, id) else disableWorkflowAutomation(it, id)
    }

    suspend fun realtimeToken() = write { realtimeToken(it, RealtimeTokenRequest) }

    suspend fun personalInstructions(): PersonalInstructions = read {
        personalInstructions(it)
    }

    suspend fun updatePersonalInstructions(body: UpdateInstructionsRequest): PersonalInstructions =
        write {
            updatePersonalInstructions(it, body)
        }

    suspend fun chatSnapshot(): ChatSnapshot = read { chatSnapshot(it) }

    suspend fun chatEvents(since: Long?): ChatEvents = read { chatEvents(it, since) }

    suspend fun indicators(): Indicators = read {
        indicators(it, queryIncludeActiveUnread = "true")
    }

    suspend fun draftThreadIds(): List<String> = read { chatDraftIndex(it) }.draftThreadIds

    suspend fun createThread(body: CreateThreadRequest) = write(201) { createThread(it, body) }

    suspend fun sendInput(body: SendRequest) = write(201) { sendInput(it, body) }

    suspend fun inputStatus(threadId: String, eventId: String) = read {
        inputStatus(it, threadId, eventId)
    }

    suspend fun onboardingStatus() = read { onboardingStatus(it) }

    suspend fun composerDraft(target: ServerDraftTarget): ComposerDraft = read {
        if (target.threadId != null) threadDraft(it, target.threadId) else workspaceDraft(it)
    }

    suspend fun saveComposerDraft(
        target: ServerDraftTarget,
        text: String,
        attachments: List<ChatAttachmentReference> = emptyList(),
    ) {
        val body = plainDraftDocument(text, attachments)
        writeNoContent {
            if (target.threadId != null)
                saveThreadDraft(
                    it,
                    target.threadId,
                    json.decodeFromJsonElement<SaveThreadDraft>(body),
                )
            else saveWorkspaceDraft(it, json.decodeFromJsonElement<SaveWorkspaceDraft>(body))
        }
    }

    internal suspend fun resolveChatUpload(id: String) = read { chatUploadedFile(it, id) }

    suspend fun recoveryCatalog() = read { recoveryCatalog(it) }

    suspend fun recoveryModels() = read { recoveryModels(it) }

    suspend fun recoverySubscriptions() = read { recoverySubscriptions(it) }

    suspend fun recoveryBilling() = read { recoveryBilling(it) }

    suspend fun usagePackCredits() = read { usagePackCredits(it) }

    suspend fun activateModelAccount(accountId: String) = write {
        activateModelAccount(it, accountId, ActivateModelAccountRequest)
    }

    suspend fun resetSubscription(accountId: String, idempotencyKey: String) = write {
        resetSubscription(
            it,
            accountId,
            ai.okou.android.api.generated.ResetSubscriptionRequest(idempotencyKey),
        )
    }

    suspend fun projectSnapshot(): ProjectSnapshot = read { projectSnapshot(it) }

    suspend fun projectEvents(since: Long): ProjectEvents = read {
        projectEvents(it, since)
    }

    suspend fun historySnapshot(threadId: String) = read {
        historySnapshot(it, threadId)
    }

    suspend fun historyCatchUp(cursors: Map<String, HistoryCursor>) = read { token ->
        historyCatchUp(
            token,
            cursors.map { (threadId, cursor) ->
                cursor.validate()
                HistoryCatchUpRequestItem(threadId, cursor.seqId)
            },
        )
    }

    suspend fun historyRows(threadId: String, cursor: HistoryCursor) = read {
        cursor.validate()
        val query =
            if (cursor.eventId == null) HistoryRowsQueryVariant1(CanonicalZero, 50.0)
            else HistoryRowsQueryVariant2(cursor.seqId, cursor.eventId, 50.0)
        historyRows(it, threadId, query)
    }

    suspend fun threadDetail(threadId: String) = read { threadDetail(it, threadId) }

    internal suspend fun summarizeRunActivity(threadId: String, runId: String) = read {
        summarizeRunActivity(it, threadId, RunActivityRequest(runId))
    }

    internal suspend fun relatedCreatedChats(threadId: String) = read {
        relatedCreatedChats(it, threadId)
    }

    internal suspend fun relatedCommunicatingChats(threadId: String) = read {
        relatedCommunicatingChats(it, threadId)
    }

    internal suspend fun artifactCatalog(query: ArtifactCatalogQuery) = read {
        artifactCatalog(it, query)
    }

    internal suspend fun artifactDetail(id: String) = read {
        artifactDetail(it, id, ArtifactDetailQuery())
    }

    internal suspend fun resolveArtifactReference(reference: String) = read {
        resolveArtifactReference(it, reference, ResolveArtifactReferenceQuery())
    }

    internal suspend fun artifactDownload(reference: String) = read {
        artifactDownload(it, reference)
    }

    internal suspend fun artifactSitePreview(slug: String, host: String) = read {
        artifactSitePreview(it, slug, host)
    }

    suspend fun searchChatMessages(keyword: String) = read {
        searchChatMessages(it, keyword)
    }

    suspend fun markRead(threadId: String) = write { markRead(it, threadId) }

    suspend fun markUnread(threadId: String) = write { markUnread(it, threadId) }

    suspend fun setMuted(threadId: String, muted: Boolean, eventId: String) {
        writeNoContent {
            if (muted) muteThread(it, threadId, eventId) else unmuteThread(it, threadId, eventId)
        }
    }

    suspend fun setArchived(threadId: String, archived: Boolean, eventId: String) {
        writeNoContent {
            if (archived) archiveThread(it, threadId, eventId)
            else unarchiveThread(it, threadId, eventId)
        }
    }

    suspend fun deleteThread(threadId: String, eventId: String) {
        writeNoContent { deleteThread(it, threadId, eventId) }
    }

    internal suspend fun createProject(projectId: String, name: String) =
        write(201) {
            createProject(
                it,
                CreateProjectRequest(id = projectId, eventId = projectId, name = name),
            )
        }

    internal suspend fun projectDetail(projectId: String) = read { projectDetail(it, projectId) }

    suspend fun renameProject(projectId: String, name: String, eventId: String) = write {
        renameProject(it, projectId, RenameProjectRequest(eventId = eventId, name = name))
    }

    suspend fun moveThreadToProject(threadId: String, projectId: String?, eventId: String) {
        val membership = write {
            moveThreadToProject(it, threadId, MoveThreadToProjectRequest(eventId, projectId))
        }
        if (membership.threadId != threadId || membership.projectId != projectId)
            throw ApiFailure.IncompatibleResponse()
    }

    suspend fun deleteProject(projectId: String, eventId: String) {
        writeNoContent { deleteProject(it, projectId, DeleteProjectRequest(eventId)) }
    }

    suspend fun renameThread(threadId: String, title: String, eventId: String) {
        writeNoContent { renameThread(it, threadId, RenameThreadRequest(title, eventId)) }
    }

    suspend fun setThreadModel(threadId: String, request: SetThreadModelRequest) {
        writeNoContent { setThreadModel(it, threadId, request) }
    }

    suspend fun setPinned(threadId: String, pinOrder: String?, eventId: String) {
        writeNoContent {
            if (pinOrder != null) pinThread(it, threadId, eventId, pinOrder)
            else unpinThread(it, threadId, eventId)
        }
    }

    suspend fun reorderPinnedThread(threadId: String, pinOrder: String, eventId: String) {
        writeNoContent {
            reorderPinnedThread(it, threadId, ReorderPinnedThreadRequest(pinOrder, eventId))
        }
    }

    suspend fun preferences(): UserPreferences = read { preferences(it) }

    suspend fun defaultModelPreference() = read { defaultModelPreference(it) }

    suspend fun updateDefaultModelPreference(update: UpdateDefaultModelPreference) = write {
        updateDefaultModelPreference(it, update)
    }

    suspend fun emailSubscription() = read { emailSubscription(it) }

    suspend fun updateEmailSubscription(subscribed: Boolean) = write {
        updateEmailSubscription(it, UpdateEmailSubscriptionRequest(subscribed))
    }

    suspend fun featureSwitches() = read { featureSwitches(it) }

    internal suspend fun morningBriefPreference() = read { morningBriefPreference(it) }

    internal suspend fun setMorningBriefPreference(enabled: Boolean) = write {
        updateMorningBriefPreference(it, SetMorningBriefPreference(enabled))
    }

    internal suspend fun proactiveSuggestionsPreference() = read {
        proactiveSuggestionsPreference(it)
    }

    internal suspend fun setProactiveSuggestionsWithFeed(enabled: Boolean) = write {
        updateProactiveSuggestionsWithFeed(it, SetProactiveSuggestionsPreference(enabled))
    }

    internal suspend fun suggestionFeedSources() = read { suggestionFeedSources(it) }

    suspend fun initializePreferences(body: InitializePreferencesRequest): UserPreferences = write {
        initializePreferences(it, body)
    }

    suspend fun updatePreferences(body: UpdatePreferencesRequest): UserPreferences = write {
        updatePreferences(it, body)
    }

    private fun checkAccess() {
        check(!closed.get()) { "API owner has closed" }
        required.value?.let { throw ApiFailure.UpdateRequired(it) }
    }

    internal suspend fun <T> read(request: suspend CanonicalApi.(String) -> Response<T>): T =
        send(200, renewOnUnauthorized = true) { reads.request(it) }.body()
            ?: throw ApiFailure.IncompatibleResponse()

    internal suspend fun <T> write(request: suspend CanonicalApi.(String) -> Response<T>): T =
        write(200, request)

    private suspend fun <T> write(
        success: Int,
        request: suspend CanonicalApi.(String) -> Response<T>,
    ): T =
        send(success, renewOnUnauthorized = false) { writes.request(it) }.body()
            ?: throw ApiFailure.IncompatibleResponse()

    private suspend fun writeNoContent(request: suspend CanonicalApi.(String) -> Response<Unit>) {
        send(204, renewOnUnauthorized = false) { writes.request(it) }
    }

    private suspend fun <T> send(
        success: Int,
        renewOnUnauthorized: Boolean,
        request: suspend (String) -> Response<T>,
    ): Response<T> =
        withContext(dispatcher) {
            checkAccess()
            val token =
                tokens.token()?.takeIf { it.isNotBlank() } ?: throw ApiFailure.Unauthenticated()
            currentCoroutineContext().ensureActive()
            checkAccess()
            val response =
                try {
                    requestWithToken(token, request)
                } catch (error: ApiFailure.Http) {
                    if (!renewOnUnauthorized || error.status != 401) throw error
                    checkAccess()
                    val replacement =
                        try {
                            tokens.renew(token)
                        } catch (_: ApiFailure.Unauthenticated) {
                            // A rejected credential alone does not establish membership loss.
                            throw error
                        }
                    if (replacement.isNullOrBlank() || replacement == token) throw error
                    currentCoroutineContext().ensureActive()
                    checkAccess()
                    requestWithToken(replacement, request)
                }
            currentCoroutineContext().ensureActive()
            checkAccess()
            if (response.code() != success) throw ApiFailure.IncompatibleResponse()
            response
        }

    private suspend fun <T> requestWithToken(
        token: String,
        request: suspend (String) -> Response<T>,
    ): Response<T> =
        try {
            request("Bearer $token")
        } catch (_: SerializationException) {
            // Serializer diagnostics can contain response values or input snippets.
            throw ApiFailure.IncompatibleResponse()
        } catch (error: IOException) {
            currentCoroutineContext().ensureActive()
            error.httpRejection()?.let { reject(it) }
            throw ApiFailure.Network(error)
        }

    private fun reject(error: HttpRejection): Nothing {
        if (error.status == 426) {
            val envelope = errorEnvelope<AndroidUpgradeRequired>(error.envelope)
            val minimum = envelope?.minimumSupportedVersion?.takeIf(::isAndroidVersion)
            required.compareAndSet(null, RequiredUpdate(minimum))
            // In-flight responses can report a stronger floor during an API rollout.
            onUpdateRequired(RequiredUpdate(minimum))
            throw ApiFailure.UpdateRequired(checkNotNull(required.value))
        }
        val envelope = errorEnvelope<ApiError>(error.envelope)
        throw ApiFailure.Http(
            error.status,
            envelope?.error?.code,
            envelope?.error?.message,
            retryAfter(error.retryAfter),
        )
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) http.closeTransport()
    }

    private inline fun <reified T> errorEnvelope(value: String?): T? {
        if (value == null) return null
        return try {
            json.decodeFromString<T>(value)
        } catch (_: SerializationException) {
            null
        }
    }
}
