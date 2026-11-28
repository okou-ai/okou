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
import android.graphics.Color
import android.graphics.Point
import android.graphics.Rect
import android.graphics.drawable.AnimatedVectorDrawable
import android.view.View
import android.view.ViewConfiguration
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
import kotlin.math.abs
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
    fun replyAvatarUsesTheNativeAnimationOnlyWhileTheVisibleTurnIsReplying() =
        withFixture { fixture, realtime ->
            val firstInput = inputEvent(
                1, HISTORY_RUN, "Please put the launch tasks in review order.",
                createdAt = Instant.now().minusSeconds(70).toString(),
            )
            val text = "Start with the launch checklist."
            val reply = "$text\n\n1. Review the home page.\n2. Confirm the email copy.\n3. Check the channel links."
            val replyId = eventId(2)
            val name = By.text(app.getString(R.string.app_name))
            val action = By.desc(app.getString(R.string.conversation_reply_actions))
            val body = By.textContains(text)
            fixture.setHistoryEvents(CHAT_PERSONAL, listOf(firstInput))

            ActivityScenario.launch(MainActivity::class.java).use { activity ->
                device.awaitChatList(app)
                item(By.text("Personal chat")).click()
                item(By.text(app.getString(R.string.conversation_processing)))
                item(name)
                check(!device.hasObject(action) && nativeAvatar(activity) == null)
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
                    replyId, 2, payload = """{"content":${JsonPrimitive(reply)}}""", createdAt = replyAt,
                )
                val completion = historyEventWire(
                    eventId(3), 3, type = "run.completed", payload = "null", createdAt = Instant.now().toString(),
                )
                val finished = listOf(firstInput, persisted, completion)
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
                val nextInput = inputEvent(4, nextRun, "Give me the full review notes.")
                val tail = "End of the review notes."
                val longReply = List(26) { "Review note ${it + 1} confirms the launch checks." }
                    .plus(tail).joinToString("\n\n")
                val nextReply = historyEventWire(
                    eventId(5), 5, payload = """{"content":${JsonPrimitive(longReply)}}""", run = nextRun,
                    createdAt = Instant.now().toString(),
                )
                fixture.setHistoryEvents(CHAT_PERSONAL, finished + listOf(nextInput, nextReply))
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_PERSONAL)))
                await("a live turn with a visible tail and an offscreen avatar") {
                    realtime.target.value?.runId == nextRun &&
                        device.hasObject(By.text(tail)) && nativeAvatar(activity) == null
                }
                checkClippedStop(By.text(tail))
            }
        }

    private fun checkClippedStop(tail: BySelector) {
        val stop = By.desc(app.getString(R.string.controls_stop)).enabled(true)
        val viewport = item(By.pkg(app.packageName).scrollable(true)).visibleBounds
        val inline = item(stop).visibleBounds
        check(inline.centerY() in viewport.centerY() until viewport.bottom) {
            "Expected inline Stop at the reading edge. Stop $inline, viewport $viewport"
        }
        val distanceFromTail = inline.centerY() - item(tail).visibleBounds.bottom
        val desiredCenter = viewport.bottom - 4
        dragViewport(viewport, desiredCenter - inline.centerY())

        fun glyphCenter() = item(tail).visibleBounds.bottom + distanceFromTail
        val measuredCenter = glyphCenter()
        if (abs(measuredCenter - desiredCenter) > 4) {
            dragViewport(viewport, desiredCenter - measuredCenter)
        }
        await("one full toolbar Stop above a partially visible inline glyph") {
            val current = device.findObjects(stop)
            current.size == 1 && current.single().visibleBounds.bottom <= viewport.top &&
                viewport.bottom - glyphCenter() in 0..8
        }
        val center = glyphCenter()
        val clip = Rect(inline.centerX() - 9, center - 9, inline.centerX() + 10, viewport.bottom)
        val strip = pixels(clip)
        val reference = pixels(Rect(clip.right + 5, clip.top, clip.right + 6, clip.bottom))
        check(strip.indices.count { index ->
            val color = strip[index]
            val background = reference[index / clip.width()]
            Color.red(background) - Color.red(color) >= 12
        } >= 6) { "The visible part of the inline Stop glyph was not painted in $clip" }
        ScreenshotCapture.capture("06-stop-clipped.png")

        dragViewport(viewport, inline.centerY() - center - 20)
        await("one complete inline Stop after returning to the reading edge") {
            val current = device.findObjects(stop)
            current.size == 1 && current.single().visibleBounds == inline
        }
    }

    private fun dragViewport(viewport: Rect, distance: Int) {
        val slop = ViewConfiguration.get(app).scaledTouchSlop
        val extra = if (distance > 0) slop else -slop
        val from = Point(viewport.centerX(), viewport.centerY())
        val to = Point(from.x, from.y + distance + extra)
        check(device.swipe(arrayOf(from, to, to), 35))
    }

    private fun inputEvent(seq: Long, run: String, text: String, createdAt: String = Instant.now().toString()) =
        historyEventWire(
            eventId(seq), seq, type = "input.prompt",
            payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]}}""",
            run = run,
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
