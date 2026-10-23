package com.uomi

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.*
import android.database.sqlite.SQLiteDatabase
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.*
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.work.*
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.*
import java.util.zip.DeflaterOutputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

class UomiPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(UomiModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}

@SuppressLint("MissingPermission")
class UomiModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
    override fun getName() = "Uomi"

    private val executor = Executors.newSingleThreadExecutor()
    private val audioWorkers = Executors.newFixedThreadPool(2)
    private val networkWorkers = Executors.newFixedThreadPool(6)
    private val db =
        SQLiteDatabase.openOrCreateDatabase(
                context.getDatabasePath("uomi.sqlite").also { it.parentFile?.mkdirs() },
                null,
            )
            .apply {
                enableWriteAheadLogging()
                execSQL("PRAGMA synchronous=FULL")
                execSQL("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                execSQL(
                    "CREATE TABLE IF NOT EXISTS recording_audio (key TEXT PRIMARY KEY,data BLOB NOT NULL)"
                )
                execSQL(
                    "CREATE TABLE IF NOT EXISTS record_index (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
                )
                execSQL(
                    "CREATE TABLE IF NOT EXISTS notion_index (key TEXT PRIMARY KEY,target TEXT NOT NULL,device TEXT NOT NULL,start REAL)"
                )
                execSQL(
                    "CREATE INDEX IF NOT EXISTS notion_time ON notion_index(target,start,device)"
                )
                execSQL("CREATE INDEX IF NOT EXISTS notion_target_order ON notion_index(target,start DESC,key DESC)")
            }
    private val adapter
        get() =
            (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
                ?: error("No Bluetooth adapter available.")

    private var gatt: BluetoothGatt? = null
    @Volatile private var latch: CountDownLatch? = null
    @Volatile private var answer: ByteArray = byteArrayOf()
    @Volatile private var failure: String? = null

    @Volatile private var importQueue: ArrayBlockingQueue<ByteArray>? = null
    @Volatile private var importCancelled = false
    private val cancelledImports = java.util.Collections.synchronizedSet(LinkedHashSet<String>())
    @Volatile private var negotiatedMtu = 23
    @Volatile private var txPhy = 0
    @Volatile private var rxPhy = 0

    private fun operation(p: Promise, worker: Executor = executor, fn: () -> Any?) {
        worker.execute {
            try {
                p.resolve(fn())
            } catch (e: Exception) {
                p.reject("UOMI", e.message ?: "Operation failed", e)
            }
        }
    }

    @ReactMethod
    fun muxAudio(json: String, p: Promise) =
        operation(p, audioWorkers) {
            val frames = org.json.JSONArray(json)
            val packets =
                (0 until frames.length()).map {
                    Base64.decode(frames.getJSONObject(it).getString("data"), Base64.DEFAULT)
                }
            Base64.encodeToString(OggOpus.mux(packets), Base64.NO_WRAP)
        }

    private fun storedValue(key: String, raw: String, bytes: ByteArray?): String {
        if (!key.startsWith("record:") || JSONObject(raw).optInt("binaryAudio") != 1) return raw
        check(bytes != null) { "Missing binary audio" }
        return BinaryAudio.unpack(raw, bytes)
    }

    private fun getValue(key: String): String? =
        db.rawQuery("SELECT k.value,a.data FROM kv k LEFT JOIN recording_audio a ON a.key=k.key WHERE k.key=?", arrayOf(key)).use {
            if (!it.moveToFirst()) null else storedValue(key, it.getString(0), if (it.isNull(1)) null else it.getBlob(1))
        }

    private fun recordIndex(raw: String): String {
        val record = JSONObject(raw)
        val frames = record.getJSONArray("frames")
        val durations = org.json.JSONArray()
        val ids = org.json.JSONArray()
        var total = 0.0
        var sameDuration = true
        val firstDuration =
            if (frames.length() > 0) frames.getJSONObject(0).getDouble("durationMs") else 20.0
        val firstId = if (frames.length() > 0) frames.getJSONObject(0).getString("id") else ""
        val prefix = firstId.removeSuffix("0")
        var commonIds = firstId.endsWith("0")
        for (i in 0 until frames.length()) {
            val frame = frames.getJSONObject(i)
            val duration = frame.getDouble("durationMs")
            val id = frame.getString("id")
            total += duration
            durations.put(duration)
            ids.put(id)
            if (duration != firstDuration) sameDuration = false
            if (id != prefix + i) commonIds = false
        }
        record.remove("frames")
        record.put("frameCount", frames.length()).put("durationMs", total)
        if (sameDuration) record.put("frameDurationMs", firstDuration)
        else record.put("frameDurations", durations)
        if (commonIds) record.put("idPrefix", prefix) else record.put("frameIds", ids)
        return record.toString()
    }

    private fun putValue(key: String, value: String) {
        val stored =
            if (key.startsWith("record:")) {
                val summary = recordIndex(value)
                val packed = BinaryAudio.pack(value, summary)
                val previous =
                    db.rawQuery("SELECT data FROM recording_audio WHERE key=?", arrayOf(key)).use {
                        if (it.moveToFirst()) it.getBlob(0) else null
                    }
                if (previous == null || !previous.contentEquals(packed.second))
                    db.execSQL(
                        "INSERT OR REPLACE INTO recording_audio VALUES (?,?)",
                        arrayOf(key, packed.second),
                    )
                db.execSQL(
                    "INSERT OR REPLACE INTO record_index VALUES (?,?)",
                    arrayOf(key, summary),
                )
                packed.first
            } else value
        db.execSQL("INSERT OR REPLACE INTO kv VALUES (?,?)", arrayOf(key, stored))
        if (key.startsWith("notion:page:")) {
            val page = JSONObject(value)
            val props = page.getJSONObject("properties")
            val text = props.optJSONObject("Device")?.optJSONArray("rich_text")?.optJSONObject(0)
            val device =
                text?.optJSONObject("text")?.optString("content")
                    ?: text?.optString("plain_text")
                    ?: ""
            val start =
                props.optJSONObject("Recorded at")?.optJSONObject("date")?.optString("start") ?: ""
            db.execSQL(
                "INSERT OR REPLACE INTO notion_index VALUES (?,?,?,(julianday(?)-2440587.5)*86400000)",
                arrayOf(key, key.split(":")[2], device, start),
            )
        }
    }

    @ReactMethod
    fun getMany(json: String, p: Promise) = operation(p) {
        val requested = org.json.JSONArray(json)
        require(requested.length() <= 256) { "Too many storage keys" }
        val keys = (0 until requested.length()).map { requested.getString(it) }
        val values = mutableMapOf<String, String>()
        if (keys.isNotEmpty()) {
            val placeholders = keys.joinToString(",") { "?" }
            db.rawQuery("SELECT k.key,k.value,a.data FROM kv k LEFT JOIN recording_audio a ON a.key=k.key WHERE k.key IN ($placeholders)", keys.toTypedArray()).use {
                while (it.moveToNext()) {
                    val key = it.getString(0)
                    values[key] = storedValue(key, it.getString(1), if (it.isNull(2)) null else it.getBlob(2))
                }
            }
        }
        val out = Arguments.createArray()
        for (key in keys) values[key]?.let { value ->
            val entry = Arguments.createMap()
            entry.putString("key", key); entry.putString("value", value); out.pushMap(entry)
        }
        out
    }

    @ReactMethod
    fun acknowledgeAudio(json: String, p: Promise) = operation(p) {
        val updates = org.json.JSONArray(json)
        require(updates.length() <= 256) { "Too many acknowledgement updates" }
        db.beginTransaction()
        try {
            for (i in 0 until updates.length()) {
                val update = updates.getJSONObject(i)
                val key = update.getString("key")
                val target = update.getString("target")
                val uploaded = update.getInt("uploaded")
                require(key.startsWith("record:") && uploaded >= 0) { "Invalid acknowledgement" }
                db.rawQuery("SELECT k.value,i.value FROM kv k JOIN record_index i ON i.key=k.key WHERE k.key=?", arrayOf(key)).use {
                    check(it.moveToFirst()) { "Missing source recording metadata" }
                    val stored = JSONObject(it.getString(0))
                    val summary = JSONObject(it.getString(1))
                    require(uploaded <= summary.getInt("frameCount")) { "Acknowledgement exceeds source frames" }
                    if (summary.optString("notionTarget") == target && summary.optInt("uploaded") > uploaded) return@use
                    summary.put("uploaded", uploaded).put("notionTarget", target)
                    val record = if (stored.optInt("binaryAudio") == 1) stored.getJSONObject("record") else stored
                    record.put("uploaded", uploaded).put("notionTarget", target)
                    db.execSQL("UPDATE kv SET value=? WHERE key=? AND value!=?", arrayOf(stored.toString(), key, stored.toString()))
                    db.execSQL("UPDATE record_index SET value=? WHERE key=? AND value!=?", arrayOf(summary.toString(), key, summary.toString()))
                }
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        null
    }

    @ReactMethod
    fun mirrorEntries(json: String, p: Promise) =
        operation(p) {
            val request = JSONObject(json)
            val countOnly=request.optBoolean("countOnly")
            val selected=if(countOnly)"COUNT(*)" else "k.value"
            val sql=StringBuilder("SELECT $selected FROM notion_index i JOIN kv k ON k.key=i.key WHERE i.target=?")
            val args = mutableListOf(request.getString("target"))
            if (request.has("from")) {
                sql.append(" AND (i.start IS NULL OR i.start>=?)")
                args.add((request.getDouble("from") - 900000).toString())
            }
            if (request.has("until")) {
                sql.append(" AND (i.start IS NULL OR i.start<=?)")
                args.add(request.getDouble("until").toString())
            }
            val devices = request.optJSONArray("devices")
            if (devices != null && devices.length() > 0) {
                sql.append(" AND i.device IN (")
                    .append((0 until devices.length()).joinToString(",") { "?" })
                    .append(")")
                for (i in 0 until devices.length()) args.add(devices.getString(i))
            }
            if (request.has("search")) {
                sql.append(" AND instr(lower(k.value),lower(?))>0")
                args.add(request.getString("search"))
            }
            if(countOnly)return@operation db.rawQuery(sql.toString(),args.toTypedArray()).use {it.moveToFirst();it.getInt(0)}
            sql.append(" ORDER BY i.start DESC,i.key DESC LIMIT ? OFFSET ?")
            args.add(request.optInt("limit", 1000).coerceIn(1, 10000).toString())
            args.add(request.optInt("offset", 0).coerceAtLeast(0).toString())
            val out = Arguments.createArray()
            db.rawQuery(sql.toString(), args.toTypedArray()).use {
                while (it.moveToNext()) out.pushString(it.getString(0))
            }
            out
        }

    @ReactMethod
    fun optimizeAudio(p: Promise) =
        operation(p) {
            val rows = mutableListOf<Pair<String, String>>()
            db.rawQuery(
                    "SELECT k.key,k.value FROM kv k LEFT JOIN recording_audio a ON a.key=k.key WHERE k.key>='record:' AND k.key<'record;' AND a.key IS NULL ORDER BY k.key LIMIT 128",
                    null,
                )
                .use { while (it.moveToNext()) rows.add(it.getString(0) to it.getString(1)) }
            db.beginTransaction()
            try {
                for ((key, value) in rows) putValue(key, value)
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            rows.size
        }

    @ReactMethod
    fun catalogEntries(after: String, p: Promise) =
        operation(p) {
            val out = Arguments.createArray()
            db.beginTransaction()
            try {
                db.rawQuery(
                        "SELECT k.key,CASE WHEN i.key IS NULL THEN k.value ELSE '' END,i.value FROM kv k LEFT JOIN record_index i ON k.key=i.key WHERE k.key>? AND k.key>='record:' AND k.key<'record;' ORDER BY k.key LIMIT 256",
                        arrayOf(after),
                    )
                    .use {
                        while (it.moveToNext()) {
                            val key = it.getString(0)
                            val summary =
                                if (!it.isNull(2)) it.getString(2)
                                else
                                    recordIndex(it.getString(1)).also { value ->
                                        db.execSQL(
                                            "INSERT OR REPLACE INTO record_index VALUES (?,?)",
                                            arrayOf(key, value),
                                        )
                                    }
                            val entry = Arguments.createMap()
                            entry.putString("key", key)
                            entry.putString("value", summary)
                            out.pushMap(entry)
                        }
                    }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            out
        }

    @ReactMethod
    fun batch(json: String, p: Promise) =
        operation(p) {
            val batch = JSONObject(json)
            db.beginTransaction()
            try {
                val puts = batch.getJSONArray("puts")
                for (i in 0 until puts.length()) {
                    val entry = puts.getJSONObject(i)
                    putValue(entry.getString("key"), entry.getString("value"))
                }
                val removes = batch.getJSONArray("removes")
                for (i in 0 until removes.length()) {
                    val key = removes.getString(i)
                    db.delete("kv", "key=?", arrayOf(key))
                    db.delete("record_index", "key=?", arrayOf(key))
                    db.delete("recording_audio", "key=?", arrayOf(key))
                    db.delete("notion_index", "key=?", arrayOf(key))
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            null
        }

    @ReactMethod fun get(key: String, p: Promise) = operation(p) { getValue(key) }

    @ReactMethod
    fun put(key: String, value: String, p: Promise) =
        operation(p) {
            db.beginTransaction()
            try {
                putValue(key, value)
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            null
        }

    @ReactMethod
    fun remove(key: String, p: Promise) =
        operation(p) {
            db.beginTransaction()
            try {
                db.delete("recording_audio", "key=?", arrayOf(key))
                db.delete("record_index", "key=?", arrayOf(key))
                db.delete("notion_index", "key=?", arrayOf(key))
                db.delete("kv", "key=?", arrayOf(key))
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            null
        }

    @ReactMethod
    fun list(prefix: String, p: Promise) =
        operation(p) {
            val out = Arguments.createArray()
            db.rawQuery(
                    "SELECT key FROM kv WHERE key>=? AND key<? ORDER BY key",
                    arrayOf(prefix, prefix + String(Character.toChars(0x10ffff))),
                )
                .use { while (it.moveToNext()) out.pushString(it.getString(0)) }
            out
        }

    @ReactMethod
    fun entries(prefix: String, after: String, p: Promise) =
        operation(p) {
            val out = Arguments.createArray()
            db.rawQuery(
                    "SELECT k.key,k.value,a.data FROM kv k LEFT JOIN recording_audio a ON a.key=k.key WHERE k.key>=? AND k.key<? AND k.key>? ORDER BY k.key LIMIT 256",
                    arrayOf(prefix, prefix + String(Character.toChars(0x10ffff)), after),
                )
                .use {
                    while (it.moveToNext()) {
                        val entry = Arguments.createMap()
                        entry.putString("key", it.getString(0))
                        entry.putString("value", storedValue(it.getString(0), it.getString(1), if (it.isNull(2)) null else it.getBlob(2)))
                        out.pushMap(entry)
                    }
                }
            out
        }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey("uomi.webhook", null) as? SecretKey)
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                "uomi.webhook",
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .build()
                    )
                }
                .generateKey()
    }

    private fun getSecret(name: String = "webhook"): String {
        val saved = getValue(if (name == "webhook") "secret" else "credential:$name") ?: return ""
        if (saved.isEmpty()) return ""
        val bytes = Base64.decode(saved, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }

    @ReactMethod fun secret(value: String?, p: Promise) = credential("webhook", value, p)

    @ReactMethod
    fun credential(name: String, value: String?, p: Promise) =
        operation(p) {
            require(name in listOf("webhook", "notion", "transcriber", "sites-api", "sites-access"))
            val storageKey = if (name == "webhook") "secret" else "credential:$name"
            if (value != null) {
                require(!value.contains('\r') && !value.contains('\n'))
                if (value.isEmpty()) putValue(storageKey, "")
                else {
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.ENCRYPT_MODE, key())
                    putValue(
                        storageKey,
                        Base64.encodeToString(
                            cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)),
                            Base64.NO_WRAP,
                        ),
                    )
                }
            }
            getSecret(name)
        }

    private fun notionCall(request: JSONObject): JSONObject {
        val path = request.getString("path")
        require(
            path.startsWith("/") &&
                !path.contains("..") &&
                !path.contains("://") &&
                !path.contains('?') &&
                !path.contains('#') &&
                !path.contains('\\')
        )
        val token = getSecret("notion")
        check(token.isNotEmpty()) { "Set a Notion connection token in Settings." }
        val connection = URL("https://api.notion.com/v1$path").openConnection() as HttpURLConnection
        try {
            val method = request.getString("method")
            require(method in listOf("GET", "POST", "PATCH"))
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 30000
            connection.readTimeout = 120000
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Notion-Version", "2025-09-03")
            val upload = request.optJSONObject("upload")
            var bytes: ByteArray? = null
            if (upload != null) {
                val boundary = "uomi-${UUID.randomUUID()}"
                val filename = upload.getString("filename").replace(Regex("[^a-zA-Z0-9._-]"), "_")
                val mime = upload.getString("contentType")
                require(!mime.contains('\r') && !mime.contains('\n'))
                connection.setRequestProperty(
                    "Content-Type",
                    "multipart/form-data; boundary=$boundary",
                )
                bytes =
                    ByteArrayOutputStream().use { out ->
                        if (upload.has("part"))
                            out.write(
                                "--$boundary\r\nContent-Disposition: form-data; name=\"part_number\"\r\n\r\n${upload.getInt("part")}\r\n"
                                    .toByteArray()
                            )
                        out.write(
                            "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$filename\"\r\nContent-Type: $mime\r\n\r\n"
                                .toByteArray()
                        )
                        out.write(Base64.decode(upload.getString("base64"), Base64.NO_WRAP))
                        out.write("\r\n--$boundary--\r\n".toByteArray())
                        out.toByteArray()
                    }
            } else if (request.has("body")) {
                connection.setRequestProperty("Content-Type", "application/json")
                bytes = request.get("body").toString().toByteArray(Charsets.UTF_8)
            }
            if (bytes != null) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            check(status in 200..299) {
                "Notion HTTP $status. Check permissions and retry. Retry after ${connection.getHeaderField("Retry-After") ?: "1"}s."
            }
            return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }

    @ReactMethod
    fun notion(request: String, p: Promise) =
        operation(p, networkWorkers) { notionCall(JSONObject(request)).toString() }

    @ReactMethod
    fun notionFile(pageId: String, property: String, fileUrl: String?, p: Promise) =
        operation(p, networkWorkers) {
            require(
                pageId.matches(Regex("[a-fA-F0-9-]{32,36}")) &&
                    property in listOf("Transcript", "Manifest")
            )
            val url =
                fileUrl
                    ?: run {
                        val page =
                            notionCall(
                                JSONObject().put("path", "/pages/$pageId").put("method", "GET")
                            )
                        page
                            .getJSONObject("properties")
                            .getJSONObject(property)
                            .getJSONArray("files")
                            .getJSONObject(0)
                            .getJSONObject("file")
                            .getString("url")
                    }
            require(url.startsWith("https://"))
            val c = URL(url).openConnection() as HttpURLConnection
            try {
                c.instanceFollowRedirects = false
                c.connectTimeout = 30000
                c.readTimeout = 120000
                check(c.responseCode in 200..299) { "Could not fetch Notion attachment" }
                val output = ByteArrayOutputStream()
                c.inputStream.use { input ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        check(output.size() + count <= 32 * 1024 * 1024) {
                            "Attachment is too large"
                        }
                        output.write(buffer, 0, count)
                    }
                }
                output.toString("UTF-8")
            } finally {
                c.disconnect()
            }
        }

    @ReactMethod
    fun verifyNotionAudio(url: String, expected: String, p: Promise) =
        operation(p, networkWorkers) {
            verifiedAudio(url, expected, false)
            null
        }

    @ReactMethod
    fun readNotionAudio(url: String, expected: String, p: Promise) =
        operation(p, networkWorkers) { verifiedAudio(url, expected, true) }

    private fun verifiedAudio(url: String, expected: String, download: Boolean): String? {
        val parsed = URL(url)
        require(parsed.protocol == "https" && parsed.userInfo == null) {
            "Invalid audio attachment URL"
        }
        val c = parsed.openConnection() as HttpURLConnection
        return try {
            c.instanceFollowRedirects = false
            c.connectTimeout = 15000
            c.readTimeout = 120000
            check(c.responseCode in 200..299) { "Could not verify audio; local audio is retained" }
            val digest = MessageDigest.getInstance("SHA-256")
            val audio = if (download) ByteArrayOutputStream() else null
            var length = 0L
            c.inputStream.use { input ->
                val buffer = ByteArray(65536)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    length += count
                    check(length <= 64L * 1024 * 1024) { "Audio verification limit exceeded" }
                    digest.update(buffer, 0, count)
                    audio?.write(buffer, 0, count)
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            check(actual == expected) {
                "Audio verification hash mismatch; local audio is retained"
            }
            audio?.let { Base64.encodeToString(it.toByteArray(), Base64.NO_WRAP) }
        } finally {
            c.disconnect()
        }
    }

    @ReactMethod
    fun transcriberReserve(endpoint: String, json: String, source: String, p: Promise) =
        operation(p, networkWorkers) {
            val base = URL(endpoint)
            require(base.protocol == "https" && base.userInfo == null)
            val url = URL(base, "reserve")
            val token = getSecret("transcriber")
            check(token.isNotEmpty()) { "Set a transcriber secret to coordinate uploads" }
            val c = url.openConnection() as HttpURLConnection
            try {
                c.instanceFollowRedirects = false
                c.requestMethod = "POST"
                c.connectTimeout = 15000
                c.readTimeout = 120000
                c.setRequestProperty("Authorization", "Bearer $token")
                c.setRequestProperty("Content-Type", "application/json")
                c.doOutput = true
                val body = JSONObject(json).put("source", source)
                c.outputStream.use { it.write(body.toString().toByteArray()) }
                check(c.responseCode in 200..299) {
                    "Upload coordinator is unavailable. Check its database and secret; local audio is retained."
                }
                val result = c.inputStream.use { it.bufferedReader().readText() }
                val id = JSONObject(result).getString("pageId")
                require(id.matches(Regex("[a-fA-F0-9-]{32,36}")))
                id
            } finally {
                c.disconnect()
            }
        }

    @ReactMethod
    fun transcriberNotify(endpoint: String, pageId: String, p: Promise) =
        operation(p, networkWorkers) {
            val url = URL(endpoint)
            require(url.protocol == "https" && url.userInfo == null)
            val token = getSecret("transcriber")
            check(token.isNotEmpty()) { "Set a transcriber API secret" }
            val c = url.openConnection() as HttpURLConnection
            try {
                c.instanceFollowRedirects = false
                c.requestMethod = "POST"
                c.connectTimeout = 15000
                c.readTimeout = 15000
                c.setRequestProperty("Authorization", "Bearer $token")
                c.setRequestProperty("Content-Type", "application/json")
                c.doOutput = true
                c.outputStream.use {
                    it.write(JSONObject().put("pageId", pageId).toString().toByteArray())
                }
                check(c.responseCode in 200..299) {
                    "Audio is in Notion; transcriber notification failed."
                }
                null
            } finally {
                c.disconnect()
            }
        }

    @ReactMethod
    fun hash(value: String, p: Promise) =
        operation(p) {
            MessageDigest.getInstance("SHA-256")
                .digest(Base64.decode(value, Base64.NO_WRAP))
                .joinToString("") { "%02x".format(it) }
        }

    @ReactMethod fun addListener(eventName: String) {}

    @ReactMethod fun removeListeners(count: Double) {}

    private fun finish(status: Int, value: ByteArray = byteArrayOf()) {
        if (status != BluetoothGatt.GATT_SUCCESS)
            failure =
                "Bluetooth operation failed ($status). Disconnect other clients and try again."
        answer = value
        latch?.countDown()
    }

    private val callback =
        object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    finish(status)
                    return
                }
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    negotiatedMtu = 23
                    txPhy = 0
                    rxPhy = 0
                    g.requestMtu(512)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    failure = "Omi disconnected. Move it closer and sync again."
                    latch?.countDown()
                }
            }

            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu
                g.discoverServices()
            }

            override fun onPhyUpdate(g: BluetoothGatt, tx: Int, rx: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    txPhy = tx
                    rxPhy = rx
                }
            }

            override fun onPhyRead(g: BluetoothGatt, tx: Int, rx: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    txPhy = tx
                    rxPhy = rx
                }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                finish(status)
            }

            @Deprecated("Legacy Android callback")
            override fun onCharacteristicRead(
                g: BluetoothGatt,
                c: BluetoothGattCharacteristic,
                status: Int,
            ) {
                if (Build.VERSION.SDK_INT < 33) finish(status, c.value ?: byteArrayOf())
            }

            override fun onCharacteristicRead(
                g: BluetoothGatt,
                c: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int,
            ) {
                finish(status, value)
            }

            override fun onCharacteristicWrite(
                g: BluetoothGatt,
                c: BluetoothGattCharacteristic,
                status: Int,
            ) {
                finish(status)
            }

            override fun onDescriptorWrite(
                g: BluetoothGatt,
                d: BluetoothGattDescriptor,
                status: Int,
            ) {
                finish(status)
            }

            private fun emit(c: BluetoothGattCharacteristic, value: ByteArray) {
                val queue = importQueue
                // Keep CCC enabled for custody recording, but ignore duplicate live
                // audio while canonical ring packets are being imported.
                if (queue != null && c.uuid.toString() == "19b10001-e8f2-537e-4f6c-d104768a1214")
                    return
                if (
                    queue != null &&
                        c.uuid.toString() == "30295781-4301-eabd-2904-2849adfeae43" &&
                        value.firstOrNull()?.toInt() in listOf(3, 4, 5)
                ) {
                    if (!queue.offer(value.copyOf())) importCancelled = true
                    return
                }
                val event =
                    Arguments.createMap().apply {
                        putString("char", c.uuid.toString())
                        putString("data", Base64.encodeToString(value, Base64.NO_WRAP))
                    }
                context
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("UomiBle", event)
            }

            @Deprecated("Legacy Android callback")
            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
                if (Build.VERSION.SDK_INT < 33) emit(c, c.value ?: byteArrayOf())
            }

            override fun onCharacteristicChanged(
                g: BluetoothGatt,
                c: BluetoothGattCharacteristic,
                value: ByteArray,
            ) {
                emit(c, value)
            }
        }

    private fun awaitOperation(start: () -> Boolean): ByteArray {
        val pending = CountDownLatch(1)
        latch = pending
        failure = null
        answer = byteArrayOf()
        try {
            check(start()) { "Bluetooth operation could not start. Try reconnecting your Omi." }
            check(pending.await(20, TimeUnit.SECONDS)) {
                "Bluetooth timed out. Keep your Omi nearby and try again."
            }
            failure?.let { error(it) }
            return answer
        } finally {
            latch = null
        }
    }

    @ReactMethod
    fun cancelImport(id: String, p: Promise) {
        synchronized(cancelledImports) {
            if (cancelledImports.size >= 64) cancelledImports.remove(cancelledImports.first())
            cancelledImports.add(id)
        }
        p.resolve(null)
    }

    @ReactMethod
    fun importRing(json: String, p: Promise) =
        operation(p) {
            val request = JSONObject(json)
            val id = request.getString("id")
            require(id.length <= 256)
            check(!cancelledImports.contains(id)) { "Import cancelled before admission" }
            val start = RingStream.parse(request.getString("start"))
            val count = request.getInt("count")
            require(count in 1..1024)
            val device = request.getString("deviceId")
            val ring = if (request.isNull("ringId")) null else request.getString("ringId")
            val cursor = request.getString("cursorKey")
            require(cursor.startsWith("cursor:"))
            check(importQueue == null) { "An import is already active" }
            // One bounded range fits even with the minimum BLE MTU. Never block Android's GATT
            // callback.
            val queue = ArrayBlockingQueue<ByteArray>(24576)
            importQueue = queue
            importCancelled = false
            val started = android.os.SystemClock.elapsedRealtime()
            var last = started
            var storageMs = 0L
            var received = 0L
            var largest = 0
            var committed = 0
            val stream = RingStream(start, count)
            val pending = mutableListOf<Pair<Long, ByteArray>>()
            fun commit() {
                if (pending.isEmpty()) return
                val at = android.os.SystemClock.elapsedRealtime()
                db.beginTransaction()
                try {
                    for ((seq, bytes) in pending) {
                        val prepared = BinaryAudio.prepare(device, ring, seq, bytes)
                        val key = prepared.key
                        val exists =
                            db.rawQuery(
                                    "SELECT EXISTS(SELECT 1 FROM kv WHERE key=? OR key=?)",
                                    arrayOf(key, "seen:$key"),
                                )
                                .use {
                                    it.moveToFirst()
                                    it.getInt(0) != 0
                                }
                        if (!exists) {
                            db.execSQL(
                                "INSERT INTO recording_audio VALUES (?,?)",
                                arrayOf(key, prepared.bytes),
                            )
                            db.execSQL(
                                "INSERT INTO record_index VALUES (?,?)",
                                arrayOf(key, prepared.index),
                            )
                            db.execSQL(
                                "INSERT INTO kv VALUES (?,?)",
                                arrayOf(key, prepared.metadata),
                            )
                        }
                    }
                    putValue(cursor, RingStream.format(pending.last().first + 1))
                    db.setTransactionSuccessful()
                } finally {
                    db.endTransaction()
                }
                committed += pending.size
                pending.clear()
                storageMs += android.os.SystemClock.elapsedRealtime() - at
            }
            fun metrics() =
                Arguments.createMap().apply {
                    putString("requestId", id)
                    putInt("completed", committed)
                    putDouble(
                        "elapsedMs",
                        (android.os.SystemClock.elapsedRealtime() - started).toDouble(),
                    )
                    putDouble("storageMs", storageMs.toDouble())
                    putDouble("receivedBytes", received.toDouble())
                    putInt("maxNotificationBytes", largest)
                    putInt("mtu", negotiatedMtu)
                    if (txPhy > 0) putInt("txPhy", txPhy) else putNull("txPhy")
                    if (rxPhy > 0) putInt("rxPhy", rxPhy) else putNull("rxPhy")
                    putNull("connectionIntervalMs")
                }
            fun send(bytes: ByteArray) {
                val c =
                    characteristic(
                        "30295780-4301-eabd-2904-2849adfeae43",
                        "30295781-4301-eabd-2904-2849adfeae43",
                    )
                awaitOperation {
                    if (Build.VERSION.SDK_INT >= 33)
                        gatt!!.writeCharacteristic(
                            c,
                            bytes,
                            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
                        ) == BluetoothStatusCodes.SUCCESS
                    else {
                        c.value = bytes
                        c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        gatt!!.writeCharacteristic(c)
                    }
                }
            }
            var success = false
            try {
                gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                if (Build.VERSION.SDK_INT >= 26 && txPhy == 0) {
                    gatt?.setPreferredPhy(
                        BluetoothDevice.PHY_LE_2M_MASK,
                        BluetoothDevice.PHY_LE_2M_MASK,
                        BluetoothDevice.PHY_OPTION_NO_PREFERRED,
                    )
                    gatt?.readPhy()
                }
                send(
                    java.nio.ByteBuffer.allocate(13)
                        .put(0x11.toByte())
                        .putLong(start)
                        .putInt(count)
                        .array()
                )
                var lastData = android.os.SystemClock.elapsedRealtime()
                while (true) {
                    check(!importCancelled && !cancelledImports.contains(id)) {
                        "Import paused or receive buffer full; committed audio is retained"
                    }
                    val message = queue.poll(250, TimeUnit.MILLISECONDS)
                    if (message == null) {
                        check(android.os.SystemClock.elapsedRealtime() - lastData < 30000) {
                            "Bluetooth transfer idle timeout"
                        }
                        continue
                    }
                    lastData = android.os.SystemClock.elapsedRealtime()
                    largest = maxOf(largest, message.size)
                    if (message.firstOrNull()?.toInt() == 3) received += message.size - 1
                    for (record in stream.accept(message)) {
                        pending.add(record)
                        if (pending.size == 32) {
                            commit()
                            if (android.os.SystemClock.elapsedRealtime() - last >= 150) {
                                context
                                    .getJSModule(
                                        DeviceEventManagerModule.RCTDeviceEventEmitter::class.java
                                    )
                                    .emit("UomiImport", metrics())
                                last = android.os.SystemClock.elapsedRealtime()
                            }
                        }
                    }
                    if (stream.done) {
                        commit()
                        success = true
                        break
                    }
                }
                metrics()
            } finally {
                try {
                    if (!success) {
                        try {
                            send(byteArrayOf(3))
                        } catch (_: Exception) {}
                        // Preserve fully assembled packets even on cancellation or an incomplete
                        // DONE.
                        commit()
                    }
                } finally {
                    importQueue = null
                    cancelledImports.remove(id)
                    if (!success || request.optBoolean("finalRange"))
                        gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
                }
            }
        }

    private fun characteristic(service: String, char: String) =
        gatt?.getService(UUID.fromString(service))?.getCharacteristic(UUID.fromString(char))
            ?: error("The connected device does not support this Omi characteristic.")

    @ReactMethod
    fun connect(address: String, p: Promise) =
        operation(p) {
            check(adapter.isEnabled) { "Bluetooth is off. Enable Bluetooth in system settings." }
            if (
                gatt?.device?.address != address ||
                    (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager)
                        .getConnectionState(gatt!!.device, BluetoothProfile.GATT) !=
                        BluetoothProfile.STATE_CONNECTED
            ) {
                gatt?.close()
                awaitOperation {
                    gatt =
                        adapter
                            .getRemoteDevice(address)
                            .connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
                    gatt != null
                }
            }
            null
        }

    @ReactMethod
    fun disconnect(p: Promise) =
        operation(p) {
            gatt?.disconnect()
            gatt?.close()
            gatt = null
            null
        }

    @ReactMethod
    fun read(service: String, char: String, p: Promise) =
        operation(p) {
            Base64.encodeToString(
                awaitOperation { gatt!!.readCharacteristic(characteristic(service, char)) },
                Base64.NO_WRAP,
            )
        }

    @ReactMethod
    fun write(service: String, char: String, value: String, p: Promise) =
        operation(p) {
            val c = characteristic(service, char)
            val data = Base64.decode(value, Base64.NO_WRAP)
            awaitOperation {
                if (Build.VERSION.SDK_INT >= 33)
                    gatt!!.writeCharacteristic(
                        c,
                        data,
                        BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
                    ) == BluetoothStatusCodes.SUCCESS
                else {
                    c.value = data
                    c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    gatt!!.writeCharacteristic(c)
                }
            }
            null
        }

    @ReactMethod
    fun notify(service: String, char: String, enabled: Boolean, p: Promise) =
        operation(p) {
            val c = characteristic(service, char)
            check(gatt!!.setCharacteristicNotification(c, enabled)) {
                "Could not enable Bluetooth notifications."
            }
            val d =
                c.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))
                    ?: error("Device notification descriptor missing.")
            val v =
                if (enabled) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            awaitOperation {
                if (Build.VERSION.SDK_INT >= 33)
                    gatt!!.writeDescriptor(d, v) == BluetoothStatusCodes.SUCCESS
                else {
                    d.value = v
                    gatt!!.writeDescriptor(d)
                }
            }
            null
        }

    @ReactMethod
    fun scan(p: Promise) =
        operation(p) {
            check(adapter.isEnabled) { "Bluetooth is off. Enable it in system settings." }
            val results = ConcurrentHashMap<String, String>()
            val scanner = adapter.bluetoothLeScanner ?: error("Bluetooth scanning is unavailable.")
            var scanFailure: Int? = null
            val scanCallback =
                object : ScanCallback() {
                    override fun onScanResult(type: Int, result: ScanResult) {
                        val name = result.scanRecord?.deviceName ?: result.device.name ?: ""
                        if (name.contains("omi", true) || name.contains("friend", true))
                            results[result.device.address] = name
                    }

                    override fun onScanFailed(code: Int) {
                        scanFailure = code
                    }
                }
            scanner.startScan(
                null,
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                scanCallback,
            )
            try {
                Thread.sleep(7000)
            } finally {
                scanner.stopScan(scanCallback)
            }
            check(scanFailure == null) {
                "Bluetooth scan failed ($scanFailure). Try again shortly."
            }
            Arguments.createArray().apply {
                results.forEach { (address, name) ->
                    pushMap(
                        Arguments.createMap().apply {
                            putString("address", address)
                            putString("name", name)
                        }
                    )
                }
            }
        }

    private fun isWifi(): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    @ReactMethod fun wifi(p: Promise) = operation(p) { isWifi() }

    @ReactMethod
    fun schedule(settings: String, p: Promise) =
        operation(p) {
            val json = JSONObject(settings)
            val mode = json.getString("mode")
            val wm = WorkManager.getInstance(context)
            context.getSharedPreferences("uomi", 0).edit().putString("mode", mode).apply()
            if (mode == "periodic") {
                val work =
                    PeriodicWorkRequestBuilder<UomiSyncWorker>(15, TimeUnit.MINUTES)
                        .setConstraints(
                            Constraints.Builder()
                                .setRequiredNetworkType(NetworkType.UNMETERED)
                                .build()
                        )
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                        .build()
                wm.enqueueUniquePeriodicWork("uomi-periodic", ExistingPeriodicWorkPolicy.KEEP, work)
            } else wm.cancelUniqueWork("uomi-periodic")
            val intent = Intent(context, UomiRealtimeService::class.java)
            if (mode == "realtime" && !UomiRealtimeService.running) {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
            } else if (mode != "realtime") context.stopService(intent)
            null
        }

    @ReactMethod
    fun finishPeriodic(success: Boolean, p: Promise) =
        operation(p) {
            UomiSyncWorker.taskSucceeded = success
            null
        }

    @ReactMethod
    fun uploadStatus(endpoint: String, header: String, ids: String, p: Promise) =
        operation(p, networkWorkers) {
            val target = URL(endpoint)
            require(target.protocol == "https" && target.userInfo == null) { "Use an HTTPS API URL." }
            require(!header.contains('\r') && !header.contains('\n'))
            val url = URL(target.protocol, target.host, target.port, target.path.trimEnd('/') + "/status")
            val secret = getSecret("sites-api")
            check(secret.isNotEmpty()) { "Set your API key in Settings." }
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 30000
                connection.readTimeout = 30000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty(header, secret)
                val access = getSecret("sites-access")
                if (access.isNotEmpty()) connection.setRequestProperty("OAI-Sites-Authorization", "Bearer $access")
                val bytes = JSONObject().put("ids", org.json.JSONArray(ids)).toString().toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
                check(connection.responseCode in 200..299) {
                    "Upload status HTTP ${connection.responseCode}: ${connection.errorStream?.bufferedReader()?.use { it.readText().take(2000) } ?: connection.responseMessage}. Audio stays local."
                }
                JSONObject(connection.inputStream.bufferedReader().readText()).getJSONArray("uploads").toString()
            } finally { connection.disconnect() }
        }

    @ReactMethod
    fun post(
        endpoint: String,
        header: String,
        body: String,
        compression: String,
        id: String,
        binary: Boolean,
        p: Promise,
    ) =
        operation(p, networkWorkers) {
            val url = URL(endpoint)
            require(url.protocol == "https" && url.userInfo == null) { "Use an HTTPS API URL." }
            require(!header.contains('\r') && !header.contains('\n'))
            val raw = if (binary) Base64.decode(body, Base64.DEFAULT) else body.toByteArray(Charsets.UTF_8)
            val bytes =
                if (compression == "none") raw
                else
                    ByteArrayOutputStream().use { out ->
                        if (compression == "gzip") GZIPOutputStream(out).use { it.write(raw) }
                        else DeflaterOutputStream(out).use { it.write(raw) }
                        out.toByteArray()
                    }
            val secret = getSecret("sites-api")
            check(secret.isNotEmpty()) { "Set your API key in Settings." }
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 30000
                connection.readTimeout = 120000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", if (binary) "application/vnd.uomi.ogg" else "application/vnd.uomi.audio+json")
                if (compression != "none")
                    connection.setRequestProperty("Content-Encoding", compression)
                connection.setRequestProperty(header, secret)
                val access = getSecret("sites-access")
                if (access.isNotEmpty()) connection.setRequestProperty("OAI-Sites-Authorization", "Bearer $access")
                connection.setRequestProperty("Idempotency-Key", id)
                connection.setRequestProperty("X-Uomi-Schema", if (binary) "2" else "1")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
                val status = connection.responseCode
                check(status in 200..299) {
                    "Audio upload HTTP $status: ${connection.errorStream?.bufferedReader()?.use { it.readText().take(2000) } ?: connection.responseMessage}. Audio stays queued."
                }
                val receipt = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                check(receipt.optString("id") == id) { "Upload receipt identity does not match. Audio stays local." }
                check(receipt.has("saved") && receipt.get("saved") is Boolean) { "Upload receipt does not confirm server storage. Audio stays local." }
                receipt.getBoolean("saved")
            } finally {
                connection.disconnect()
            }
        }

    // Isolate decoding from BLE/database work. No debug audio is persisted.
    private val liveExecutor = Executors.newSingleThreadExecutor()
    private var liveDecoder: android.media.MediaCodec? = null
    private var liveTrack: android.media.AudioTrack? = null
    private var liveTimestamp = 0L

    private fun releaseLive() {
        liveTrack?.release()
        liveTrack = null
        liveDecoder?.release()
        liveDecoder = null
    }

    @ReactMethod
    fun startLiveAudio(promise: Promise) {
        liveExecutor.execute {
            try {
                releaseLive()
                val format = android.media.MediaFormat.createAudioFormat("audio/opus", 16000, 1)
                val head = java.nio.ByteBuffer.allocate(19).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                head
                    .put("OpusHead".toByteArray())
                    .put(1.toByte())
                    .put(1.toByte())
                    .putShort(0.toShort())
                    .putInt(16000)
                    .putShort(0.toShort())
                    .put(0.toByte())
                head.flip()
                format.setByteBuffer("csd-0", head)
                fun number(value: Long): java.nio.ByteBuffer {
                    val b = java.nio.ByteBuffer.allocate(8).order(java.nio.ByteOrder.nativeOrder())
                    b.putLong(value)
                    b.flip()
                    return b
                }
                format.setByteBuffer("csd-1", number(0))
                format.setByteBuffer("csd-2", number(80000000))
                val codec = android.media.MediaCodec.createDecoderByType("audio/opus")
                liveDecoder = codec
                codec.configure(format, null, null, 0)
                codec.start()
                liveTimestamp = 0
                promise.resolve(null)
            } catch (e: Exception) {
                releaseLive()
                promise.reject("LIVE_AUDIO", e)
            }
        }
    }

    @ReactMethod
    fun pushLiveAudio(base64: String, duration: Double, promise: Promise) {
        liveExecutor.execute {
            try {
                val codec = liveDecoder
                if (codec == null) {
                    promise.resolve(null)
                    return@execute
                }
                val input = codec.dequeueInputBuffer(1000)
                if (input >= 0) {
                    val bytes = Base64.decode(base64, Base64.NO_WRAP)
                    codec.getInputBuffer(input)!!.put(bytes)
                    codec.queueInputBuffer(input, 0, bytes.size, liveTimestamp, 0)
                    liveTimestamp += (duration * 1000).toLong()
                }
                val info = android.media.MediaCodec.BufferInfo()
                var output = codec.dequeueOutputBuffer(info, 0)
                while (output != android.media.MediaCodec.INFO_TRY_AGAIN_LATER) {
                    if (output == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        liveTrack?.release()
                        val rate =
                            codec.outputFormat.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE)
                        val size =
                            android.media.AudioTrack.getMinBufferSize(
                                rate,
                                android.media.AudioFormat.CHANNEL_OUT_MONO,
                                android.media.AudioFormat.ENCODING_PCM_16BIT,
                            )
                        liveTrack =
                            android.media.AudioTrack.Builder()
                                .setAudioAttributes(
                                    android.media.AudioAttributes.Builder()
                                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                                        .setContentType(
                                            android.media.AudioAttributes.CONTENT_TYPE_SPEECH
                                        )
                                        .build()
                                )
                                .setAudioFormat(
                                    android.media.AudioFormat.Builder()
                                        .setSampleRate(rate)
                                        .setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO)
                                        .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                                        .build()
                                )
                                .setBufferSizeInBytes(maxOf(size * 2, rate / 2))
                                .setTransferMode(android.media.AudioTrack.MODE_STREAM)
                                .build()
                        liveTrack?.play()
                    } else if (output >= 0) {
                        val buffer = codec.getOutputBuffer(output)!!
                        buffer.position(info.offset)
                        buffer.limit(info.offset + info.size)
                        liveTrack?.write(buffer, info.size, android.media.AudioTrack.WRITE_BLOCKING)
                        codec.releaseOutputBuffer(output, false)
                    }
                    output = codec.dequeueOutputBuffer(info, 0)
                }
                promise.resolve(null)
            } catch (e: Exception) {
                releaseLive()
                promise.reject("LIVE_AUDIO", e)
            }
        }
    }

    @ReactMethod
    fun stopLiveAudio() {
        liveExecutor.execute { releaseLive() }
    }

    private var audioPlayer: android.media.MediaPlayer? = null
    private var audioPromise: Promise? = null
    private var audioFile: java.io.File? = null

    private fun releaseAudio() {
        audioPlayer?.release()
        audioPlayer = null
        audioFile?.delete() // Only a disposable playback cache, never database audio.
        audioFile = null
        audioPromise?.resolve(null)
        audioPromise = null
    }

    @ReactMethod
    fun stopAudio() {
        context.runOnUiQueueThread { releaseAudio() }
    }

    @ReactMethod
    fun playAudio(base64: String, promise: Promise) {
        context.runOnUiQueueThread {
            releaseAudio()
            try {
                val file = java.io.File.createTempFile("uomi-playback-", ".ogg", context.cacheDir)
                audioFile = file
                file.writeBytes(Base64.decode(base64, Base64.NO_WRAP))
                val player = android.media.MediaPlayer()
                audioPlayer = player
                audioPromise = promise
                player.setAudioAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                player.setDataSource(file.absolutePath)
                player.setOnPreparedListener { it.start() }
                player.setOnCompletionListener { releaseAudio() }
                player.setOnErrorListener { _, what, extra ->
                    audioPromise = null
                    promise.reject("PLAYBACK", "Audio playback failed ($what, $extra)")
                    releaseAudio()
                    true
                }
                player.prepareAsync()
            } catch (e: Exception) {
                audioPromise = null
                releaseAudio()
                promise.reject("PLAYBACK", e)
            }
        }
    }

    override fun invalidate() {
        importCancelled = true
        liveExecutor.execute { releaseLive() }
        liveExecutor.shutdown()
        context.runOnUiQueueThread { releaseAudio() }
        gatt?.close()
        audioWorkers.shutdown()
        networkWorkers.shutdown()
        executor.shutdown()
        super.invalidate()
    }
}
