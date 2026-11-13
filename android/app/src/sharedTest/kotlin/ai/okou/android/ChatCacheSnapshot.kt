package ai.okou.android

import ai.okou.android.chat.ChatCacheStore
import java.io.File
import kotlinx.coroutines.runBlocking

/** Checkpoint/close SQLite before copying files, and restore only after its consumers stop. */
class ChatCacheSnapshot(private val directory: File, private val cache: ChatCacheStore) {
    init {
        runBlocking { cache.close() }
    }

    private val existed = directory.exists()

    private data class Saved(val name: String, val bytes: ByteArray, val modified: Long)

    private val files =
        directory.listFiles().orEmpty().map {
            check(it.isFile)
            Saved(it.name, it.readBytes(), it.lastModified())
        }

    fun restore() {
        runBlocking { cache.close() }
        directory.listFiles().orEmpty().forEach { check(it.delete()) }
        if (existed) {
            check(directory.isDirectory || directory.mkdirs())
            files.forEach { saved ->
                directory.resolve(saved.name).apply {
                    writeBytes(saved.bytes)
                    check(setLastModified(saved.modified))
                }
            }
        } else if (directory.exists()) check(directory.delete())
    }
}
