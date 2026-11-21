package ai.okou.android

import ai.okou.android.chat.HistoryEvent
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest

/** Real canonical HTTPS codecs with controllable provider outcomes. No business owner is mocked. */
class RecoveryApiFixture(api: ChatListApiFixture) {
    val rows = AtomicReference<List<HistoryEvent>>(emptyList())
    val inputs = CopyOnWriteArrayList<JsonObject>()
    val resets = CopyOnWriteArrayList<Pair<String, JsonObject>>()
    @Volatile var account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    @Volatile var credits = 2
    @Volatile var provider = "codex-oauth-token"
    @Volatile var model: String? = "gpt-recovery"
    @Volatile var readStatus = 200
    @Volatile var reset: (JsonObject) -> MockResponse = { jsonResponse("""{"outcome":"reset"}""") }
    @Volatile
    var send: (JsonObject) -> MockResponse = {
        jsonResponse("""{"threadId":"$CHAT_PERSONAL","createdAt":"$CHAT_DATE"}""")
            .setResponseCode(201)
    }

    fun set(vararg values: String) {
        rows.set(values.map(HistoryEvent::decode))
    }

    init {
        val previous = api.commandResponse
        api.commandResponse = { request ->
            val path = request.requestUrl?.encodedPath.orEmpty()
            when {
                path == "/api/model-catalog" -> read(catalog)
                path == "/api/billing/status" -> read(billing)
                path == "/api/run-models" ->
                    read(
                        """{"models":[{"model":${model?.let { JsonPrimitive(it) } ?: JsonNull},"modelLabel":"Recovery model","modelProviderId":null,"memberEffective":{"providerType":"$provider","runtimeProviderType":null,"credentialScope":"member","availability":"available","accountSelection":"not_applicable"}}]}"""
                    )
                path == "/api/me/3rd-party-subscriptions" ->
                    read(
                        """{"subscriptions":[{"id":"$account","type":"codex-oauth-token","framework":"codex","isActive":true,"createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","accountEmail":"fixture@example.test","subscriptionResetCredits":$credits,"subscriptionUsage":{"fiveHour":{"usedPercent":100,"remainingPercent":0,"resetAt":"2026-11-18T00:00:00.000Z","windowSeconds":18000},"weekly":null},"needsReconnect":false,"lastRefreshErrorCode":null}]}"""
                    )
                path.endsWith("/subscription-reset") -> {
                    val body = request.bodyObject()
                    resets += request.requestUrl!!.pathSegments[3] to body
                    reset(body)
                }
                path == "/api/chat/events" && request.method == "POST" -> {
                    val body = request.bodyObject()
                    inputs += body
                    send(body)
                }
                path.contains("/inputs/") && path.endsWith("/status") -> {
                    val id = request.requestUrl!!.pathSegments[4]
                    jsonResponse(
                        """{"threadId":"$CHAT_PERSONAL","eventId":"$id","input":null,"replacement":null,"status":"unavailable","runId":null,"terminal":null}"""
                    )
                }
                else -> previous(request)
            }
        }
        api.historyRows = { request ->
            val url = request.requestUrl!!
            val since = url.queryParameter("sinceSeqId")!!.toLong()
            val selected = rows.get().filter { it.threadId == url.pathSegments[2] }
            val tail = selected.filter { it.seqId > since }
            val last = selected.lastOrNull()
            val rawRows = tail.joinToString(",", "[", "]") { it.archiveJson() }
            jsonResponse(
                """{"rows":$rawRows,"cursor":{"lastEventId":${last?.let { JsonPrimitive(it.id) } ?: JsonNull},"lastSeqId":${last?.seqId ?: 0}},"hasMore":false}"""
            )
        }
        api.historyCatchUp = { request ->
            val history = rows.get()
            val cursors = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonArray
            val events =
                cursors.associate { cursor ->
                    val (id, sequence) = cursor.jsonArray
                    val thread = id.jsonPrimitive.content
                    val after = sequence.jsonPrimitive.long
                    thread to
                        JsonArray(
                            history
                                .filter { it.threadId == thread && it.seqId > after }
                                .map { Json.parseToJsonElement(it.archiveJson()) }
                        )
                }
            jsonResponse(
                JsonObject(
                        mapOf(
                            "events" to JsonObject(events),
                            "notFoundThreads" to JsonArray(emptyList()),
                        )
                    )
                    .toString()
            )
        }
    }

    private fun read(body: String) =
        if (readStatus == 200) jsonResponse(body)
        else
            jsonResponse("""{"error":{"code":"UNAVAILABLE","message":"Unavailable"}}""")
                .setResponseCode(readStatus)

    private fun RecordedRequest.bodyObject() =
        Json.parseToJsonElement(body.clone().readUtf8()).jsonObject

    companion object {
        const val FAILURE = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        val catalog =
            """{"models":[{"model":"gpt-recovery","displayName":"Recovery model","sortOrder":1,"replacedBy":null,"resolvedModel":"gpt-recovery","builtInOnRestrictedPlans":false,"piRouteClass":null}],"routes":[],"systemDefaultModel":"gpt-recovery"}"""
        val billing =
            """{"tier":"free","status":"active","canBuyConcurrency":false,"concurrencyPurchaseReviewAvailable":false,"canBuyCredits":false,"showUsagePack":false,"autoRechargeAllowed":false,"restrictedBuiltInModels":true,"workflowWebhookAutomationAllowed":false,"credits":0,"onboardingPaymentPending":false,"subscriptionStatus":null,"currentPeriodEnd":null,"cancelAtPeriodEnd":false,"scheduledChange":null,"canRestorePlan":false,"hasSubscription":false,"autoRecharge":{"enabled":false,"threshold":null,"amount":null},"creditExpiry":{"expiringNextCycle":0,"nextExpiryDate":null},"creditBreakdown":[],"creditGrants":[],"concurrencyLimit":1,"concurrencySubscriptions":[]}"""

        fun input(seq: Long = 1, revoke: String? = null, run: String = HISTORY_RUN) =
            historyEventWire(
                UUID.randomUUID().toString(),
                seq,
                type = "input.prompt",
                payload =
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Original input"}]}}""",
                revoke = revoke,
                run = run,
            )

        fun failure(
            reason: String = "usage_limit",
            seq: Long = 2,
            id: String = FAILURE,
            run: String = HISTORY_RUN,
        ): String {
            val row =
                Json.parseToJsonElement(
                        historyEventWire(
                            id,
                            seq,
                            type = "run.failed",
                            payload = """{"error":"Provider diagnostic"}""",
                            run = run,
                        )
                    )
                    .jsonObject
            return JsonObject(row + ("failureReason" to JsonPrimitive(reason))).toString()
        }
    }
}
