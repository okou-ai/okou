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
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.graphics.Rect
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
                        text(R.string.conversation_processing)
                        text(ActionFixture.queuedCopy)
                        text(ActionFixture.workflowCopy)
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
                                state.sync(target) == ComposerSync.Saved &&
                                !device.hasObject(textSelector(app.getString(R.string.composer_sync_saving))) &&
                                !device.hasObject(textSelector(app.getString(R.string.composer_saving)))
                        }
                        val editorBounds = find(editor, "message editor").visibleBounds
                        val historyRevision = revision(workspace)

                        val stop = action(R.string.conversation_stop)
                        check(stop.visibleBounds.height() >= 48) { "Stop height was ${stop.visibleBounds}" }
                        stop.click()
                        fixture.firstStop.awaitEntered("first Stop")
                        val stopping = text(R.string.controls_stopping)
                        check(stopping.visibleBounds.bottom < editorBounds.top)
                        check(!device.hasObject(textSelector(app.getString(R.string.conversation_processing))))
                        assertDraft(editor, editorBounds)
                        text(ActionFixture.queuedCopy)
                        text(ActionFixture.workflowCopy)
                        ScreenshotCapture.capture("01-stopping.png")

                        fixture.firstStop.release()
                        text(R.string.controls_stop_unknown)
                        val checkStop = action(R.string.controls_check)
                        check(checkStop.visibleBounds.height() >= 48)
                        check(!device.hasObject(textSelector(app.getString(R.string.conversation_stop))))
                        assertDraft(editor, editorBounds)
                        ScreenshotCapture.capture("02-stop-needs-check.png")
                        condition("Background history refresh ran before the explicit check") {
                            revision(workspace) > historyRevision
                        }

                        fixture.nextRead.set(fixture.checkStop)
                        checkStop.click()
                        fixture.checkStop.awaitEntered("explicit Stop check")
                        text(R.string.controls_stop_checking)
                        check(fixture.stops.size == 1)
                        assertDraft(editor, editorBounds)
                        ScreenshotCapture.capture("03-checking-stop.png")
                        fixture.checkStop.release()
                        text(R.string.controls_stop_failed)
                        text(R.string.conversation_processing)
                        assertDraft(editor, editorBounds)
                        ScreenshotCapture.capture("04-stop-retry.png")

                        action(R.string.conversation_stop).click()
                        text(R.string.controls_stop_accepted)
                        check(fixture.stops.size == 2 && fixture.stops.first() == fixture.stops.last())
                        fixture.confirmStop()
                        scenario.onActivity {
                            workspace.chats.history.invalidate(CHAT_PERSONAL)
                            workspace.chats.history.invalidateDetail(CHAT_PERSONAL)
                        }
                        text(R.string.controls_recovering)
                        text(ActionFixture.queuedCopy)
                        text(ActionFixture.workflowCopy)
                        check(!device.hasObject(textSelector(app.getString(R.string.conversation_stop))))
                        assertDraft(editor, editorBounds)
                        ScreenshotCapture.capture("05-preparing-to-continue.png")

                        val beforeWithdrawal = revision(workspace)
                        val withdraw = describedAction(R.string.conversation_revoke)
                        check(withdraw.visibleBounds.width() == 48 && withdraw.visibleBounds.height() == 48) {
                            "Withdrawal touch bounds were ${withdraw.visibleBounds}"
                        }
                        withdraw.click()
                        fixture.withdraw.awaitEntered("withdrawal")
                        text(R.string.conversation_withdrawing)
                        text(ActionFixture.queuedCopy)
                        text(ActionFixture.workflowCopy)
                        assertDraft(editor, editorBounds)
                        ScreenshotCapture.capture("06-withdrawing.png")
                        fixture.withdraw.release()
                        text(R.string.conversation_withdraw_unknown)
                        text(ActionFixture.queuedCopy)
                        text(ActionFixture.workflowCopy)
                        ScreenshotCapture.capture("07-withdraw-needs-check.png")
                        condition("Withdrawal invalidation finishes with its original card") {
                            revision(workspace) > beforeWithdrawal
                        }
                        fixture.confirmRevoke(fixture.revokes.single(), 6)
                        action(R.string.controls_check).click()
                        condition("Only the withdrawn queue entry is removed") {
                            !device.hasObject(textSelector(ActionFixture.queuedCopy)) &&
                                device.hasObject(textSelector(ActionFixture.workflowCopy))
                        }
                        check(fixture.revokes.size == 1)
                        check(find(editor, "retained draft").text == draft)

                        describedAction(R.string.conversation_skip_automation).click()
                        fixture.skip.awaitEntered("automation skip")
                        text(R.string.conversation_skipping)
                        text(ActionFixture.workflowCopy)
                        ScreenshotCapture.capture("08-skipping.png")
                        fixture.skip.release()
                        condition("Only the captured automation occurrence was skipped") {
                            !device.hasObject(textSelector(ActionFixture.workflowCopy))
                        }
                        check(fixture.revokes.map { it.id("revokesEventId") }.toSet() ==
                            setOf(ActionFixture.queuedId, ActionFixture.workflowId))

                        fixture.startAnotherRun()
                        scenario.onActivity {
                            workspace.chats.history.invalidate(CHAT_PERSONAL)
                            workspace.chats.history.invalidateDetail(CHAT_PERSONAL)
                        }
                        device.executeShellCommand("wm size 412x450")
                        condition("Device is in the short window") { device.displayHeight == 450 }
                        val compactStop = describedAction(R.string.controls_stop)
                        val compactBounds = compactStop.visibleBounds
                        check(compactBounds.width() == 48 && compactBounds.height() == 48) {
                            "Compact Stop touch bounds were $compactBounds"
                        }
                        compactStop.click()
                        fixture.shortStop.awaitEntered("short-window Stop")
                        val disabledStop = describedAction(R.string.controls_stop, enabled = false)
                        check(disabledStop.visibleBounds == compactBounds)
                        text(R.string.controls_stopping)
                        check(find(editor, "retained draft in short window").text == draft)
                        check(fixture.stops.last().id("interruptsRunId") == ActionFixture.nextRun)
                        ScreenshotCapture.capture("09-short-stopping.png")
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

    private fun revision(workspace: ReadyWorkspace) =
        workspace.chats.history.uiState.value.confirmation?.revision ?: 0L

    private fun text(id: Int) = text(app.getString(id))

    private fun text(value: String) = find(textSelector(value), value)

    private fun textSelector(value: String) =
        By.pkg(app.packageName).text(Pattern.compile(Pattern.quote(value) + "\\n*"))

    private fun action(id: Int) = find(
        By.pkg(app.packageName).clickable(true).enabled(true).hasDescendant(textSelector(app.getString(id))),
        app.getString(id),
    )

    private fun describedAction(id: Int, enabled: Boolean = true): UiObject2 {
        val description = app.getString(id)
        val selector = By.pkg(app.packageName).desc(description)
        var button: UiObject2? = null
        condition("Missing $description button with enabled=$enabled") {
            button = generateSequence(device.findObject(selector)) { it.parent }
                .firstOrNull { it.isEnabled == enabled && (it.isClickable || it.className == "android.widget.Button") }
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
    val firstStop = ResponseGate()
    val checkStop = ResponseGate()
    val withdraw = ResponseGate()
    val skip = ResponseGate()
    val shortStop = ResponseGate()
    val nextRead = AtomicReference<ResponseGate?>()
    val stops = ConcurrentLinkedQueue<JsonObject>()
    val revokes = ConcurrentLinkedQueue<JsonObject>()
    private val continuation = AtomicBoolean()
    private val rows = AtomicReference(
        listOf(
            prompt("11111111-1111-4111-8111-111111111111", 1, "Check that the launch materials are ready.", HISTORY_RUN),
            event(
                "22222222-2222-4222-8222-222222222222",
                2,
                "output.message",
                """{"content":"The email and web copy are ready. I’m checking the channel links for the handoff."}""",
                HISTORY_RUN,
            ),
            prompt(queuedId, 3, queuedCopy, null),
            event(
                workflowId,
                4,
                "input.automation",
                """{"userMessage":{"version":1,"parts":[{"type":"automation","workflowName":"$workflowCopy","automationBrief":"Scheduled trigger"}]}}""",
                null,
            ),
        ),
    )

    init {
        api.historyCatchUp = { MockResponse().setResponseCode(503) }
        val otherHistory = api.historyRows
        api.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.pathSegments[2] != CHAT_PERSONAL) otherHistory(request)
            else {
                nextRead.getAndSet(null)?.hold()
                val since = url.queryParameter("sinceSeqId")?.toLong() ?: 0L
                val current = rows.get()
                val last = current.last()
                val tail = current.filter { it.seqId > since }.joinToString(",") { it.archiveJson() }
                jsonResponse(
                    """{"rows":[$tail],"cursor":{"lastEventId":"${last.id}","lastSeqId":${last.seqId}},"hasMore":false}""",
                )
            }
        }
        api.historyDetail = {
            jsonResponse("""{"lastReadAt":"$CHAT_DATE","cancellationRecoveryPending":${continuation.get()}}""")
        }
        api.commandResponse = { request ->
            if (request.method == "POST" && request.requestUrl?.encodedPath == "/api/chat/events") {
                val input = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                when {
                    "interruptsRunId" in input -> {
                        stops += input
                        when (stops.size) {
                            1 -> { firstStop.hold(); MockResponse().setResponseCode(503) }
                            2 -> accepted()
                            else -> { shortStop.hold(); MockResponse().setResponseCode(503) }
                        }
                    }
                    "revokesEventId" in input -> {
                        revokes += input
                        if (input.id("revokesEventId") == queuedId) {
                            withdraw.hold()
                            MockResponse().setResponseCode(503)
                        } else {
                            skip.hold()
                            confirmRevoke(input, 7)
                            accepted()
                        }
                    }
                    else -> error("Unexpected send from the draft")
                }
            } else null
        }
    }

    fun confirmStop() {
        continuation.set(true)
        append(event(stops.last().id("clientEventId"), 5, "control.interrupt", "null", HISTORY_RUN))
    }

    fun confirmRevoke(request: JsonObject, seq: Long) = append(
        event(request.id("clientEventId"), seq, "control.revoke", "null", null, request.id("revokesEventId")),
    )

    fun startAnotherRun() {
        continuation.set(false)
        append(prompt("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", 8, "Verify the remaining rollout tasks.", nextRun))
    }

    fun releaseAll() {
        listOf(firstStop, checkStop, withdraw, skip, shortStop).forEach(ResponseGate::release)
    }

    private fun append(value: HistoryEvent) {
        rows.updateAndGet { it + value }
    }

    private fun accepted() = jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)

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
        const val queuedId = "33333333-3333-4333-8333-333333333333"
        const val workflowId = "44444444-4444-4444-8444-444444444444"
        const val nextRun = "55555555-5555-4555-8555-555555555555"
        const val queuedCopy = "Summarize the open launch items."
        const val workflowCopy = "Daily launch checklist"
    }
}
