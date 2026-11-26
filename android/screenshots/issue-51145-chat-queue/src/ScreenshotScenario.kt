package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.historyEventWire
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.regex.Pattern
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun openQueueRetainsItsReadingPositionInPhoneShortAndWideLayouts() {
        val originalSize = displayOverride("size")
        val originalDensity = displayOverride("density")
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChats = app.chatService
        val oldComposer = app.composerService
        val oldControls = app.controlService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)

        ChatListApiFixture().use { fixture ->
            fixture.setHistoryEvents(CHAT_PERSONAL, history())
            try {
                device.executeShellCommand("wm density 160")
                resize(412, 892)
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.controlService = fixture.service
                auth.state.value = testAuthenticationState(user = "queue-adaptive-capture")
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    find(text("Personal chat"), "personal chat").click()
                    val replyTop = find(text(reply), "transcript reply").visibleBounds.top
                    val count = app.getString(R.string.conversation_queue_count, samples.size)
                    val trigger = By.pkg(app.packageName).desc(count)
                    find(trigger, "queue button").click()
                    val queue = By.pkg(app.packageName).desc(app.getString(R.string.conversation_queue))
                    condition("The queue sheet has reached its phone layout") {
                        device.findObject(queue)?.visibleBounds?.width() == 380 &&
                            device.findObject(text(count)) != null
                    }
                    repeat(2) { find(queue, "phone queue list").scroll(Direction.DOWN, 0.62f) }
                    val labels = Pattern.compile(samples.joinToString("|") { Pattern.quote(it.label) })
                    val phoneQueue = find(queue, "phone queue list after scrolling")
                    val listTop = phoneQueue.visibleBounds.top
                    val anchor = phoneQueue.findObjects(By.text(labels))
                        .filter { it.visibleBounds.top > listTop + 4 }
                        .minByOrNull { it.visibleBounds.top }
                        ?.text ?: error("Missing a visible queue row")
                    check(samples.indexOfFirst { it.label == anchor } in 5..19) {
                        "The phone queue did not reach the middle of the list: $anchor"
                    }
                    ScreenshotCapture.capture("queue-phone.png")

                    resize(412, 450)
                    condition("Short full-screen queue did not retain $anchor near the top") {
                        val title = device.findObject(text(count))?.visibleBounds
                        title != null && title.top < 96 && anchored(queue, anchor, 380)
                    }
                    ScreenshotCapture.capture("queue-short.png")

                    resize(900, 860)
                    condition("Wide centered queue did not retain $anchor near the top") {
                        anchored(queue, anchor, 428)
                    }
                    ScreenshotCapture.capture("queue-wide.png")

                    resize(412, 892)
                    condition("Restored phone queue did not retain $anchor near the top") {
                        anchored(queue, anchor, 380)
                    }
                    check(device.pressBack())
                    check(device.wait(Until.gone(text(count)), 15_000)) { "Queue remained open after Back" }
                    find(trigger, "queue button after dismissal")
                    check(find(text(reply), "transcript reply after dismissal").visibleBounds.top == replyTop) {
                        "The transcript moved after opening, resizing and closing the queue"
                    }
                }
            } finally {
                app.chatService = oldChats
                app.composerService = oldComposer
                app.controlService = oldControls
                auth.state.value = oldAuth
                app.restoreApiPreferences(preferences)
                cache.restore()
                device.executeShellCommand("wm size $originalSize")
                device.executeShellCommand("wm density $originalDensity")
            }
        }
    }

    private fun anchored(queue: BySelector, label: String, width: Int): Boolean {
        val list = device.findObject(queue)?.visibleBounds ?: return false
        val row = device.findObject(text(label))?.visibleBounds ?: return false
        return list.width() == width && row.top in list.top until list.top + 144 && row.height() > 0
    }

    private fun history(): List<String> = listOf(
        historyEventWire(id = id(1), seq = 1, type = "input.prompt", payload = prompt("Prepare the launch handoff.")),
        historyEventWire(id = id(2), seq = 2, payload = """{"content":${JsonPrimitive(reply)}}"""),
    ) + samples.mapIndexed { index, sample ->
        val sequence = index + 3
        historyEventWire(
            id = id(sequence),
            seq = sequence.toLong(),
            type = if (sample.automation) "input.automation" else "input.prompt",
            payload = if (sample.automation) {
                """{"userMessage":{"version":1,"parts":[{"type":"automation","workflowName":${JsonPrimitive(sample.label)},"automationBrief":"Scheduled trigger"}]}}"""
            } else prompt(sample.label),
            run = null,
        )
    }

    private fun prompt(label: String) =
        """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(label)}}]}}"""

    private fun id(sequence: Int) = "51145000-0000-4000-8000-${sequence.toString().padStart(12, '0')}"

    private fun text(label: String) = By.pkg(app.packageName).text(label)

    private fun find(selector: BySelector, label: String): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 15_000)) { "Missing $label" }

    private fun condition(label: String, predicate: () -> Boolean) {
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean = predicate()
        }, 15_000)) { label }
    }

    private fun resize(width: Int, height: Int) {
        device.executeShellCommand("wm size ${width}x${height}")
        condition("Expected ${width}x${height} display") {
            device.displayWidth == width && device.displayHeight == height
        }
    }

    private fun displayOverride(property: String) =
        device.executeShellCommand("wm $property").lineSequence()
            .firstOrNull { it.startsWith("Override") }?.substringAfter(':')?.trim() ?: "reset"

    private data class Entry(val label: String, val automation: Boolean = false)

    private companion object {
        const val reply = "The launch checklist is ready for the handoff."
        val samples = listOf(
            Entry("Review the launch copy"),
            Entry("Check the welcome email"),
            Entry("Morning brief", automation = true),
            Entry("Collect partner feedback"),
            Entry("Verify the campaign links"),
            Entry("Summarize open approvals"),
            Entry("Build the launch checklist"),
            Entry("Verify the audience list"),
            Entry("Campaign status digest", automation = true),
            Entry("Review the product notes"),
            Entry("Validate the landing page"),
            Entry("Draft the support update"),
            Entry("Review the release notes"),
            Entry("Campaign link monitor", automation = true),
            Entry("Prepare the team handoff"),
            Entry("Check the tracking links"),
            Entry("Summarize the launch risks"),
            Entry("Write the final reminder"),
            Entry("Daily launch summary", automation = true),
            Entry("Verify the launch calendar"),
            Entry("Prepare the customer FAQ"),
            Entry("Share the final assets"),
            Entry("Review the support guide"),
            Entry("Update the partner brief"),
            Entry("Prepare the recap email"),
            Entry("Review the reporting plan"),
            Entry("Check the press materials"),
            Entry("Send an internal summary"),
        )
    }
}
