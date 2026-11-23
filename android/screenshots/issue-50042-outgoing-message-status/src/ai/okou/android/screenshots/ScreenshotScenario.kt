package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.view.WindowInsets
import android.view.accessibility.AccessibilityNodeInfo
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureOutgoingDelivery() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val oldJournal = app.journalStore
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size = displayOverride("size")
        val density = displayOverride("density")
        val directory =
            Files.createTempDirectory(app.cacheDir.toPath(), "capture-outgoing-").toFile()
        val journal = ComposerJournalStore(app, directory)
        val sendResponse = CountDownLatch(1)
        val checkReceived = CountDownLatch(1)
        val checkResponse = CountDownLatch(1)
        val canonical = AtomicBoolean(false)
        val delivered = AtomicBoolean(false)
        val jobs = mutableListOf<Job>()
        val failures = mutableListOf<Throwable>()
        val target = ComposerTarget(CHAT_PERSONAL)
        val prompt = "Please also add the launch checklist."
        val opening = "Summarize the launch plan."
        val activeReply = "I’m reviewing the launch notes and pulling out the remaining decisions."
        val followupReply = "I’ve added the checklist to the launch plan."
        val oldInput = UUID.randomUUID().toString()
        val oldReply = UUID.randomUUID().toString()
        val oldUsage = UUID.randomUUID().toString()
        val terminal = UUID.randomUUID().toString()
        val deliveredInput = UUID.randomUUID().toString()
        val deliveredReply = UUID.randomUUID().toString()
        val nextRun = UUID.randomUUID().toString()
        val fixture = ComposerApiFixture()
        fixture.disconnectSend = true
        fixture.beforeSendReturn = { check(sendResponse.await(60, TimeUnit.SECONDS)) }
        fixture.beforeInputStatusReturn = {
            checkReceived.countDown()
            check(checkResponse.await(60, TimeUnit.SECONDS))
        }

        fun textPayload(text: String, extraParts: String = "") =
            """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}$extraParts]}}"""

        fun replyPayload(text: String) = """{"content":${JsonPrimitive(text)}}"""

        fun rows(threadId: String): List<Triple<Long, String, String>> = buildList {
            if (threadId != CHAT_PERSONAL) return@buildList
            val metadata =
                """,{"type":"model","selectedModel":"fixture-only-model"},{"type":"additional_info","text":"fixture-only-context"}"""
            add(
                Triple(
                    17,
                    oldInput,
                    historyEventWire(
                        oldInput,
                        17,
                        type = "input.prompt",
                        payload = textPayload(opening, metadata),
                    ),
                )
            )
            add(
                Triple(
                    23,
                    oldReply,
                    historyEventWire(oldReply, 23, payload = replyPayload(activeReply)),
                )
            )
            add(
                Triple(
                    27,
                    oldUsage,
                    historyEventWire(
                        oldUsage,
                        27,
                        type = "usage.recorded",
                        payload = """{"usage":{"inputTokens":42}}""",
                    ),
                )
            )
            if (canonical.get()) {
                val eventId = fixture.inputs.keys.single()
                add(
                    Triple(
                        40,
                        eventId,
                        historyEventWire(
                            eventId,
                            40,
                            type = "input.prompt",
                            payload = textPayload(prompt),
                            run = null,
                        ),
                    )
                )
                if (delivered.get()) {
                    add(
                        Triple(
                            41,
                            terminal,
                            historyEventWire(terminal, 41, type = "run.completed", payload = "null"),
                        )
                    )
                    add(
                        Triple(
                            42,
                            deliveredInput,
                            historyEventWire(
                                deliveredInput,
                                42,
                                type = "input.prompt",
                                payload = textPayload(prompt),
                                run = nextRun,
                                revoke = eventId,
                            ),
                        )
                    )
                    add(
                        Triple(
                            43,
                            deliveredReply,
                            historyEventWire(
                                deliveredReply,
                                43,
                                payload = replyPayload(followupReply),
                                run = nextRun,
                            ),
                        )
                    )
                }
            }
        }

        fixture.chats.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            val since = url.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0
            val rows = rows(url.pathSegments[2])
            val tail = rows.filter { it.first > since }.joinToString(",") { it.third }
            val last = rows.lastOrNull()
            val cursor =
                """{"lastEventId":${last?.let { JsonPrimitive(it.second) }},"lastSeqId":${last?.first ?: 0}}"""
            jsonResponse("""{"rows":[$tail],"cursor":$cursor,"hasMore":false}""")
        }
        fixture.chats.historyCatchUp = { request ->
            val events =
                Json.parseToJsonElement(request.body.clone().readUtf8()).jsonArray.joinToString(
                    ","
                ) { tuple ->
                    val (id, since) = tuple.jsonArray
                    val tail =
                        rows(id.jsonPrimitive.content)
                            .filter { it.first > since.jsonPrimitive.long }
                            .joinToString(",") { it.third }
                    """$id:[$tail]"""
                }
            jsonResponse("""{"events":{$events},"notFoundThreads":[]}""")
        }
        app.chatService = fixture.service
        app.composerService = fixture.service
        app.journalStore = journal
        auth.state.value = testAuthenticationState(user = "outgoing-capture-${UUID.randomUUID()}")
        try {
            device.executeShellCommand("wm size 1080x1920")
            device.executeShellCommand("wm density 420")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                device.awaitChatList(app)
                await(text("Personal chat")).click()
                await(text(activeReply))
                await(text(opening))
                scenario.onActivity {
                    val ready =
                        checkNotNull(
                            ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                        )
                    check(
                        oldUsage in
                            ready.chats.history.uiState.value.transcript?.persistedIds.orEmpty()
                    )
                    jobs +=
                        listOfNotNull(
                            ready.composer.viewModelScope.coroutineContext[Job],
                            ready.chats.viewModelScope.coroutineContext[Job],
                            ready.controls.viewModelScope.coroutineContext[Job],
                        )
                }
                for (metadata in
                    listOf("fixture-only-model", "fixture-only-context", "inputTokens")) {
                    check(!device.hasObject(By.pkg(app.packageName).textContains(metadata))) {
                        "Internal history data entered the transcript"
                    }
                }
                val editor =
                    await(By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true))
                editor.click()
                editor.text = prompt
                fun imeVisible(expected: Boolean) =
                    awaitCondition("IME visible = $expected") {
                        var visible = false
                        scenario.onActivity {
                            visible =
                                it.window.decorView.rootWindowInsets?.isVisible(
                                    WindowInsets.Type.ime()
                                ) == true
                        }
                        visible == expected
                    }
                imeVisible(true)
                check(device.pressBack())
                imeVisible(false)
                await(
                        By.pkg(app.packageName)
                            .desc(app.getString(R.string.composer_send))
                            .enabled(true)
                    )
                    .click()
                awaitCondition("the submitted input at the mock HTTP boundary") {
                    fixture.inputs.size == 1
                }
                await(text(prompt))
                awaitStatus(R.string.composer_sending)
                ScreenshotCapture.capture("01-sending.png")

                sendResponse.countDown()
                awaitStatus(R.string.composer_unconfirmed)
                val checkDelivery = text(app.getString(R.string.composer_check)).enabled(true)
                val checkButton = await(checkDelivery)
                ScreenshotCapture.capture("02-unconfirmed.png")

                checkButton.click()
                check(checkReceived.await(15, TimeUnit.SECONDS))
                awaitStatus(R.string.composer_checking_delivery)
                ScreenshotCapture.capture("03-checking.png")

                canonical.set(true)
                checkResponse.countDown()
                val eventId = fixture.inputs.keys.single()
                awaitCondition("the canonical pending input") {
                    var pending = false
                    scenario.onActivity {
                        val ready =
                            checkNotNull(
                                ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                            )
                        pending =
                            eventId in
                                ready.chats.history.uiState.value.transcript
                                    ?.pendingInputIds
                                    .orEmpty()
                    }
                    pending
                }
                val revoke = text(app.getString(R.string.conversation_revoke))
                val revokeButton =
                    By.pkg(app.packageName).clickable(true).enabled(true).hasDescendant(revoke)
                await(revoke)
                await(text(prompt))
                check(device.findObjects(text(prompt)).size == 1)
                check(device.wait(Until.gone(text(app.getString(R.string.composer_check))), 15_000))
                ScreenshotCapture.capture("04-queued.png")
                awaitCondition("the enabled native withdrawal action") {
                    device.hasObject(revokeButton) ||
                        device.hasObject(By.copy(revoke).clickable(true).enabled(true))
                }

                delivered.set(true)
                scenario.onActivity {
                    val ready =
                        checkNotNull(
                            ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                        )
                    ready.chats.history.invalidate(CHAT_PERSONAL)
                }
                await(text(followupReply))
                check(
                    device.wait(
                        Until.gone(text(app.getString(R.string.conversation_revoke))),
                        15_000,
                    )
                )
                await(text(prompt))
                check(device.findObjects(text(prompt)).size == 1)
                check(fixture.inputs.size == 1)
                ScreenshotCapture.capture("05-delivered.png")
            }
        } catch (error: Throwable) {
            failures += error
        } finally {
            sendResponse.countDown()
            checkResponse.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } } },
                    { runBlocking { journal.close() } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    {
                        app.chatService = oldChat
                        app.composerService = oldComposer
                        app.journalStore = oldJournal
                        auth.state.value = oldAuth
                    },
                    { device.executeShellCommand("wm size ${size ?: "reset"}") },
                    { device.executeShellCommand("wm density ${density ?: "reset"}") },
                    { check(directory.deleteRecursively()) },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun text(value: String) = By.pkg(app.packageName).text(value)

    private fun await(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(selector), 15_000)) { "Missing $selector" }

    private fun awaitCondition(label: String, isReady: () -> Boolean) {
        val condition =
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) = isReady()
            }
        check(device.wait(condition, 15_000)) { "Did not observe $label" }
    }

    private fun awaitStatus(id: Int) {
        val label = app.getString(id)
        awaitCondition(label) {
            instrumentation.uiAutomation.rootInActiveWindow?.hasState(label) == true
        }
    }

    private fun AccessibilityNodeInfo.hasState(label: String): Boolean =
        stateDescription?.toString() == label ||
            (0 until childCount).any { getChild(it)?.hasState(label) == true }

    private fun displayOverride(kind: String): String? =
        device
            .executeShellCommand("wm $kind")
            .lineSequence()
            .firstOrNull { it.startsWith("Override ") }
            ?.substringAfter(": ")
            ?.trim()
}
