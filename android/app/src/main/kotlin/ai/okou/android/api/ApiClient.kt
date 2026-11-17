package ai.okou.android.api

import ai.okou.android.BuildConfig
import ai.okou.android.api.generated.Agents
import ai.okou.android.api.generated.AndroidUpgradeRequired
import ai.okou.android.api.generated.ApiError
import ai.okou.android.api.generated.ApiHeaders
import ai.okou.android.api.generated.CanonicalApi
import ai.okou.android.api.generated.CanonicalZero
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ChatSnapshot
import ai.okou.android.api.generated.CreateThreadRequest
import ai.okou.android.api.generated.FeatureSwitches
import ai.okou.android.api.generated.HistoryCatchUpRequestItem
import ai.okou.android.api.generated.HistoryRowsQueryVariant1
import ai.okou.android.api.generated.HistoryRowsQueryVariant2
import ai.okou.android.api.generated.Indicators
import ai.okou.android.api.generated.InitializePreferencesRequest
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.api.generated.ProjectEvents
import ai.okou.android.api.generated.ProjectSnapshot
import ai.okou.android.api.generated.RealtimeTokenRequest
import ai.okou.android.api.generated.SendRequest
import ai.okou.android.api.generated.UpdateInstructionsRequest
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.historyRows
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.updates.isAndroidVersion
import java.io.Closeable
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
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
}

data class RequiredUpdate(val minimumSupportedVersion: String?)

sealed class ApiFailure(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class Unauthenticated : ApiFailure("An authenticated workspace session is required")

    class Http(
        val status: Int,
        val code: String?,
        val serverMessage: String?,
        val retryAfterSeconds: Long?,
    ) : ApiFailure("API request failed with HTTP $status")

    class Network(cause: IOException) : ApiFailure("API transport failed", cause)

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
    private val api: CanonicalApi
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
                            request.url.port == origin.port
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
                            .build()
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
        api = retrofit.create(CanonicalApi::class.java)
        reads =
            retrofit
                .newBuilder()
                .client(http.forCanonicalReads())
                .build()
                .create(CanonicalApi::class.java)
    }

    suspend fun organization(): Organization = execute { reads.organization(it) }

    suspend fun realtimeToken() = execute { api.realtimeToken(it, RealtimeTokenRequest) }

    suspend fun personalInstructions(): PersonalInstructions = execute {
        reads.personalInstructions(it)
    }

    suspend fun updatePersonalInstructions(body: UpdateInstructionsRequest): PersonalInstructions =
        execute {
            api.updatePersonalInstructions(it, body)
        }

    suspend fun chatSnapshot(): ChatSnapshot = execute { reads.chatSnapshot(it) }

    suspend fun chatEvents(since: Long?): ChatEvents = execute { reads.chatEvents(it, since) }

    suspend fun indicators(): Indicators = execute { reads.indicators(it) }

    suspend fun agents(): Agents = execute { reads.agents(it) }

    suspend fun createThread(body: CreateThreadRequest) =
        execute(201) { api.createThread(it, body) }

    suspend fun sendInput(body: SendRequest) = execute(201) { api.sendInput(it, body) }

    suspend fun inputStatus(threadId: String, eventId: String) = execute {
        reads.inputStatus(it, threadId, eventId)
    }

    suspend fun onboardingStatus() = execute { reads.onboardingStatus(it) }

    suspend fun recoveryCatalog() = execute { reads.recoveryCatalog(it) }

    suspend fun recoveryModels() = execute { reads.recoveryModels(it) }

    suspend fun recoverySubscriptions() = execute { reads.recoverySubscriptions(it) }

    suspend fun recoveryBilling() = execute { reads.recoveryBilling(it) }

    suspend fun resetSubscription(accountId: String, idempotencyKey: String) = execute {
        api.resetSubscription(
            it,
            accountId,
            ai.okou.android.api.generated.ResetSubscriptionRequest(idempotencyKey),
        )
    }

    suspend fun projectSnapshot(): ProjectSnapshot = execute { reads.projectSnapshot(it) }

    suspend fun projectEvents(since: Long): ProjectEvents = execute {
        reads.projectEvents(it, since)
    }

    suspend fun featureSwitches(): FeatureSwitches = execute { reads.featureSwitches(it) }

    suspend fun historySnapshot(threadId: String) = execute { reads.historySnapshot(it, threadId) }

    suspend fun historyCatchUp(cursors: Map<String, HistoryCursor>) = execute { token ->
        reads.historyCatchUp(
            token,
            cursors.map { (threadId, cursor) ->
                cursor.validate()
                HistoryCatchUpRequestItem(threadId, cursor.seqId)
            },
        )
    }

    suspend fun historyRows(threadId: String, cursor: HistoryCursor) = execute {
        cursor.validate()
        val query =
            if (cursor.eventId == null) HistoryRowsQueryVariant1(CanonicalZero, 50.0)
            else HistoryRowsQueryVariant2(cursor.seqId, cursor.eventId, 50.0)
        reads.historyRows(it, threadId, query)
    }

    suspend fun threadDetail(threadId: String) = execute { reads.threadDetail(it, threadId) }

    suspend fun markRead(threadId: String) = execute { api.markRead(it, threadId) }

    suspend fun preferences(): UserPreferences = execute { reads.preferences(it) }

    suspend fun initializePreferences(body: InitializePreferencesRequest): UserPreferences =
        execute {
            api.initializePreferences(it, body)
        }

    suspend fun updatePreferences(body: UpdatePreferencesRequest): UserPreferences = execute {
        api.updatePreferences(it, body)
    }

    private fun checkAccess() {
        check(!closed.get()) { "API owner has closed" }
        required.value?.let { throw ApiFailure.UpdateRequired(it) }
    }

    private suspend fun <T> execute(
        success: Int = 200,
        request: suspend (String) -> Response<T>,
    ): T =
        withContext(dispatcher) {
            checkAccess()
            val token =
                tokens.token()?.takeIf { it.isNotBlank() } ?: throw ApiFailure.Unauthenticated()
            currentCoroutineContext().ensureActive()
            checkAccess()
            try {
                val response = request("Bearer $token")
                currentCoroutineContext().ensureActive()
                checkAccess()
                if (response.code() != success) throw ApiFailure.IncompatibleResponse()
                response.body() ?: throw ApiFailure.IncompatibleResponse()
            } catch (_: SerializationException) {
                // Serializer diagnostics can contain response values or input snippets.
                throw ApiFailure.IncompatibleResponse()
            } catch (error: IOException) {
                currentCoroutineContext().ensureActive()
                error.httpRejection()?.let { reject(it) }
                throw ApiFailure.Network(error)
            }
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

private fun retryAfter(value: String?): Long? {
    if (value == null) return null
    value.toLongOrNull()?.let {
        return it.coerceAtLeast(0)
    }
    val formatter = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US)
    formatter.timeZone = TimeZone.getTimeZone("GMT")
    formatter.isLenient = false
    return try {
        ((formatter.parse(value)?.time ?: return null) - System.currentTimeMillis()).coerceAtLeast(
            0
        ) / 1000
    } catch (_: java.text.ParseException) {
        null
    }
}
