package com.uomi

import java.nio.ByteBuffer

/** Strict streaming decoder, independent of Android, SQLite and bridge serialization. */
class RingStream(private val start: Long, private val count: Int) {
    companion object {
        fun parse(value: String): Long {
            val number = java.math.BigInteger(value)
            require(number.signum() >= 0 && number.bitLength() <= 64) { "Invalid ring sequence" }
            return number.toLong()
        }

        fun format(value: Long): String =
            if (value >= 0) value.toString()
            else java.math.BigInteger(1, ByteBuffer.allocate(8).putLong(value).array()).toString()

        fun compare(a: Long, b: Long): Int = (a xor Long.MIN_VALUE).compareTo(b xor Long.MIN_VALUE)
    }

    private val end = start + count
    private var sequence = start
    private var begun = false
    private var tail = byteArrayOf()
    var done = false
        private set

    init {
        require(count in 1..1024 && compare(end, start) > 0)
    }

    fun accept(message: ByteArray): List<Pair<Long, ByteArray>> {
        check(!done) { "Audio arrived after DONE" }
        require(message.isNotEmpty())
        val records = mutableListOf<Pair<Long, ByteArray>>()
        when (message[0].toInt()) {
            5 -> {
                check(!begun && message.size >= 13) { "Invalid ring range" }
                val b = ByteBuffer.wrap(message)
                check(b.getLong(1) == start && b.getInt(9) == count) {
                    "Device recording range changed"
                }
                begun = true
            }
            3 -> {
                check(begun) { "Audio arrived before its range" }
                val bytes = tail + message.copyOfRange(1, message.size)
                var pos = 0
                while (bytes.size - pos >= 444) {
                    check(compare(sequence, end) < 0) { "Too many ring packets" }
                    records.add(sequence++ to bytes.copyOfRange(pos, pos + 444))
                    pos += 444
                }
                tail = bytes.copyOfRange(pos, bytes.size)
            }
            4 -> {
                check(
                    begun &&
                        message.size >= 10 &&
                        message[1].toInt() == 0 &&
                        ByteBuffer.wrap(message).getLong(2) == end &&
                        sequence == end &&
                        tail.isEmpty()
                ) {
                    "Incomplete Bluetooth transfer; committed audio is retained"
                }
                done = true
            }
            else -> error("Unexpected bulk notification")
        }
        return records
    }
}
