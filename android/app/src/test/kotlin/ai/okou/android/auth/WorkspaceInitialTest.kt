package ai.okou.android.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WorkspaceInitialTest {
    @Test
    fun takesTheSameInitialAsWeb() {
        val cases =
            mapOf(
                "Acme Inc" to "A",
                "okou team" to "O",
                "  élan studio" to "É",
                "123 Labs" to "1",
                "字节跳动" to "字",
                "한국 팀" to "한",
                "ßeta GmbH" to "ß",
                "🚀 Launch Team" to "L",
                "workspace-design" to "W",
            )
        cases.forEach { (name, initial) -> assertEquals(name, initial, workspaceInitial(name)) }
    }

    @Test
    fun leavesGeneratedAndLetterlessNamesToTheTexture() {
        listOf("workspace-3f9a2c1d", "👋🎉", "   ", "").forEach {
            assertNull(it, workspaceInitial(it))
        }
    }

    @Test
    fun setsCjkInitialsSmallerThanLatin() {
        assertEquals(0.5f, workspaceInitialScale("A"))
        assertEquals(0.44f, workspaceInitialScale("字"))
        assertEquals(0.44f, workspaceInitialScale("한"))
    }

    @Test
    fun selectsTheSameColorwayAsWebAndIos() {
        assertEquals(2, workspaceColorway("org_one"))
        assertEquals(0, workspaceColorway("org_two"))
        assertEquals(2, workspaceColorway("org_设计😀"))
    }
}
