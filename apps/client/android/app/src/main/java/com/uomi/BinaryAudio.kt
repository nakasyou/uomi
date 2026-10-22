package com.uomi

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/** Versioned BLOB format; encoded Opus packets are copied, never re-encoded. */
object BinaryAudio {
    fun pack(raw: String, summary: String): Pair<String, ByteArray> {
        val record = JSONObject(raw)
        val frames = record.getJSONArray("frames")
        record.remove("frames")
        val index = JSONObject(summary)
        val packed = JSONObject().put("binaryAudio", 1).put("record", record)
        for (name in
            listOf("frameCount", "frameDurationMs", "frameDurations", "idPrefix", "frameIds")) if (
            index.has(name)
        )
            packed.put(name, index.get(name))
        val output = ByteArrayOutputStream()
        val offsets = JSONArray()
        val extras = JSONArray()
        var offset = 0.0
        var irregular = false
        var hasExtras = false
        for (i in 0 until frames.length()) {
            val frame = frames.getJSONObject(i)
            val bytes = Base64.decode(frame.getString("data"), Base64.DEFAULT)
            require(bytes.size <= 65535)
            output.write(bytes.size and 255)
            output.write(bytes.size shr 8)
            output.write(bytes)
            val original = frame.getDouble("offsetMs")
            offsets.put(original)
            if (original != offset) irregular = true
            offset += frame.getDouble("durationMs")
            val extra = JSONObject(frame.toString())
            for (name in listOf("id", "data", "durationMs", "offsetMs")) extra.remove(name)
            extras.put(extra)
            if (extra.length() > 0) hasExtras = true
        }
        if (irregular) packed.put("offsets", offsets)
        if (hasExtras) packed.put("extras", extras)
        return packed.toString() to output.toByteArray()
    }

    fun unpack(raw: String, bytes: ByteArray): String {
        val packed = JSONObject(raw)
        if (packed.optInt("binaryAudio") != 1) return raw
        val record = packed.getJSONObject("record")
        val frames = JSONArray()
        var position = 0
        var offset = 0.0
        for (i in 0 until packed.getInt("frameCount")) {
            require(position + 2 <= bytes.size) { "Truncated binary audio" }
            val size =
                (bytes[position].toInt() and 255) or ((bytes[position + 1].toInt() and 255) shl 8)
            position += 2
            require(position + size <= bytes.size) { "Truncated binary audio" }
            val duration =
                if (packed.has("frameDurationMs")) packed.getDouble("frameDurationMs")
                else packed.getJSONArray("frameDurations").getDouble(i)
            val id =
                if (packed.has("idPrefix")) packed.getString("idPrefix") + i
                else packed.getJSONArray("frameIds").getString(i)
            val frame = packed.optJSONArray("extras")?.optJSONObject(i) ?: JSONObject()
            frame
                .put("id", id)
                .put(
                    "data",
                    Base64.encodeToString(
                        bytes.copyOfRange(position, position + size),
                        Base64.NO_WRAP,
                    ),
                )
                .put("durationMs", duration)
                .put("offsetMs", packed.optJSONArray("offsets")?.getDouble(i) ?: offset)
            frames.put(frame)
            position += size
            offset += duration
        }
        require(position == bytes.size) { "Unexpected binary audio bytes" }
        return record.put("frames", frames).toString()
    }

    fun duration(bytes: ByteArray): Double {
        require(bytes.isNotEmpty())
        val toc = bytes[0].toInt() and 255
        val config = toc shr 3
        val per =
            if (config >= 16) 2.5 * (1 shl (config and 3))
            else if (config >= 12) 10.0 * (1 shl (config and 1))
            else doubleArrayOf(10.0, 20.0, 40.0, 60.0)[config and 3]
        val code = toc and 3
        require(code != 3 || bytes.size >= 2)
        val n = if (code == 0) 1 else if (code == 3) bytes[1].toInt() and 63 else 2
        require(n > 0 && per * n <= 120) { "Invalid Opus packet duration" }
        return per * n
    }

