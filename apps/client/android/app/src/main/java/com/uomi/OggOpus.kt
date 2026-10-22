package com.uomi

import java.io.ByteArrayOutputStream

object OggOpus {
    fun mux(packets: List<ByteArray>): ByteArray {
        require(packets.isNotEmpty()) { "This recording contains no audio." }
        val output = ByteArrayOutputStream()
        var sequence = 0
        fun page(packet: ByteArray, granule: Long, flags: Int) {
            val segments = packet.size / 255 + 1
            require(segments <= 255) { "Audio packet is too large." }
            val bytes = ByteArray(27 + segments + packet.size)
            val header = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            header.put("OggS".toByteArray(Charsets.US_ASCII))
            header.put(5, flags.toByte())
            header.putLong(6, granule)
            header.putInt(14, 1)
            header.putInt(18, sequence++)
            bytes[26] = segments.toByte()
            for (i in 0 until segments) bytes[27+i] = minOf(255, packet.size-i*255).toByte()
            packet.copyInto(bytes, 27 + segments)
            var crc = 0
            for (byte in bytes) {
                crc = crc xor ((byte.toInt() and 255) shl 24)
                repeat(8) { crc = (crc shl 1) xor (if (crc < 0) 0x04c11db7 else 0) }
            }
            header.putInt(22, crc)
            output.write(bytes)
        }
        val head = ByteArray(19)
        "OpusHead".toByteArray(Charsets.US_ASCII).copyInto(head)
        head[8] = 1; head[9] = 1
        java.nio.ByteBuffer.wrap(head).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(12, 16000)
        page(head, 0, 2)
        val tags = ByteArray(16)
        "OpusTags".toByteArray(Charsets.US_ASCII).copyInto(tags)
        page(tags, 0, 0)
        var granule = 0L
        for ((i, packet) in packets.withIndex()) {
            require(packet.isNotEmpty()) { "Empty Opus frame." }
            val toc = packet[0].toInt() and 255
            val config = toc shr 3
            val per = if (config >= 16) 2.5 * (1 shl (config and 3)) else if (config >= 12) 10.0 * (1 shl (config and 1)) else doubleArrayOf(10.0,20.0,40.0,60.0)[config and 3]
            val code = toc and 3
            require(code != 3 || packet.size >= 2) { "Truncated Opus frame." }
            val count = if (code == 0) 1 else if (code == 3) packet[1].toInt() and 63 else 2
            require(count > 0 && per * count <= 120) { "Invalid Opus packet duration." }
            granule += (per * count * 48).toLong()
            page(packet, granule, if (i == packets.size-1) 4 else 0)
        }
        return output.toByteArray()
    }
}
