package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_RUN
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.RecoveryApiFixture
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.ReadyWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.content.res.Configuration
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
        .applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
    private val stop = By.pkg(app.packageName).desc(app.getString(R.string.controls_stop))
    private val draft = "Use the checklist format"
    private val firstSuggestion = "Group the checklist by owner"
    private val activity = "Checking channel links and launch times"
    private val largeActivity =
        "Checking the web and email launch checklist against the latest release notes and channel schedules"
    private val nextRun = "77777777-7777-4777-8777-777777777779"
    private val failedRun = "77777777-7777-4777-8777-777777777770"

    @Test
    fun rendersConversationTurnAndReadFeedback() {
        val originalSize = displayOverride("size")
        val originalDensity = displayOverride("density")
        val font = device.executeShellCommand("settings get system font_scale").trim()
        val mode = device.executeShellCommand("cmd uimode night").substringAfterLast(':').trim()
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val originalComposer = app.composerService
        val originalControls = app.controlService
        val originalRecovery = app.recoveryService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            RecoveryApiFixture(api)
            val fixture = TurnFixture(api)
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("cmd uimode night no")
            app.chatService = api.service
            app.composerService = api.service
            app.controlService = api.service
            app.recoveryService = api.service
            auth.state.value = testAuthenticationState(user = "turn-feedback-${UUID.randomUUID()}")
            try {
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        device.awaitChatList(app)
                        text("Personal chat").click()
                        lateinit var workspace: ReadyWorkspace
                        scenario.onActivity {
                            workspace = checkNotNull(
                                ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready,
                            )
                        }
                        condition("First history read failed while the conversation was visible") {
                            workspace.chats.history.uiState.value.consecutiveReadFailures >= 1
                        }
                        find(description(R.string.history_loading), "retained two-turn skeleton")
                        check(!device.hasObject(selector(app.getString(R.string.history_failed))))
                        ScreenshotCapture.capture("01-empty-history-retry.png")

                        val firstTime = Instant.now().minusSeconds(180)
                        fixture.append(
                            row(1, "input.prompt", prompt("What is left before launch?"), firstTime),
                        )
                        fixture.failing.set(false)
                        confirmed(workspace, 1)
                        assertInlineStop(text(activity))
                        ScreenshotCapture.capture("02-zero-reply-activity.png")

                        val reply = "The web and email copy are ready. The channel links still need a final check."
                        fixture.append(
                            row(2, "output.message", content(reply), firstTime.plusSeconds(31)),
                            row(3, "run.completed", "null", firstTime.plusSeconds(46)),
                        )
                        refresh(scenario)
                        confirmed(workspace, 3)
                        text(reply)
                        val staticSummary = text("Worked for 46 seconds")
                        check(!staticSummary.isClickable)
                        condition("Stop disappears after completion") { !device.hasObject(stop) }
                        ScreenshotCapture.capture("03-one-reply-complete.png")

                        fixture.append(
                            row(
                                4,
                                "output.followups",
                                content(
                                    """{"version":1,"followups":[
                                        {"prompt":"$firstSuggestion","kind":"talk"},
                                        {"prompt":"Write a one-page launch brief","kind":"generate","generationType":"presentation"},
                                        {"prompt":"Create a workflow to recheck the links and release time before each launch","kind":"workflow"}
                                    ]}""".trimIndent(),
                                ),
                                firstTime.plusSeconds(50),
                            ),
                        )
                        refresh(scenario)
                        confirmed(workspace, 4)
                        val suggestion = text(firstSuggestion)
                        find(editor, "composer").setText(draft)
                        val target = ComposerTarget(threadId = CHAT_PERSONAL)
                        condition("The current draft is in the conversation editor") {
                            workspace.composer.uiState.value.entry(target).text == draft
                        }
                        ScreenshotCapture.capture("04-late-suggestions.png")
                        suggestion.click()
                        val expectedDraft = "$draft\n$firstSuggestion"
                        condition("Suggestion appended to the original draft and focused the editor") {
                            workspace.composer.uiState.value.entry(target).text == expectedDraft &&
                                device.findObject(editor)?.isFocused == true
                        }
                        ScreenshotCapture.capture("05-suggestion-in-editor.png")
                        scenario.onActivity {
                            val insets = ViewCompat.getRootWindowInsets(it.window.decorView)
                            if (insets?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                                ViewCompat.getWindowInsetsController(it.window.decorView)
                                    ?.hide(WindowInsetsCompat.Type.ime())
                            }
                        }

                        val secondTime = Instant.now().minusSeconds(84)
                        val early = "I drafted the checklist and verified the dates."
                        val current = "The launch checklist is ready for a final review."
                        fixture.append(
                            row(5, "input.prompt", prompt("Continue checking the release."), secondTime, nextRun),
                            row(6, "output.message", content(early), secondTime.plusSeconds(43), nextRun),
                            row(7, "output.message", content("The website and email drafts agree."),
                                secondTime.plusSeconds(58), nextRun),
                            row(8, "output.message", content(current), secondTime.plusSeconds(68), nextRun),
                        )
                        refresh(scenario)
                        confirmed(workspace, 8)
                        text(current)
                        condition("Old suggestions leave when a new turn begins") {
                            !device.hasObject(selector(firstSuggestion))
                        }
                        val disclosure = By.pkg(app.packageName).text(Pattern.compile(".* · 2 steps"))
                        find(disclosure, "multi-reply disclosure").click()
                        text(early)
                        text(current)
                        ScreenshotCapture.capture("06-expanded-reply-timeline.png")

                        val followup = "Double-check the email schedule."
                        fixture.append(
                            row(9, "input.prompt", prompt(followup), Instant.now(), nextRun),
                        )
                        refresh(scenario)
                        confirmed(workspace, 9)
                        val user = text(followup)
                        check(text(activity).visibleBounds.top > user.visibleBounds.bottom)
                        fixture.longActivity.set(true)
                        device.executeShellCommand("cmd uimode night yes")
                        device.executeShellCommand("settings put system font_scale 2.0")
                        condition("Dark mode and 200% text size are active") {
                            val config = app.resources.configuration
                            config.fontScale >= 2f &&
                                config.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                                    Configuration.UI_MODE_NIGHT_YES
                        }
                        val label = checkNotNull(
                            device.wait(Until.findObject(selector(largeActivity)), 20_000),
                        ) { "Long activity did not appear" }
                        check(label.visibleBounds.height() > 35)
                        assertInlineStop(label)
                        ScreenshotCapture.capture("07-dark-large-activity.png")
                        device.executeShellCommand("settings put system font_scale 1.0")
                        device.executeShellCommand("cmd uimode night no")
                        condition("Normal configuration restored") {
                            app.resources.configuration.fontScale == 1f &&
                                app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                                    Configuration.UI_MODE_NIGHT_NO
                        }
                        scenario.onActivity {
                            workspace = checkNotNull(
                                ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready,
                            )
                        }
                        val pendingLabel = text(largeActivity)
                        val activityBounds = pendingLabel.visibleBounds
                        find(stop, "Stop at normal text size").click()
                        condition("Stop is submitting with the activity row still in place") {
                            fixture.stopRequested.count == 0L && !device.hasObject(stop)
                        }
                        check(text(largeActivity).visibleBounds == activityBounds)
                        ScreenshotCapture.capture("08-stop-pending.png")
                        fixture.append(row(10, "run.cancelled", "null", Instant.now(), nextRun))
                        fixture.releaseStop.countDown()
                        refresh(scenario)
                        confirmed(workspace, 10)
                        val status = text(app.getString(R.string.history_cancelled))
                        condition("Cancelled task has no Stop entry") { !device.hasObject(stop) }
                        ScreenshotCapture.capture("09-stopped-task.png")

                        val statusBounds = status.visibleBounds
                        fixture.failing.set(true)
                        refresh(scenario)
                        condition("Cached history reaches its third read failure") {
                            workspace.chats.history.uiState.value.consecutiveReadFailures >= 3
                        }
                        find(description(R.string.history_syncing), "top history retry bar")
                        check(text(app.getString(R.string.history_cancelled)).visibleBounds == statusBounds)
                        check(!device.hasObject(description(R.string.history_loading)))
                        ScreenshotCapture.capture("10-cached-history-retry.png")

                        val failureTime = Instant.now().minusSeconds(46)
                        val partial = "The email schedule is ready. The website check can continue."
                        fixture.append(
                            row(11, "input.prompt", prompt("Finish the remaining launch checks."),
                                failureTime, failedRun),
                            row(12, "output.message", content(partial),
                                failureTime.plusSeconds(30), failedRun),
                            row(13, "run.failed", "null", failureTime.plusSeconds(46), failedRun,
                                failureReason = "execution_timeout"),
                        )
                        fixture.failing.set(false)
                        confirmed(workspace, 13)
                        text(partial)
                        text(app.getString(R.string.run_failure_execution_timeout_title))
                        text(app.getString(R.string.recovery_continue))
                        ScreenshotCapture.capture("11-failed-task-recovery.png")
                    } catch (error: Exception) {
                        try {
                            ScreenshotCapture.capture("diagnostic.png")
                        } catch (captureError: Exception) {
                            error.addSuppressed(captureError)
                        }
                        throw error
                    } finally {
                        fixture.releaseStop.countDown()
                    }
                }
            } finally {
                try {
                    cache.restore()
                } finally {
                    auth.state.value = originalAuth
                    app.chatService = originalChat
                    app.composerService = originalComposer
                    app.controlService = originalControls
                    app.recoveryService = originalRecovery
                    device.executeShellCommand("wm size $originalSize")
                    device.executeShellCommand("wm density $originalDensity")
                    if (font.toFloatOrNull() == null)
                        device.executeShellCommand("settings delete system font_scale")
                    else device.executeShellCommand("settings put system font_scale $font")
                    device.executeShellCommand("cmd uimode night ${mode.takeIf { it in setOf("yes", "no", "auto", "custom") } ?: "no"}")
                }
            }
        }
    }

    private fun displayOverride(kind: String): String {
        val output = device.executeShellCommand("wm $kind")
        return output.lineSequence().firstOrNull { it.startsWith("Override") }
            ?.substringAfter(':')?.trim() ?: "reset"
    }

    private fun condition(reason: String, predicate: () -> Boolean) {
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean = predicate()
        }, 12_000)) { reason }
    }

    private fun find(selector: BySelector, reason: String): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { reason }

    private fun selector(value: String) = By.pkg(app.packageName).text(value)

    private fun text(value: String) = find(selector(value), "Expected text: $value")

    private fun description(res: Int) = By.pkg(app.packageName).desc(app.getString(res))

    private fun assertInlineStop(label: UiObject2) {
        val center = label.visibleBounds.centerY()
        condition("Full 48 × 48 dp Stop target is aligned with the activity") {
            device.findObject(stop)?.visibleBounds?.let {
                it.width() == 48 && it.height() == 48 && center in it.top..it.bottom
            } == true
        }
    }

    private fun confirmed(workspace: ReadyWorkspace, sequence: Long) =
        condition("History confirms event $sequence") {
            val state = workspace.chats.history.uiState.value
            state.phase == HistoryPhase.Ready && state.confirmation?.cursor?.seqId == sequence
        }

    private fun refresh(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity {
            checkNotNull(ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready)
                .chats.history.refresh()
        }
    }

    private fun row(
        seq: Long,
        type: String,
        payload: String,
        time: Instant,
        run: String = HISTORY_RUN,
        failureReason: String? = null,
    ): HistoryEvent {
        val wire = historyEventWire(
            id = "00100101-1000-4000-8000-${seq.toString().padStart(12, '0')}",
            seq = seq, type = type, payload = payload, run = run, createdAt = time.toString(),
        )
        return HistoryEvent.decode(
            if (failureReason == null) wire
            else wire.dropLast(1) + ""","failureReason":${JsonPrimitive(failureReason)}}""",
        )
    }

    private fun content(value: String) = """{"content":${JsonPrimitive(value)}}"""

    private fun prompt(value: String) =
        """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(value)}}]}}"""

    private inner class TurnFixture(api: ChatListApiFixture) {
        val failing = AtomicBoolean(true)
        val longActivity = AtomicBoolean(false)
        val stopRequested = CountDownLatch(1)
        val releaseStop = CountDownLatch(1)
        private val rows = AtomicReference<List<HistoryEvent>>(emptyList())

        init {
            // The warm path must not introduce the default fixtures before this chat's cold open.
            api.historyCatchUp = { MockResponse().setResponseCode(503) }
            api.historyRows = { request ->
                if (failing.get()) MockResponse().setResponseCode(503)
                else {
                    val confirmed = rows.get()
                    val last = confirmed.last()
                    val after = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
                    val tail = confirmed.filter { it.seqId > after }.joinToString(",") { it.archiveJson() }
                    jsonResponse(
                        """{"rows":[$tail],"cursor":{"lastEventId":"${last.id}","lastSeqId":${last.seqId}},"hasMore":false}""",
                    )
                }
            }
            api.runActivity = { request ->
                check(request.method == "POST")
                check(request.getHeader("Authorization") == "Bearer fixture-token")
                val run = parse(request).jsonObject.getValue("runId")
                val copy = if (longActivity.get()) largeActivity else activity
                jsonResponse(
                    """{"runId":$run,"status":"available","messages":[{"id":"blank","text":" "},{"id":"first","text":${JsonPrimitive(copy)}}]}""",
                )
            }
            val recoveryResponses = api.commandResponse
            api.commandResponse = { request ->
                if (request.method == "POST" && request.requestUrl?.encodedPath == "/api/chat/events") {
                    val input = parse(request).jsonObject
                    check(input.getValue("interruptsRunId").jsonPrimitive.content == nextRun)
                    stopRequested.countDown()
                    check(releaseStop.await(25, TimeUnit.SECONDS))
                    jsonResponse("""{"threadId":"$CHAT_PERSONAL"}""").setResponseCode(201)
                } else recoveryResponses(request)
            }
        }

        fun append(vararg events: HistoryEvent) {
            rows.updateAndGet { it + events }
        }

        private fun parse(request: RecordedRequest) =
            Json.parseToJsonElement(request.body.clone().readUtf8())
    }
}
