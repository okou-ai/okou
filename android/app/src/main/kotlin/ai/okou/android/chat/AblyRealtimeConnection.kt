package ai.okou.android.chat

import io.ably.pubsub.device.PubSubDevice
import io.ably.pubsub.http.Auth
import io.ably.pubsub.realtime.ChannelState
import io.ably.pubsub.realtime.ConnectionState
import io.ably.pubsub.types.AblyException
import io.ably.pubsub.util.Log
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking

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
    userId: String,
    workspaceId: String,
    context: CoroutineContext,
    token: suspend () -> String,
) : Closeable {
    private val mutable = MutableStateFlow(RealtimeSnapshot())
    val state = mutable.asStateFlow()
    private val closed = AtomicBoolean(false)
    private val lock = Any()
    private var connection = RealtimePhase.Connecting
    private val attachments =
        linkedMapOf(
            "user:$userId" to RealtimePhase.Connecting,
            "user-org:$userId:$workspaceId" to RealtimePhase.Connecting,
        )
    private val tokens =
        RealtimeTokenBridge(context, token) { error ->
            mutable.update { it.copy(phase = RealtimePhase.Unavailable, failure = error) }
        }
    private val client =
        try {
            PubSubDevice.clientBuilder()
                .clientId(userId)
                .autoConnect(false)
                .authCallback(tokens)
                .logLevel(Log.NONE)
                .build()
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
                    if (!closed.get() && isChatInvalidation(message.name))
                        mutable.update { it.copy(revision = it.revision + 1) }
                }
            }
            client.connect()
        } catch (error: Exception) {
            close()
            throw error
        }
    }

    private fun publish(invalidate: Boolean) {
        if (closed.get()) return
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
