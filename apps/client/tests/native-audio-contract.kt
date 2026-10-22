// Standalone JVM contract check. Uses the real native helpers and a Base64 shim only.
package com.uomi

import java.nio.ByteBuffer
import org.json.JSONArray
import org.json.JSONObject

fun main() {
    val bytes = ByteArray(444)
    ByteBuffer.wrap(bytes).putInt(1767225600)
    bytes[4] = 3
    bytes[5] = 248.toByte()
    bytes[6] = 255.toByte()
    bytes[7] = 254.toByte()
    val (key, raw) = BinaryAudio.recording("E1:4C", null, 7, bytes)
    val record = JSONObject(raw)
    check(record.getString("capturedAt") == "2026-01-01T00:00:00.000Z")
    check(key.startsWith("record:E1%3A4C:"))
    val frame = record.getJSONArray("frames").getJSONObject(0)
    check(frame.getString("data") == "+P/+" && frame.getDouble("durationMs") == 20.0)
    val summary =
        JSONObject()
            .put("frameCount", 1)
            .put("frameDurationMs", 20)
            .put("idPrefix", frame.getString("id").removeSuffix("0"))
    val (metadata, packed) = BinaryAudio.pack(raw, summary.toString())
    check(packed.contentEquals(byteArrayOf(3, 0, 248.toByte(), 255.toByte(), 254.toByte())))
    check(!metadata.contains("+P/+"))
    check(JSONObject(BinaryAudio.unpack(metadata, packed)).similar(record))
    check(runCatching { BinaryAudio.unpack(metadata, packed.copyOf(4)) }.isFailure)
    val irregular = JSONObject(raw)
    val second =
        JSONObject(frame.toString())
            .put("id", "different")
            .put("durationMs", 10)
            .put("offsetMs", 25)
            .put("custom", "kept")
    irregular.getJSONArray("frames").put(second)
    val descriptors =
        JSONObject()
            .put("frameCount", 2)
            .put("frameDurations", JSONArray().put(20).put(10))
            .put("frameIds", JSONArray().put(frame.getString("id")).put("different"))
    val (m, b) = BinaryAudio.pack(irregular.toString(), descriptors.toString())
    check(JSONObject(BinaryAudio.unpack(m, b)).similar(irregular))
    val begin = ByteBuffer.allocate(13).put(5.toByte()).putLong(7).putInt(2).array()
    val done = ByteBuffer.allocate(10).put(4.toByte()).put(0.toByte()).putLong(9).array()
    val stream = RingStream(7, 2)
    check(runCatching { stream.accept(byteArrayOf(3, 0)) }.isFailure)
    stream.accept(begin)
    check(runCatching { stream.accept(done) }.isFailure)
    val all = bytes + bytes
    val records = mutableListOf<Pair<Long, ByteArray>>()
    for (piece in all.asList().chunked(19)) records.addAll(
        stream.accept(byteArrayOf(3) + piece.toByteArray())
    )
    check(records.size == 2 && records[0].first == 7L && records[1].first == 8L)
    check(records.all { it.second.contentEquals(bytes) })
    stream.accept(done)
    check(stream.done)
    check(runCatching { stream.accept(byteArrayOf(3, 0)) }.isFailure)
    check(RingStream.format(RingStream.parse("18446744073709551615")) == "18446744073709551615")
    check(runCatching { RingStream(-1, 2) }.isFailure)
    println(
        "Native Android binary round trips, irregular timing, framing, range validation and unsigned identities passed"
    )
}
