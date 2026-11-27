package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.RecoveryApiFixture
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.time.Instant
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun failureWithoutReply() =
        capture(
            R.string.run_failure_provider_image_too_large_title,
            "failure-before-reply.png",
            historyEventWire(
                id = "65bb4399-e841-4de2-80c5-a7272c46478d",
                seq = 2,
                type = "output.error",
                payload = """{"error":"Older image error"}""",
            ),
            RecoveryApiFixture.failure("provider_image_too_large", seq = 3),
        )

    @Test
    fun stoppedWithoutReply() =
        capture(
            R.string.history_cancelled,
            "stopped-before-reply.png",
            historyEventWire(
                id = "83d804c6-33a8-49b2-b326-f3f340d5120e",
                seq = 2,
                type = "control.interrupt",
                payload = "null",
            ),
            historyEventWire(
                id = "c38e2498-bc59-4183-b295-e6d3a872ab3e",
                seq = 3,
                type = "run.cancelled",
                payload = "null",
            ),
        )

    @Test
    fun usageFailureShowsRecoveryAccountDetails() =
        capture(
            R.string.run_failure_usage_limit_title,
            "recovery-account-details.png",
            RecoveryApiFixture.failure("usage_limit"),
        )

    @Test
    fun failedTurnKeepsItsPartialReply() {
        val reply = "I reviewed the layout. The title and image margins match the draft."
        val start = Instant.parse(CHAT_DATE)
        capture(
            R.string.run_failure_provider_stream_timeout_title,
            "failure-after-reply.png",
            historyEventWire(
                id = "13f64e90-8346-4059-8767-52afe409c696",
                seq = 2,
                payload = """{"content":"$reply"}""",
                createdAt = start.plusSeconds(35).toString(),
            ),
            historyEventWire(
                id = "64c29433-15e2-47e8-83d6-59aa79b44c83",
                seq = 3,
                type = "output.error",
                payload = """{"error":"Agent execution timed out after 120 seconds"}""",
                createdAt = start.plusSeconds(42).toString(),
            ),
            RecoveryApiFixture.failure("provider_request_timeout", seq = 4)
                .replace(CHAT_DATE, start.plusSeconds(46).toString()),
            reply = reply,
        )
    }

    private fun capture(label: Int, filename: String, vararg feedback: String, reply: String? = null) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousRecovery = app.recoveryService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val preferences = app.snapshotApiPreferences()
        fun displayOverride(setting: String): String =
            Regex("Override \\w+: (\\S+)").find(device.executeShellCommand("wm $setting"))
                ?.groupValues?.get(1) ?: "reset"
        val size = displayOverride("size")
        val density = displayOverride("density")
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun await(value: String) =
            checkNotNull(device.wait(Until.findObject(text(value)), 12_000)) {
                val hierarchy = ByteArrayOutputStream()
                device.dumpWindowHierarchy(hierarchy)
                "Missing $value\n$hierarchy"
            }
        ChatListApiFixture().use { fixture ->
            val usageFailure = label == R.string.run_failure_usage_limit_title
            val loadRecovery = usageFailure || reply != null
            val rows =
                listOf(
                    historyEventWire(
                        id = "915697dd-1b9b-4f5b-87a3-4840f224624b",
                        seq = 1,
                        type = "input.prompt",
                        payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Review the launch image."}]}}""",
                    ),
                    *feedback,
                )
            fixture.setHistoryEvents(CHAT_PERSONAL, rows)
            if (loadRecovery) {
                val history = fixture.historyRows
                RecoveryApiFixture(fixture)
                fixture.historyRows = history
            }
            if (usageFailure) {
                fixture.events = { request ->
                    if (request.requestUrl?.queryParameter("sinceSeqId") != null)
                        jsonResponse("""{"events":[],"hasMore":false}""")
                    else {
                        val chat = chatEventWire().replace(
                            "\"selectedModel\":null", "\"selectedModel\":\"gpt-recovery\"",
                        )
                        jsonResponse("""{"events":[$chat],"hasMore":false}""")
                    }
                }
            }
            try {
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("wm density 160")
                app.chatService = fixture.service
                if (loadRecovery) app.recoveryService = fixture.service
                auth.state.value = testAuthenticationState()
                ActivityScenario.launch(MainActivity::class.java).use {
                    await("Personal chat").click()
                    val labelText = app.getString(label)
                    val status = await(labelText)
                    val okou = app.getString(R.string.app_name)
                    val header = await(okou)
                    check(device.findObjects(text(okou)).size == 1)
                    check(device.findObjects(text(labelText)).size == 1)
                    check(header.visibleBounds.bottom < status.visibleBounds.top)
                    if (reply != null) {
                        val body = await(reply)
                        check(header.visibleBounds.bottom < body.visibleBounds.top)
                        check(body.visibleBounds.bottom < status.visibleBounds.top)
                        await(app.getString(R.string.recovery_continue))
                        check(!device.hasObject(text(app.getString(R.string.recovery_read_failed))))
                    }
                    if (label == R.string.run_failure_provider_image_too_large_title) {
                        await(app.getString(R.string.run_failure_provider_image_too_large_description))
                        check(!device.hasObject(text("Older image error")))
                    }
                    if (usageFailure) {
                        val account = await(app.getString(R.string.recovery_account))
                        val email = await("fixture@example.test")
                        check(abs(email.visibleBounds.left - account.visibleBounds.right - 8) <= 1)
                        check(abs(email.visibleBounds.top - account.visibleBounds.top) <= 1)
                        await(app.getString(R.string.recovery_reset_time))
                        await(app.getString(R.string.recovery_credits))
                        await(app.getString(R.string.recovery_reset))
                    }
                    ScreenshotCapture.capture(filename)
                }
            } finally {
                device.executeShellCommand("wm size $size")
                device.executeShellCommand("wm density $density")
                auth.state.value = previousAuth
                app.chatService = previousChats
                app.recoveryService = previousRecovery
                app.restoreApiPreferences(preferences)
                cache.restore()
            }
        }
    }
}
