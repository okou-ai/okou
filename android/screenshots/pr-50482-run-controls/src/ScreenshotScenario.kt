package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_RUN
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.ReadyWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ComposerPersistence
import ai.okou.android.chat.ComposerSync
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chat.RunControlPhase
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.graphics.Rect
import android.os.SystemClock
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun stopAndQueueFeedbackUseTheNativeConversation() {
        val originalSize = displayOverride("size")
        val originalDensity = displayOverride("density")
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalService = app.chatService
        val originalComposer = app.composerService
        val originalControls = app.controlService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            val fixture = ActionFixture(api)
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("wm density 160")
            app.chatService = api.service
            app.composerService = api.service
            app.controlService = api.service
            auth.state.value = testAuthenticationState(user = "action-capture-${UUID.randomUUID()}")
            try {
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        device.awaitChatList(app)
                        text("Personal chat").click()
                        fixture.initialHistory.awaitEntered("initial history")
                        find(
                            By.pkg(app.packageName).desc(app.getString(R.string.history_loading)),
                            "first-history skeleton",
                        )
                        fixture.initialHistory.release()
                        text(R.string.conversation_processing)
                        queueButton(2)
                        lateinit var workspace: ReadyWorkspace
                        scenario.onActivity {
                            workspace = checkNotNull(ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready)
                        }
                        condition("Initial history is confirmed") {
                            workspace.chats.history.uiState.value.phase == HistoryPhase.Ready
                        }
                        val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
                        find(editor, "message editor").setText(draft)
                        val target = ComposerTarget(threadId = CHAT_PERSONAL)
                        condition("Draft is visible and durably synchronized") {
                            val state = workspace.composer.uiState.value
                            device.findObject(editor)?.text == draft &&
                                state.entry(target).text == draft &&
                                state.persistence == ComposerPersistence.Durable &&
                                state.sync(target) == ComposerSync.Saved
                        }
                        val editorBounds = find(editor, "message editor").visibleBounds
                        val reply = "The email and web copy are ready. I’m checking the channel links for the handoff."
                        val replyBounds = text(reply).visibleBounds
                        val stop = describedAction(R.string.controls_stop)
                        check(stop.visibleBounds.width() == 48 && stop.visibleBounds.height() == 48)
                        stop.click()
                        fixture.firstStop.awaitEntered("first Stop")
                        runningWithStopHidden(editor, editorBounds, queueCount = 2)
                        check(text(reply).visibleBounds == replyBounds)
                        ScreenshotCapture.capture("01-stop-pending.png")

                        queueButton(2).click()
                        val panelTop = panelCount(2).visibleBounds.top
                        describedAction(R.string.conversation_revoke).click()
                        fixture.withdraw.awaitEntered("withdrawal")
                        condition("Only the selected queued message is hidden") {
                            !device.hasObject(textSelector(ActionFixture.queuedCopy))
                        }
                        text(ActionFixture.workflowCopy)
                        check(panelCount(1).visibleBounds.top == panelTop)
                        ScreenshotCapture.capture("02-withdraw-pending.png")
                        closeQueue(1)

                        fixture.firstStop.release()
                        fixture.retryStop.awaitEntered("automatic Stop retry")
                        runningWithStopHidden(editor, editorBounds, queueCount = 1)
                        fixture.retryStop.release()
                        val stopError = text(R.string.controls_stop_failed)
                        check(fixture.stops.size == 3 && fixture.stops.distinct().size == 1)
                        check(fixture.retryWaits.size == 2 && fixture.retryWaits.all { it >= 3_000 })
                        describedAction(R.string.controls_stop)
                        check(stopError.visibleBounds.bottom < editorBounds.top)
                        assertDraft(editor, editorBounds)
                        fixture.withdraw.release()
                        condition("The rejected withdrawal restores the queue before its notice") {
                            workspace.controls.uiState.value.phases.values.count {
                                it == RunControlPhase.Retryable
                            } == 2
                        }
                        queueButton(2)
                        check(device.hasObject(textSelector(app.getString(R.string.controls_stop_failed))))
                        check(!device.hasObject(textSelector(app.getString(R.string.conversation_withdraw_failed))))
                        ScreenshotCapture.capture("03-stop-failed.png")

                        val withdrawError = text(R.string.conversation_withdraw_failed)
                        check(!device.hasObject(textSelector(app.getString(R.string.controls_stop_failed))))
                        check(withdrawError.visibleBounds.bottom < editorBounds.top)
                        assertDraft(editor, editorBounds)
                        ScreenshotCapture.capture("04-withdraw-failed-conversation.png")
                        awaitNoticeDismissed(R.string.conversation_withdraw_failed)

                        queueButton(2).click()
                        val retryPanelTop = panelCount(2).visibleBounds.top
                        describedAction(R.string.conversation_revoke).click()
                        fixture.retryWithdraw.awaitEntered("explicit same-request withdrawal")
                        check(panelCount(1).visibleBounds.top == retryPanelTop)
                        fixture.retryWithdraw.release()
                        text(R.string.conversation_withdraw_failed)
                        text(ActionFixture.queuedCopy)
                        text(ActionFixture.workflowCopy)
                        check(panelCount(2).visibleBounds.top == retryPanelTop)
                        check(fixture.revokes.size == 2 && fixture.revokes.distinct().size == 1)
                        ScreenshotCapture.capture("05-withdraw-failed-queue.png")
                        closeQueue(2)
                        val movedError = text(R.string.conversation_withdraw_failed)
                        check(movedError.visibleBounds.bottom < editorBounds.top)
                        assertDraft(editor, editorBounds)
                        awaitNoticeDismissed(R.string.conversation_withdraw_failed)

                        resize(1040, 900)
                        condition("The editor is in the wide conversation pane") {
                            (device.findObject(editor)?.visibleBounds?.left ?: 0) > 320
                        }
                        val wideEditor = find(editor, "wide conversation editor")
                        check(wideEditor.text == draft)
                        describedAction(R.string.controls_stop).click()
                        val wideFailure = text(R.string.controls_stop_failed)
                        check(wideFailure.visibleBounds.left > 320)
                        check(wideFailure.visibleBounds.bottom < wideEditor.visibleBounds.top)
                        ScreenshotCapture.capture("06-wide-stop-failed.png")
                    } catch (error: Exception) {
                        try {
                            ScreenshotCapture.capture("diagnostic.png")
                        } catch (captureError: Exception) {
                            error.addSuppressed(captureError)
                        }
                        throw error
                    } finally {
                        fixture.releaseAll()
                    }
                }
            } finally {
                try {
                    cache.restore()
                } finally {
                    auth.state.value = originalAuth
                    app.chatService = originalService
                    app.composerService = originalComposer
                    app.controlService = originalControls
                    device.executeShellCommand("wm size $originalSize")
                    device.executeShellCommand("wm density $originalDensity")
                }
            }
        }
    }

    private fun assertDraft(selector: BySelector, bounds: Rect) {
        val current = find(selector, "message editor")
        check(current.text == draft && current.visibleBounds == bounds) {
            "Draft or editor position changed: ${current.visibleBounds} / $bounds"
        }
    }

    private fun runningWithStopHidden(editor: BySelector, editorBounds: Rect, queueCount: Int) {
        condition("Only the Stop button leaves while the original run is still working") {
            !device.hasObject(stopSelector())
        }
        text(R.string.conversation_processing)
        queueButton(queueCount)
        assertDraft(editor, editorBounds)
    }

    private fun text(id: Int) = text(app.getString(id))

    private fun text(value: String) = find(textSelector(value), value)

    private fun textSelector(value: String) =
        By.pkg(app.packageName).text(Pattern.compile(Pattern.quote(value) + "\\n*"))

    private fun stopSelector() = By.pkg(app.packageName).desc(app.getString(R.string.controls_stop))

    private fun queueButton(count: Int) = find(
        By.pkg(app.packageName).desc(app.getString(R.string.conversation_queue_count, count)),
        "queue count ${count}",
    )

    private fun panelCount(count: Int) = text(app.getString(R.string.conversation_queue_count, count))

    private fun resize(width: Int, height: Int) {
        device.executeShellCommand("wm size ${width}x${height}")
        condition("Device display should be ${width}x${height}") {
            device.displayWidth == width && device.displayHeight == height
        }
    }

    private fun closeQueue(count: Int) {
        check(device.pressBack())
        condition("The queue closes before returning to the same conversation") {
            !device.hasObject(textSelector(app.getString(R.string.conversation_queue_count, count)))
        }
    }

    private fun awaitNoticeDismissed(id: Int) {
        condition("The failure notice dismisses after its timeout") {
            !device.hasObject(textSelector(app.getString(id)))
        }
    }

    private fun describedAction(id: Int): UiObject2 {
        val description = app.getString(id)
        val selector = By.pkg(app.packageName).descStartsWith(description)
        var button: UiObject2? = null
        condition("Missing $description button") {
            button = generateSequence(device.findObject(selector)) { it.parent }
                .firstOrNull { it.isEnabled && (it.isClickable || it.className == "android.widget.Button") }
            button != null
        }
        return checkNotNull(button)
    }

    private fun find(selector: BySelector, description: String) =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $description" }

    private fun condition(description: String, predicate: () -> Boolean) {
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean = predicate()
        }, 12_000)) { description }
    }

    private fun displayOverride(property: String) =
        device.executeShellCommand("wm $property").lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(':')?.trim() ?: "reset"

    private companion object {
        const val draft = "Draft: note the remaining approvals."
    }
}

