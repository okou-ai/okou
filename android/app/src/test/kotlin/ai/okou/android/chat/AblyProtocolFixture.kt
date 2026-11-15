package ai.okou.android.chat

import io.ably.pubsub.device.PubSubDevice
import io.ably.pubsub.http.Auth
import io.ably.pubsub.util.Log
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString

/** Only the external Ably wire service is replaced; the pinned Android SDK and adapter are real. */
internal class AblyProtocolFixture : Closeable {
    private val server = MockWebServer()
    private val socket = CompletableDeferred<WebSocket>()
    @Volatile private var activeSocket: WebSocket? = null
    val closed = CompletableDeferred<Unit>()
    val attachments = Channel<String>(2)
    val authorizations = Channel<String>(1)
    val nonces = CopyOnWriteArrayList<String>()
    private val listener =
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                activeSocket = webSocket
                socket.complete(webSocket)
                connected(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = Json.parseToJsonElement(text).jsonObject
                when (frame.getValue("action").jsonPrimitive.int) {
                    10 ->
                        check(
                            attachments
                                .trySend(frame.getValue("channel").jsonPrimitive.content)
                                .isSuccess
                        )
                    12 -> webSocket.send("""{"action":13,"channel":${frame.getValue("channel")}}""")
                    17 -> {
                        check(
                            authorizations
                                .trySend(
                                    frame
                                        .getValue("auth")
                                        .jsonObject
                                        .getValue("accessToken")
                                        .jsonPrimitive
                                        .content
                                )
                                .isSuccess
                        )
                        connected(webSocket)
                    }
                    7 -> {
                        webSocket.send("""{"action":8}""")
                        webSocket.close(1000, "Closed")
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // This SDK sends UTF-8 JSON in binary WebSocket frames when format=json.
                onMessage(webSocket, bytes.utf8())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                closed.complete(Unit)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                socket.completeExceptionally(t)
                closed.completeExceptionally(t)
                attachments.close(t)
                authorizations.close(t)
            }
        }

    init {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    when {
                        request.getHeader("Upgrade").equals("websocket", ignoreCase = true) ->
                            MockResponse().withWebSocketUpgrade(listener)
                        request.path == "/keys/app.key/requestToken" -> {
                            val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                            nonces += body.getValue("nonce").jsonPrimitive.content
                            val now = System.currentTimeMillis()
                            MockResponse()
                                .setHeader("Content-Type", "application/json")
                                .setBody(
                                    """{"token":"sdk-token-${nonces.size}","issued":$now,"expires":${now + 3600000},"clientId":"user-a","capability":"{}"}"""
                                )
                        }
                        else -> MockResponse().setResponseCode(404)
                    }
            }
        server.start()
    }

    fun client(userId: String, auth: Auth.TokenCallback) =
        PubSubDevice.clientBuilder()
            .clientId(userId)
            .autoConnect(false)
            .authCallback(auth)
            .endpoint(server.hostName)
            .tls(false)
            .port(server.port)
            .fallbackHosts(emptyArray())
            .useBinaryProtocol(false)
            .logLevel(Log.NONE)
            .build()

    fun signedRequest(): String =
        """{"keyName":"app.key","timestamp":${System.currentTimeMillis()},"ttl":3600000,"capability":"{}","clientId":"user-a","nonce":"${UUID.randomUUID()}","mac":"signed"}"""

    private fun connected(webSocket: WebSocket) {
        check(
            webSocket.send(
                """{"action":4,"connectionId":"local-connection","connectionDetails":{"clientId":"user-a","connectionKey":"local-key","connectionStateTtl":120000,"maxIdleInterval":120000}}"""
            )
        )
    }

    suspend fun attach(channel: String) =
        send("""{"action":11,"channel":${JsonPrimitive(channel)}}""")

    suspend fun message(channel: String, name: String) =
        send(
            """{"action":15,"channel":${JsonPrimitive(channel)},"messages":[{"name":${JsonPrimitive(name)},"data":"{\"content\":\"not-confirmed-history\"}","encoding":"json"}]}"""
        )

    suspend fun renew() = send("""{"action":17}""")

    suspend fun fail(channel: String) =
        send(
            """{"action":9,"channel":${JsonPrimitive(channel)},"error":{"code":40160,"statusCode":401,"message":"Channel unavailable"}}"""
        )

    private suspend fun send(frame: String) {
        check(socket.await().send(frame))
    }

    override fun close() {
        activeSocket?.close(1000, "Fixture closed")
        server.close()
        attachments.close()
        authorizations.close()
    }
}
