package ai.okou.android.chat

internal fun ConfirmedChat.effectivePinOrder(): String {
    pinOrder?.let {
        return it
    }
    val reversed = 8_640_000_000_000_000L - chatTime(checkNotNull(pinnedAt))
    return "a0${reversed.toString().padStart(17, '0')}1"
}

internal data class ChatPinOrderUpdate(val threadId: String, val pinOrder: String)

/** Matches the base-62 fractional indexing used by the chat API and other clients. */
internal object ChatPinOrder {
    private const val digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    private const val maxKeyLength = 2048
    private val smallestInteger = "A" + "0".repeat(26)

    fun first(threads: List<ConfirmedChat>): String {
        val upper =
            threads
                .asSequence()
                .filter { it.pinnedAt != null }
                .map { it.effectivePinOrder() }
                .minOrNull()
        return keyBetween(null, upper)
    }

    fun move(
        threads: List<ConfirmedChat>,
        threadId: String,
        targetId: String,
        before: Boolean,
    ): List<ChatPinOrderUpdate> {
        if (threadId == targetId) return emptyList()
        val ranked =
            threads
                .asSequence()
                .filter { it.pinnedAt != null }
                .map { ChatPinOrderUpdate(it.id, it.effectivePinOrder()) }
                .sortedWith(
                    compareBy<ChatPinOrderUpdate> { it.pinOrder }.thenByDescending { it.threadId }
                )
                .toMutableList()
        val original = ranked.indexOfFirst { it.threadId == threadId }
        if (original < 0) return emptyList()
        ranked.removeAt(original)
        val target = ranked.indexOfFirst { it.threadId == targetId }
        if (target < 0) return emptyList()
        val insertion = if (before) target else target + 1
        if (insertion == original) return emptyList()
        val left = ranked.getOrNull(insertion - 1)?.pinOrder
        val right = ranked.getOrNull(insertion)?.pinOrder
        if (left == null || left != right) {
            return listOf(ChatPinOrderUpdate(threadId, keyBetween(left, right)))
        }
        // Open the insertion gap by moving only the tied suffix to higher keys.
        var end = insertion
        while (ranked.getOrNull(end)?.pinOrder == left) end++
        val ids = listOf(threadId) + ranked.subList(insertion, end).map { it.threadId }
        return ids.zip(
            keysBetween(left, ranked.getOrNull(end)?.pinOrder, ids.size),
            ::ChatPinOrderUpdate,
        )
    }

    private fun keyBetween(lower: String?, upper: String?): String {
        require(lower == null || upper == null || lower < upper)
        return generateKey(lower, upper).also { require(it.length <= maxKeyLength) }
    }

    private fun generateKey(lower: String?, upper: String?): String {
        if (lower == null) {
            if (upper == null) return "a0"
            val integer = integerPart(upper)
            return when {
                integer == smallestInteger ->
                    integer + midpoint("", upper.substring(integer.length))
                integer.length < upper.length -> integer
                else -> {
                    val previous = requireNotNull(stepInteger(integer, -1))
                    // The reserved smallest integer is only valid with a fraction.
                    if (previous == smallestInteger) previous + midpoint("", null) else previous
                }
            }
        }
        val lowerInteger = integerPart(lower)
        val lowerFraction = lower.substring(lowerInteger.length)
        if (upper == null)
            return stepInteger(lowerInteger, 1) ?: lowerInteger + midpoint(lowerFraction, null)
        val upperInteger = integerPart(upper)
        if (lowerInteger == upperInteger) {
            return lowerInteger + midpoint(lowerFraction, upper.substring(upperInteger.length))
        }
        val incremented = requireNotNull(stepInteger(lowerInteger, 1))
        return if (incremented < upper) incremented
        else lowerInteger + midpoint(lowerFraction, null)
    }

    private fun keysBetween(lower: String, upper: String?, count: Int): List<String> {
        if (count == 0) return emptyList()
        if (upper == null)
            return buildList(count) {
                var previous = lower
                repeat(count) {
                    previous = keyBetween(previous, null)
                    add(previous)
                }
            }
        val middle = count / 2
        val pivot = keyBetween(lower, upper)
        return keysBetween(lower, pivot, middle) +
            pivot +
            keysBetween(pivot, upper, count - middle - 1)
    }

    private fun midpoint(lower: String, upper: String?): String = buildString {
        var ceiling = upper
        var index = 0
        while (true) {
            val low = lower.getOrNull(index)?.let(digits::indexOf) ?: 0
            val high = ceiling?.get(index)?.let(digits::indexOf) ?: digits.length
            when {
                low == high -> append(digits[low])
                high - low > 1 -> {
                    append(digits[(low + high + 1) / 2])
                    break
                }
                ceiling != null && index < ceiling.lastIndex -> {
                    append(ceiling[index])
                    break
                }
                else -> {
                    append(digits[low])
                    ceiling = null
                }
            }
            index++
        }
    }

    private fun stepInteger(integer: String, step: Int): String? {
        val chars = integer.toCharArray()
        val edge = if (step > 0) '0' else 'z'
        for (index in chars.lastIndex downTo 1) {
            val next = digits.indexOf(chars[index]) + step
            if (next in digits.indices) {
                chars[index] = digits[next]
                return chars.concatToString()
            }
            chars[index] = edge
        }
        val head = chars[0]
        return when {
            step > 0 && head == 'Z' -> "a0"
            step < 0 && head == 'a' -> "Zz"
            step > 0 && head == 'z' || step < 0 && head == 'A' -> null
            else -> {
                val next = head + step
                next + edge.toString().repeat(integerLength(next) - 1)
            }
        }
    }

    private fun integerPart(key: String): String {
        require(key.length in 2..maxKeyLength && key != smallestInteger)
        val length = integerLength(key[0])
        require(key.length >= length && key.drop(1).all { it in digits })
        require(key.length == length || key.last() != '0')
        return key.substring(0, length)
    }

    private fun integerLength(head: Char): Int =
        when (head) {
            in 'a'..'z' -> head - 'a' + 2
            in 'A'..'Z' -> 'Z' - head + 2
            else -> throw IllegalArgumentException("Invalid pin order")
        }
}
