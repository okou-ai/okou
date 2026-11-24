package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.RecoveryApiFixture
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureFailedReplyRecovery() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val oldRecovery = app.recoveryService
        val oldComposer = app.composerService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val releaseCatalog = CountDownLatch(1)
        val releaseCheck = CountDownLatch(1)
        ChatListApiFixture().use { api ->
            val remote = RecoveryApiFixture(api)
            remote.set(RecoveryApiFixture.input(), RecoveryApiFixture.failure())
            api.historyCatchUp = { MockResponse().setResponseCode(503) }
            api.events = { request ->
                val wire = chatEventWire(thread = CHAT_PERSONAL)
                    .replace("\"selectedModel\":null", "\"selectedModel\":\"gpt-recovery\"")
                val events = if (request.requestUrl?.queryParameter("sinceSeqId") == null) wire else ""
                jsonResponse("""{"events":[$events],"hasMore":false}""")
            }
            val command = api.commandResponse
            api.commandResponse = { request ->
                if (request.requestUrl?.encodedPath == "/api/model-catalog") {
                    check(releaseCatalog.await(25, TimeUnit.SECONDS))
                }
                command(request)
            }
            remote.reset = { MockResponse().setResponseCode(503) }
            app.chatService = api.service
            app.recoveryService = api.service
            app.composerService = api.service
            auth.state.value = testAuthenticationState(user = "recovery-capture-${UUID.randomUUID()}")
            try {
                ActivityScenario.launch(MainActivity::class.java).use {
                    try {
                        device.awaitChatList(app)
                        awaitText("Personal chat").click()
                        awaitText(app.getString(R.string.recovery_loading))
                        awaitText(app.getString(R.string.run_failure_usage_limit_title))
                        ScreenshotCapture.capture("01-loading.png")
                        releaseCatalog.countDown()

                        val resetLabel = app.getString(R.string.recovery_reset)
                        awaitText(resetLabel).click()
                        val confirmation = app.getString(
                            R.string.recovery_reset_confirmation,
                            "fixture@example.test",
                        )
                        awaitText(confirmation)
                        ScreenshotCapture.capture("02-confirmation.png")
                        awaitText(app.getString(R.string.settings_cancel)).click()
                        check(remote.resets.isEmpty())
                        awaitText(resetLabel).click()
                        val explanation = awaitText(confirmation).visibleBounds
                        val cancel = awaitText(app.getString(R.string.settings_cancel)).visibleBounds
                        val resetAction = device.findObjects(By.text(resetLabel)).single { node ->
                            val bounds = node.visibleBounds
                            bounds.top >= explanation.bottom &&
                                bounds.top < cancel.bottom &&
                                bounds.bottom > cancel.top
                        }
                        resetAction.click()
                        awaitText(app.getString(R.string.recovery_reset_unknown))
                        check(remote.resets.size == 1)
                        check(!device.hasObject(By.text(app.getString(R.string.composer_request_failed))))
                        ScreenshotCapture.capture("03-unknown.png")

                        remote.reset = {
                            check(releaseCheck.await(25, TimeUnit.SECONDS))
                            jsonResponse("""{"outcome":"alreadyRedeemed"}""")
                        }
                        awaitText(app.getString(R.string.recovery_reset_retry)).click()
                        awaitText(app.getString(R.string.recovery_checking_reset))
                        ScreenshotCapture.capture("04-checking.png")
                        releaseCheck.countDown()
                        awaitText(app.getString(R.string.recovery_submitted))
                        check(remote.resets.size == 2)
                        check(remote.resets[0] == remote.resets[1])
                        check(remote.inputs.size == 1)
                    } finally {
                        releaseCatalog.countDown()
                        releaseCheck.countDown()
                    }
                }
            } finally {
                try {
                    cache.restore()
                } finally {
                    app.chatService = oldService
                    app.recoveryService = oldRecovery
                    app.composerService = oldComposer
                    auth.state.value = oldAuth
                }
            }
        }
    }

    private fun awaitText(text: String) =
        checkNotNull(device.wait(Until.findObject(By.text(text)), 15_000)) {
            "Did not observe the expected text: $text"
        }
}
