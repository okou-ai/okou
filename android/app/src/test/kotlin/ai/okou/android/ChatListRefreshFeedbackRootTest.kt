package ai.okou.android

import ai.okou.android.chat.ChatReadPhase
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = ChatListApplication::class)
internal class ChatListRefreshFeedbackRootTest : ChatListRootTestFixture() {
    @Test
    fun emptyInboxWaitsForProjectsAndRecoversFromTheirFirstFailure() {
        val app = compose.activity.application as ChatListApplication
        val finishProjects = CountDownLatch(1)
        app.fixture.events = { jsonResponse("""{"events":[],"hasMore":false}""") }
        app.fixture.projects = {
            check(finishProjects.await(10, TimeUnit.SECONDS))
            MockResponse().setResponseCode(400)
        }
        val loading = hasContentDescription(app.getString(R.string.chat_loading))
        val inboxEmpty = compose.onNodeWithText(app.getString(R.string.chat_empty))
        val filter = compose.onNodeWithContentDescription("Filter")
        val newChat = compose.onNodeWithText(app.getString(R.string.composer_new))
        val failure = hasTestTag("content-read-failure-illustration")

        try {
            app.responseGate.countDown()
            compose.waitUntil(10_000) { currentList()?.confirmedAt != null }
            compose.waitUntilExactlyOneExists(loading, 5_000)
            inboxEmpty.assertDoesNotExist()
            filter.performClick()
            compose.onNodeWithText("Archived").performClick()
            compose.onNodeWithText("No archived chats").assertIsDisplayed()
            compose.onNodeWithText("Back to Inbox").performClick()

            finishProjects.countDown()
            compose.waitUntilExactlyOneExists(failure, 5_000)
            compose.onNode(failure).assertIsDisplayed()
            compose.onNode(loading).assertDoesNotExist()
            inboxEmpty.assertDoesNotExist()
            newChat.assertIsDisplayed()
            compose
                .onNodeWithText(app.getString(R.string.chat_metadata_unavailable))
                .assertDoesNotExist()

            app.fixture.projects = {
                jsonResponse("""{"projects":[],"latestEventId":null,"latestSeqId":0}""")
            }
            refreshWorkspaceChats()
            compose.waitUntilExactlyOneExists(hasText(app.getString(R.string.chat_empty)), 5_000)
            inboxEmpty.assertIsDisplayed()
            compose.onNode(failure).assertDoesNotExist()
        } finally {
            finishProjects.countDown()
        }
    }

    @Test
    fun aTerminalIndicatorFailureNotifiesWhenTheFirstListArrives() {
        val app = compose.activity.application as ChatListApplication
        val finishList = CountDownLatch(1)
        val listEvents = app.fixture.events
        app.fixture.events = { request ->
            check(finishList.await(10, TimeUnit.SECONDS))
            listEvents(request)
        }
        app.fixture.indicators = { MockResponse().setResponseCode(400) }
        val message = app.getString(R.string.chat_refresh_failed)
        val snackbar = hasText(message) and hasAnyAncestor(hasTestTag("chat_list_feedback"))

        try {
            app.responseGate.countDown()
            compose.waitUntil(10_000) { currentList()?.indicatorsPhase == ChatReadPhase.Failed }
            assertNull(currentList()?.confirmedAt)
            compose.onNodeWithText(message).assertDoesNotExist()

            finishList.countDown()
            awaitListAndNames()
            compose.onNodeWithText("Personal chat").assertIsDisplayed()
            compose.waitUntilExactlyOneExists(snackbar, 5_000)
            compose.onNode(snackbar).assertIsDisplayed()
        } finally {
            finishList.countDown()
        }
    }

    @Test
    fun aLateProjectFailureDoesNotNotifyAfterReturningToTheList() {
        val app = compose.activity.application as ChatListApplication
        app.responseGate.countDown()
        awaitListAndNames()
        val started = CountDownLatch(1)
        val finishProject = CountDownLatch(1)
        app.fixture.projectEvents = {
            started.countDown()
            check(finishProject.await(10, TimeUnit.SECONDS))
            MockResponse().setResponseCode(400)
        }
        val message = app.getString(R.string.chat_metadata_unavailable)
        val snackbar = hasText(message) and hasAnyAncestor(hasTestTag("chat_list_feedback"))

        try {
            refreshWorkspaceChats()
            compose.waitUntil(10_000) { started.count == 0L }
            compose.onNodeWithText("Personal chat").performClick()
            compose.onNodeWithTag("conversation").assertIsDisplayed()
            compose.onNodeWithTag("chat_list").assertDoesNotExist()
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithText("Personal chat").assertIsDisplayed()

            finishProject.countDown()
            compose.waitUntil(10_000) { currentList()?.projectsPhase == ChatReadPhase.Failed }
            compose.onNodeWithText(message).assertDoesNotExist()

            refreshWorkspaceChats()
            compose.waitUntilExactlyOneExists(snackbar, 5_000)
            compose.onNode(snackbar).assertIsDisplayed()
        } finally {
            finishProject.countDown()
        }
    }
}
