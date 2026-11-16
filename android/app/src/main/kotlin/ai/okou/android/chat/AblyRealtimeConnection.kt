package ai.okou.android.chat

import ai.okou.android.api.generated.SessionOutputDelta
import com.google.gson.JsonObject
import io.ably.pubsub.device.PubSubDevice
import io.ably.pubsub.http.Auth
import io.ably.pubsub.realtime.ChannelBase
import io.ably.pubsub.realtime.ChannelState
import io.ably.pubsub.realtime.ChannelStateListener
import io.ably.pubsub.realtime.CompletionListener
import io.ably.pubsub.realtime.ConnectionState
import io.ably.pubsub.realtime.PubSubRealtimeClient
import io.ably.pubsub.types.AblyException
import io.ably.pubsub.types.ErrorInfo
import io.ably.pubsub.util.Log
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json

private val outputJson = Json { ignoreUnknownKeys = true }
private val outputUuid =
    Regex(
        "(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)",
        RegexOption.IGNORE_CASE,
    )
private val outputTime =
    Regex("\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?Z")

/** Generated wire type; validate refinements that Kotlin serialization cannot represent. */
internal fun decodeRunOutput(data: Any?): SessionOutputDelta {
    val text =
        when (data) {
            is String -> data
            is JsonObject -> data.toString()
            else -> throw IllegalArgumentException("Expected session output JSON")
        }
    val value = outputJson.decodeFromString<SessionOutputDelta>(text)
    require(listOf(value.threadId, value.runId, value.eventId).all(outputUuid::matches))
    require(value.runEventId.isNotEmpty() && value.chunkIndex in 0..9_007_199_254_740_991L)
    require(outputTime.matches(value.createdAt))
    val year = value.createdAt.substring(0, 4).toInt()
    val month = value.createdAt.substring(5, 7).toInt()
    val day = value.createdAt.substring(8, 10).toInt()
    val days =
        when (month) {
            1,
            3,
            5,
            7,
            8,
            10,
            12 -> 31
            4,
            6,
            9,
            11 -> 30
            2 -> if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28
            else -> 0
        }
    require(day in 1..days)
    return value
}

/** Ably's callback is synchronous and runs on its authentication worker, never on Main. */
internal class RealtimeTokenBridge(
    parent: CoroutineContext,
    private val token: suspend () -> String,
    private val failed: (Exception) -> Unit,
) : Auth.TokenCallback, Closeable {
    private val job = SupervisorJob(parent[Job])

    override fun getTokenRequest(params: Auth.TokenParams?): Any =
        try {
            runBlocking(job + Dispatchers.IO) {
                ensureActive()
                Auth.TokenRequest.fromJson(token())
            }
        } catch (cancelled: CancellationException) {
            throw AblyException.fromThrowable(cancelled)
        } catch (error: Exception) {
            failed(error)
            // This observation fails as one owned operation; only an explicit retry starts another.
            close()
            throw AblyException.fromThrowable(error)
        }

    override fun close() {
        job.cancel()
    }
}