private class ResponseGate {
    private val entered = CountDownLatch(1)
    private val released = CountDownLatch(1)

    fun hold() {
        entered.countDown()
        check(released.await(25, TimeUnit.SECONDS)) { "Fixture response was not released" }
    }

    fun awaitEntered(description: String) {
        check(entered.await(12, TimeUnit.SECONDS)) { "No request reached the held $description response" }
    }

    fun release() = released.countDown()
}

private fun JsonObject.id(name: String) = getValue(name).jsonPrimitive.content

private class ActionFixture(api: ChatListApiFixture) {
    val initialHistory = ResponseGate()
    val firstStop = ResponseGate()
    val retryStop = ResponseGate()
    val withdraw = ResponseGate()
    val retryWithdraw = ResponseGate()
    val stops = ConcurrentLinkedQueue<JsonObject>()
    val revokes = ConcurrentLinkedQueue<JsonObject>()
    val retryWaits = ConcurrentLinkedQueue<Long>()
    private val firstHistory = AtomicBoolean(true)
    private val lastStopFailure = AtomicReference<Long>()
    private val rows = listOf(
            prompt("01000000-0000-4000-8000-000000000001", 1, "Put together the launch plan.", olderRun),
            event(
                "02000000-0000-4000-8000-000000000002", 2, "output.message",
                """{"content":"**Plan for the launch**\n\n1. Review the website and email copy with the product team.\n2. Have each channel owner confirm their links.\n3. Share the final checklist before launch day."}""",
                olderRun,
            ),
            event("03000000-0000-4000-8000-000000000003", 3, "run.completed", "null", olderRun),
            prompt("04000000-0000-4000-8000-000000000004", 4, "Start with the website and email.", previousRun),
            event(
                "05000000-0000-4000-8000-000000000005", 5, "output.message",
                """{"content":"I’ve matched the site copy to the current positioning. The email follows the same message and is ready for final approval."}""",
                previousRun,
            ),
            event("06000000-0000-4000-8000-000000000006", 6, "run.completed", "null", previousRun),
            prompt("11111111-1111-4111-8111-111111111111", 7, "Check that the launch materials are ready.", HISTORY_RUN),
            event(
                "22222222-2222-4222-8222-222222222222",
                8,
                "output.message",
                """{"content":"The email and web copy are ready. I’m checking the channel links for the handoff."}""",
                HISTORY_RUN,
            ),
            prompt(queuedId, 9, queuedCopy, null),
            event(
                workflowId,
                10,
                "input.automation",
                """{"userMessage":{"version":1,"parts":[{"type":"automation","workflowName":"$workflowCopy","automationBrief":"Scheduled trigger"}]}}""",
                null,
            ),
        )

