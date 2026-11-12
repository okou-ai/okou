package ai.okou.android

import java.io.File

/** Native acceptance restores every cache file it may replace or evict, including timestamps. */
class ChatCacheSnapshot(private val directory: File) {
    private val existed = directory.exists()

    private data class Saved(val name: String, val bytes: ByteArray, val modified: Long)

    private val files =
        directory.listFiles().orEmpty().map {
            check(it.isFile)
            Saved(it.name, it.readBytes(), it.lastModified())
        }

    fun restore() {
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
