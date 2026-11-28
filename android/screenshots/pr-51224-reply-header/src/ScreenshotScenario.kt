package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.HISTORY_RUN
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.generated.SessionOutputDelta
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.RunOutputSignal
import ai.okou.android.historyEventWire
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Rect
import android.graphics.drawable.AnimatedVectorDrawable
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.core.view.children
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private data class NativeAvatar(val bounds: Rect, val running: Boolean)

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun replyAvatarAnimatesFromQueueingUntilTheVisibleTurnSettles() =
        withFixture { fixture, realtime ->
            val prompt = "Please put the launch tasks in review order."
            val queuedInput = inputEvent(1, null, prompt)
            val text = "Start with the launch checklist."
            val reply = "$text\n\n1. Review the home page.\n2. Confirm the email copy.\n3. Check the channel links."
            val replyId = eventId(3)
            val name = By.text(app.getString(R.string.app_name))
            val action = By.desc(app.getString(R.string.conversation_reply_actions))
            val body = By.textContains(text)
            fixture.setHistoryEvents(CHAT_PERSONAL, listOf(queuedInput))

            ActivityScenario.launch(MainActivity::class.java).use { activity ->
                device.awaitChatList(app)
                item(By.text("Personal chat")).click()
                item(By.text(app.getString(R.string.conversation_run_queued)))
                await("animation before the queued input starts") { nativeAvatar(activity)?.running == true }
                val queuedAvatar = checkNotNull(nativeAvatar(activity)).bounds
                val queuedName = item(name).visibleBounds
                check(queuedAvatar.width() == 32 && queuedAvatar.height() == 32)
                check(queuedName.left - queuedAvatar.right == 8)
                check(!device.hasObject(action))
                ScreenshotCapture.capture("00-queued.png")

                val firstInput = inputEvent(
                    2, HISTORY_RUN, prompt, revoke = eventId(1),
                    createdAt = Instant.now().minusSeconds(68).toString(),
                )
                fixture.setHistoryEvents(CHAT_PERSONAL, listOf(queuedInput, firstInput))
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_PERSONAL)))
                item(By.text(app.getString(R.string.conversation_processing)))
                await("animation while processing before the first reply") {
                    nativeAvatar(activity)?.running == true
                }
                val preparingAvatar = checkNotNull(nativeAvatar(activity)).bounds
                check(preparingAvatar.width() == 32 && preparingAvatar.height() == 32)
                check(item(name).visibleBounds.left - preparingAvatar.right == 8)
                check(!device.hasObject(action))
                ScreenshotCapture.capture("01-preparing.png")

                await("live output subscription") { realtime.target.value?.runId == HISTORY_RUN }
                val replyAt = Instant.now().toString()
                realtime.output(
                    RunOutputSignal.Delta(
                        SessionOutputDelta(CHAT_PERSONAL, HISTORY_RUN, replyId, "reply-header", replyAt, 0, reply)
                    )
                )
                val bodyBounds = item(body).visibleBounds
                val nameBounds = item(name).visibleBounds
                val overflow = checkNotNull(
                    generateSequence(item(action)) { it.parent }.firstOrNull { it.isClickable }
                )
                val target = overflow.visibleBounds
                check(target.width() == 48 && target.height() == 48) { "Reply action bounds $target" }
                await("visible native avatar animation") { nativeAvatar(activity)?.running == true }
                val avatar = checkNotNull(nativeAvatar(activity)).bounds
                check(avatar.width() == 32 && avatar.height() == 32) { "Avatar bounds $avatar" }
                check(nameBounds.left - avatar.right == 8 && avatar.centerY() == target.centerY()) {
                    "Name $nameBounds, avatar $avatar, and overflow $target"
                }
                val frame = pixels(avatar)
                await("two different rendered foreground frames") {
                    val next = pixels(avatar)
                    next.indices.count { frame[it] != next[it] } >= 8
                }
                ScreenshotCapture.capture("02-replying.png")

                setMotion("0")
                await("static avatar while reduced motion is enabled") { nativeAvatar(activity) == null }
                check(item(name).visibleBounds == nameBounds && item(body).visibleBounds == bodyBounds)
                ScreenshotCapture.capture("03-reduced-motion.png")
                setMotion("1")
                await("animation resumes with motion enabled") { nativeAvatar(activity)?.running == true }

                val persisted = historyEventWire(
                    replyId, 3, payload = """{"content":${JsonPrimitive(reply)}}""", createdAt = replyAt,
                )
                val completion = historyEventWire(
                    eventId(4), 4, type = "run.completed", payload = "null", createdAt = Instant.now().toString(),
                )
                val finished = listOf(queuedInput, firstInput, persisted, completion)
                fixture.setHistoryEvents(CHAT_PERSONAL, finished)
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_PERSONAL)))
                await("settled run stops animation") {
                    realtime.target.value == null && device.hasObject(body) &&
                        nativeAvatar(activity) == null
                }
                check(item(name).visibleBounds.left == nameBounds.left)
                ScreenshotCapture.capture("04-completed.png")
                val settledButton = item(action).visibleBounds
                check(device.click(settledButton.centerX() + 22, settledButton.centerY()))
                item(By.text(app.getString(R.string.conversation_copy_reply)))
                ScreenshotCapture.capture("05-reply-menu.png")
                check(device.pressBack())
                await("dismissed reply menu") {
                    !device.hasObject(By.text(app.getString(R.string.conversation_copy_reply)))
                }

                // The reply body still intersects the viewport after its header scrolls above it.
                val nextRun = "abababab-abab-4bab-8bab-abababababab"
                val nextInput = inputEvent(5, nextRun, "Give me the full review notes.")
                val tail = "End of the review notes."
                val longReply = List(26) { "Review note ${it + 1} confirms the launch checks." }
                    .plus(tail).joinToString("\n\n")
                val nextReply = historyEventWire(
                    eventId(6), 6, payload = """{"content":${JsonPrimitive(longReply)}}""", run = nextRun,
                    createdAt = Instant.now().toString(),
                )
                fixture.setHistoryEvents(CHAT_PERSONAL, finished + listOf(nextInput, nextReply))
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_PERSONAL)))
                await("a live turn with a visible tail and an offscreen avatar") {
                    realtime.target.value?.runId == nextRun &&
                        device.hasObject(By.text(tail)) && nativeAvatar(activity) == null
                }
            }
        }

    private fun inputEvent(
        seq: Long,
        run: String?,
        text: String,
        revoke: String? = null,
        createdAt: String = Instant.now().toString(),
    ) =
        historyEventWire(
            eventId(seq), seq, type = "input.prompt",
            payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]}}""",
            run = run,
            revoke = revoke,
            createdAt = createdAt,
        )

    private fun eventId(seq: Long) = "cccccccc-cccc-4ccc-8ccc-${seq.toString().padStart(12, '0')}"

    private fun nativeAvatar(activity: ActivityScenario<MainActivity>): NativeAvatar? {
        var result: NativeAvatar? = null
        activity.onActivity {
            val view = findAnimatedAvatar(it.window.decorView) ?: return@onActivity
            val xy = IntArray(2)
            view.getLocationOnScreen(xy)
            result = NativeAvatar(
                Rect(xy[0], xy[1], xy[0] + view.width, xy[1] + view.height),
                (view.drawable as AnimatedVectorDrawable).isRunning,
            )
        }
        return result
    }

    private fun findAnimatedAvatar(view: View): ImageView? {
        if (view is ImageView && view.drawable is AnimatedVectorDrawable) return view
        return (view as? ViewGroup)?.children?.firstNotNullOfOrNull(::findAnimatedAvatar)
    }

    private fun pixels(bounds: Rect): IntArray {
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try {
            val width = bounds.width()
            val height = bounds.height()
            return IntArray(width * height).also {
                bitmap.getPixels(it, 0, width, bounds.left, bounds.top, width, height)
            }
        } finally {
            bitmap.recycle()
        }
    }

    private fun item(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "No node for $selector" }

    private fun await(expected: String, condition: () -> Boolean) {
        val ready = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) = try {
                condition()
            } catch (_: StaleObjectException) {
                false
            }
        }
        if (device.wait(ready, 12_000)) return
        val hierarchy = ByteArrayOutputStream()
        device.dumpWindowHierarchy(hierarchy)
        ScreenshotCapture.capture("diagnostic-reply-header.png")
        error("Timed out waiting for $expected. ${hierarchy.toString(Charsets.UTF_8.name())}")
    }

    private fun setMotion(value: String) {
        if (value == "null") device.executeShellCommand("settings delete global animator_duration_scale")
        else device.executeShellCommand("settings put global animator_duration_scale $value")
    }

    private fun displayOverride(kind: String) =
        device.executeShellCommand("wm $kind").lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(": ")?.trim() ?: "reset"

    private fun withFixture(test: (ChatListApiFixture, TestRealtimeService) -> Unit) {
        val size = displayOverride("size")
        val density = displayOverride("density")
        val scale = device.executeShellCommand("settings get global animator_duration_scale").trim()
        val font = device.executeShellCommand("settings get system font_scale").trim()
        val auth = app.authentication as TestAuthentication
        val identity = auth.state.value
        val previousChat = app.chatService
        val previousComposer = app.composerService
        val previousControls = app.controlService
        val previousRealtime = app.realtimeService
        val initialPreferences = app.initialPreferences
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { fixture ->
            val realtime = TestRealtimeService()
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.controlService = fixture.service
            app.realtimeService = realtime
            app.initialPreferences = testPreferences().copy(theme = UserPreferencesTheme.LIGHT)
            auth.state.value = testAuthenticationState(user = "reply-avatar-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                setMotion("1")
                test(fixture, realtime)
            } finally {
                val restorations = listOf(
                    runCatching { auth.state.value = identity },
                    runCatching { cache.restore() },
                    runCatching {
                        app.chatService = previousChat
                        app.composerService = previousComposer
                        app.controlService = previousControls
                        app.realtimeService = previousRealtime
                        app.initialPreferences = initialPreferences
                        app.restoreApiPreferences(preferences)
                    },
                    runCatching { device.executeShellCommand("wm size $size") },
                    runCatching { device.executeShellCommand("wm density $density") },
                    runCatching {
                        if (font == "null") device.executeShellCommand("settings delete system font_scale")
                        else device.executeShellCommand("settings put system font_scale $font")
                    },
                    runCatching { setMotion(scale) },
                )
                restorations.forEach { it.getOrThrow() }
            }
        }
    }
}