    init {
        api.historyCatchUp = { MockResponse().setResponseCode(503) }
        val otherHistory = api.historyRows
        api.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.pathSegments[2] != CHAT_PERSONAL) otherHistory(request)
            else {
                if (firstHistory.getAndSet(false)) initialHistory.hold()
                val since = url.queryParameter("sinceSeqId")?.toLong() ?: 0L
                val last = rows.last()
                val tail = rows.filter { it.seqId > since }.joinToString(",") { it.archiveJson() }
                jsonResponse(
                    """{"rows":[$tail],"cursor":{"lastEventId":"${last.id}","lastSeqId":${last.seqId}},"hasMore":false}""",
                )
            }
        }
        api.historyDetail = {
            jsonResponse("""{"lastReadAt":"$CHAT_DATE","cancellationRecoveryPending":false}""")
        }
        api.commandResponse = { request ->
            if (request.method == "POST" && request.requestUrl?.encodedPath == "/api/chat/events") {
                val input = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                when {
                    "interruptsRunId" in input -> {
                        stops += input
                        when (stops.size) {
                            1 -> { firstStop.hold(); failStop() }
                            2 -> { retryWaits += sinceStopFailure(); retryStop.hold(); failStop() }
                            3 -> { retryWaits += sinceStopFailure(); failStop() }
                            else -> MockResponse().setResponseCode(400)
                        }
                    }
                    "revokesEventId" in input -> {
                        revokes += input
                        check(input.id("revokesEventId") == queuedId)
                        if (revokes.size == 1) withdraw.hold() else retryWithdraw.hold()
                        MockResponse().setResponseCode(400)
                    }
                    else -> error("Unexpected send from the draft")
                }
            } else null
        }
    }

    private fun failStop(): MockResponse {
        lastStopFailure.set(SystemClock.elapsedRealtime())
        return MockResponse().setResponseCode(503)
    }

    private fun sinceStopFailure() = SystemClock.elapsedRealtime() - checkNotNull(lastStopFailure.get())

    fun releaseAll() {
        listOf(initialHistory, firstStop, retryStop, withdraw, retryWithdraw).forEach(ResponseGate::release)
    }

    private fun prompt(id: String, seq: Long, text: String, run: String?) = event(
        id,
        seq,
        "input.prompt",
        """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]}}""",
        run,
    )

    private fun event(id: String, seq: Long, type: String, payload: String, run: String?, revoke: String? = null) =
        HistoryEvent.decode(historyEventWire(id, seq, type = type, payload = payload, run = run, revoke = revoke))

    companion object {
        const val olderRun = "08000000-0000-4000-8000-000000000008"
        const val previousRun = "09000000-0000-4000-8000-000000000009"
        const val queuedId = "33333333-3333-4333-8333-333333333333"
        const val workflowId = "44444444-4444-4444-8444-444444444444"
        const val queuedCopy = "Summarize the open launch items."
        const val workflowCopy = "Daily launch checklist"
    }
}