/** Construct, observe and close on the workspace observation's IO coroutine. */
internal class AblyRealtimeConnection(
    private val userId: String,
    private val workspaceId: String,
    context: CoroutineContext,
    clientFactory: (String, Auth.TokenCallback) -> PubSubRealtimeClient = { id, auth ->
        PubSubDevice.clientBuilder()
            .clientId(id)
            .autoConnect(false)
            .authCallback(auth)
            .logLevel(Log.NONE)
            .build()
    },
    token: suspend () -> String,
) : Closeable {
    private val mutable = MutableStateFlow(RealtimeSnapshot())
    val state = mutable.asStateFlow()
    private val closed = AtomicBoolean(false)
    private val lock = Any()
    private var pending = ChatChanges()
    private var connection = RealtimePhase.Connecting
    private val attachments =
        linkedMapOf(
            "user:$userId" to RealtimePhase.Connecting,
            "user-org:$userId:$workspaceId" to RealtimePhase.Connecting,
        )
    private val tokens =
        RealtimeTokenBridge(context, token) { error ->
            synchronized(lock) {
                mutable.update { it.copy(phase = RealtimePhase.Unavailable, failure = error) }
            }
        }
    private val client =
        try {
            clientFactory(userId, tokens)
        } catch (error: Exception) {
            tokens.close()
            throw error
        }

    init {
        try {
            client.connection.on { change ->
                synchronized(lock) {
                    connection =
                        when (change.current) {
                            ConnectionState.connected -> RealtimePhase.Connected
                            ConnectionState.initialized,
                            ConnectionState.connecting -> RealtimePhase.Connecting
                            else -> RealtimePhase.Unavailable
                        }
                    publish(
                        change.current == ConnectionState.connected &&
                            change.previous != ConnectionState.connected
                    )
                }
            }
            attachments.keys.forEach { name ->
                val channel = client.channels.get(name)
                channel.on { change ->
                    synchronized(lock) {
                        attachments[name] =
                            when (change.current) {
                                ChannelState.attached -> RealtimePhase.Connected
                                ChannelState.initialized,
                                ChannelState.attaching -> RealtimePhase.Connecting
                                else -> RealtimePhase.Unavailable
                            }
                        publish(change.current == ChannelState.attached && !change.resumed)
                    }
                }
                channel.subscribe { message ->
                    val changes = chatChanges(message.name) ?: return@subscribe
                    synchronized(lock) {
                        if (!closed.get()) {
                            pending += changes
                            mutable.update { it.copy(revision = it.revision + 1) }
                        }
                    }
                }
            }
            client.connect()
        } catch (error: Exception) {
            close()
            throw error
        }
    }

    /** The sole observer drains every topic accumulated behind a conflated StateFlow wake-up. */
    fun takeObservation(): RealtimeSnapshot =
        synchronized(lock) {
            mutable.value.copy(changes = pending).also { pending = ChatChanges() }
        }

    private fun publish(invalidate: Boolean) {
        if (closed.get()) return
        if (invalidate) pending += ChatChanges(resync = true)
        val phase =
            when {
                connection == RealtimePhase.Unavailable ||
                    attachments.values.any { it == RealtimePhase.Unavailable } ->
                    RealtimePhase.Unavailable
                connection == RealtimePhase.Connected &&
                    attachments.values.all { it == RealtimePhase.Connected } ->
                    RealtimePhase.Connected
                else -> RealtimePhase.Connecting
            }
        mutable.update {
            it.copy(
                phase = phase,
                revision = it.revision + if (invalidate) 1 else 0,
                // StateFlow is conflated. A later SDK callback cannot erase a canonical API
                // failure.
                failure = it.failure,
            )
        }
    }

    /** Lossless bounded handoff, separate from conflated connection snapshots. */
    fun runOutput(target: RunOutputTarget): Flow<RunOutputSignal> =
        callbackFlow {
                check(!closed.get())
                val name = "run-output:$userId:$workspaceId:${target.runId}"
                val channel = client.channels.get(name)
                var attached = false
                fun offer(value: RunOutputSignal) {
                    if (trySend(value).isFailure)
                        close(IllegalStateException("Output consumer fell behind"))
                }
                val states = ChannelStateListener { change ->
                    if (change.current == ChannelState.attached) {
                        if (attached && !change.resumed) offer(RunOutputSignal.Discontinuity)
                        attached = true
                    } else if (
                        change.current !in setOf(ChannelState.initialized, ChannelState.attaching)
                    ) {
                        offer(RunOutputSignal.Discontinuity)
                    }
                }
                val messages =
                    ChannelBase.MessageListener { message ->
                        val signal =
                            try {
                                RunOutputSignal.Delta(decodeRunOutput(message.data))
                            } catch (_: Exception) {
                                RunOutputSignal.Discontinuity
                            }
                        offer(signal)
                    }
                try {
                    channel.on(states)
                    channel.subscribe(target.runId, messages)
                    awaitClose()
                } finally {
                    channel.unsubscribe(target.runId, messages)
                    channel.off(states)
                    // Wait for DETACHED before release: the SDK rejects release while detaching.
                    // Bound offline cleanup so a backgrounded workspace can still close its client.
                    withContext(NonCancellable) {
                        val detached =
                            withTimeoutOrNull(5_000) {
                                suspendCancellableCoroutine { continuation ->
                                    channel.detach(
                                        object : CompletionListener {
                                            override fun onSuccess() {
                                                if (continuation.isActive) continuation.resume(true)
                                            }

                                            override fun onError(reason: ErrorInfo?) {
                                                if (continuation.isActive)
                                                    continuation.resume(false)
                                            }
                                        }
                                    )
                                }
                            }
                        if (
                            detached == true ||
                                channel.state in
                                    setOf(
                                        ChannelState.initialized,
                                        ChannelState.detached,
                                        ChannelState.failed,
                                    )
                        )
                            client.channels.release(name)
                        // On timeout the observation's SDK retains the channel until its own close;
                        // late completion callbacks cannot release a replacement subscription.
                    }
                }
            }
            .buffer(64)
            .catch { error ->
                if (error is CancellationException) throw error
                emit(RunOutputSignal.Discontinuity)
            }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        tokens.close()
        try {
            client.connection.off()
            attachments.keys.forEach { name ->
                client.channels.get(name).apply {
                    unsubscribe()
                    off()
                }
            }
        } finally {
            client.close()
        }
    }
}