    private val formatter =
        object : ThreadLocal<SimpleDateFormat>() {
            override fun initialValue() =
                SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                    timeZone = TimeZone.getTimeZone("UTC")
                }
        }

    private fun iso(ms: Long): String = formatter.get()!!.format(Date(ms))

    data class Prepared(
        val key: String,
        val metadata: String,
        val index: String,
        val bytes: ByteArray,
    )

    fun recording(
        device: String,
        ring: String?,
        sequence: Long,
        bytes: ByteArray,
    ): Pair<String, String> {
        val result = prepare(device, ring, sequence, bytes)
        return result.key to unpack(result.metadata, result.bytes)
    }

    fun prepare(
        device: String,
        ring: String?,
        sequence: Long,
        bytes: ByteArray,
    ): Prepared {
        require(bytes.size == 444)
        val hash = MessageDigest.getInstance("SHA-256")
        hash.update(
            "${ring ?: "legacy"}:${RingStream.format(sequence)}:".toByteArray(Charsets.UTF_8)
        )
        hash.update(bytes)
        val hashBytes = hash.digest()
        val digits = "0123456789abcdef"
        val digest =
            String(
                CharArray(hashBytes.size * 2) { i ->
                    val byte = hashBytes[i / 2].toInt() and 255
                    digits[if (i % 2 == 0) byte shr 4 else byte and 15]
                }
            )
        val escaped =
            device.toByteArray(Charsets.UTF_8).joinToString("") {
                val b = it.toInt() and 255
                if (b in 65..90 || b in 97..122 || b in 48..57 || "-_.!~*'()".contains(b.toChar()))
                    b.toChar().toString()
                else "%" + "0123456789ABCDEF"[b shr 4] + "0123456789ABCDEF"[b and 15]
            }
        val key = "record:$escaped:$digest"
        val timestamp = java.nio.ByteBuffer.wrap(bytes).int.toLong() and 0xffffffffL
        val utc = timestamp > 0 && timestamp and 0x80000000L == 0L
        val durations = JSONArray()
        val output = ByteArrayOutputStream()
        var position = 4
        var total = 0.0
        while (position < 443) {
            val n = bytes[position].toInt() and 255
            if (n == 0) {
                position++
                continue
            }
            if (position + 1 + n >= 444) break
            val packet = bytes.copyOfRange(position + 1, position + 1 + n)
            val duration = duration(packet)
            durations.put(duration)
            total += duration
            output.write(n and 255)
            output.write(n shr 8)
            output.write(packet)
            position += n + 1
        }
        val record =
            JSONObject()
                .put("key", key)
                .put("deviceId", device)
                .put("ringId", ring ?: JSONObject.NULL)
                .put("sequence", RingStream.format(sequence))
                .put("capturedAt", if (utc) iso(timestamp * 1000) else JSONObject.NULL)
                .put("timestampRaw", timestamp)
                .put("timing", if (utc) "device-utc" else "device-uptime")
                .put("uploaded", 0)
                .put("bytes", 444)
                .put("receivedAt", iso(System.currentTimeMillis()))
        val index =
            JSONObject(record.toString())
                .put("frameCount", durations.length())
                .put("durationMs", total)
        val stored =
            JSONObject()
                .put("binaryAudio", 1)
                .put("record", record)
                .put("frameCount", durations.length())
        if (durations.length() > 0) {
            val prefix = "$device:$digest:"
            index.put("idPrefix", prefix)
            stored.put("idPrefix", prefix)
        } else {
            index.put("frameIds", JSONArray())
            stored.put("frameIds", JSONArray())
        }
        val duration = if (durations.length() > 0) durations.getDouble(0) else 20.0
        if ((0 until durations.length()).all { durations.getDouble(it) == duration }) {
            index.put("frameDurationMs", duration)
            stored.put("frameDurationMs", duration)
        } else {
            index.put("frameDurations", durations)
            stored.put("frameDurations", durations)
        }
        return Prepared(key, stored.toString(), index.toString(), output.toByteArray())
    }
}
