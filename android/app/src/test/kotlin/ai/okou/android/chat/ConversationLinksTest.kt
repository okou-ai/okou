package ai.okou.android.chat

import ai.okou.android.CHAT_IN_PROJECT
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationLinksTest {
    @Test
    fun canonicalConversationUrlsKeepTheirReadingTarget() {
        assertEquals(
            ConversationLink.Chat(CHAT_IN_PROJECT, MessageLinkAnchor("event+target", false)),
            conversationLink("/chats/$CHAT_IN_PROJECT?from=chat#event-event%2Btarget"),
        )
        assertEquals(
            ConversationLink.Chat(CHAT_IN_PROJECT, MessageLinkAnchor("run-id", true)),
            conversationLink("https://app.okou.ai/chats/$CHAT_IN_PROJECT/#run-run-id"),
        )
    }

    @Test
    fun onlyTrustedExactRoutesOpenInsideTheApp() {
        for (value in
            listOf(
                "https://app.okou.ai.example.org/chats/$CHAT_IN_PROJECT",
                "https://app.okou.ai/attachments/../chats/$CHAT_IN_PROJECT",
                "https://app.okou.ai/chats/$CHAT_IN_PROJECT/settings",
            )) {
            assertEquals(ConversationLink.Web(value.toHttpUrl()), conversationLink(value))
        }
        for (value in
            listOf(
                "//app.okou.ai/chats/$CHAT_IN_PROJECT",
                "https://user@app.okou.ai/chats/$CHAT_IN_PROJECT",
                "https://@app.okou.ai/chats/$CHAT_IN_PROJECT",
                "file:///sdcard/report.html",
                "intent://app.okou.ai",
                "https:app.okou.ai",
            )) {
            assertNull(value, conversationLink(value))
        }
    }
}
