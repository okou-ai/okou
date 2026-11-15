package ai.okou.android.updates

fun isAndroidVersion(version: String): Boolean =
    version.length <= 64 && Regex("[0-9]+\\.[0-9]+\\.[0-9]+").matches(version)

/** Stable x.y.z policy ordering, independent of Android's internal APK versionCode. */
fun compareAndroidVersions(left: String, right: String): Int? {
    if (!isAndroidVersion(left) || !isAndroidVersion(right)) return null
    val rightParts = right.split('.')
    for ((index, part) in left.split('.').withIndex()) {
        val value = part.trimStart('0')
        val other = rightParts[index].trimStart('0')
        val comparison =
            value.length.compareTo(other.length).takeIf { it != 0 } ?: value.compareTo(other)
        if (comparison != 0) return comparison.compareTo(0)
    }
    return 0
}
