//! Bounded native BLE-to-SQLite pipeline; no audio crosses the WebView bridge.
use super::*;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
const CONTROL: &str = "30295781-4301-eabd-2904-2849adfeae43";
const SERVICE: &str = "30295780-4301-eabd-2904-2849adfeae43";

// Debug builds trace by default; production can opt in without rebuilding.
// Read per import so no per-notification environment lookup is needed.
pub(super) fn trace_enabled() -> bool {
    match std::env::var("UOMI_BLE_TRACE").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => cfg!(debug_assertions),
    }
}

struct TransferTrace {
    enabled: bool,
    began: Instant,
    last: Instant,
    notifications: u64,
    queue_peak: usize,
    receive_wait_ms: f64,
    receive_wait_max_ms: f64,
    first_data_ms: Option<f64>,
    command_ms: f64,
    parse_ms: f64,
    commit_wall_ms: f64,
    commit_max_ms: f64,
    commits: u64,
}
impl TransferTrace {
    fn new() -> Self {
        Self {
            enabled: trace_enabled(),
            began: Instant::now(),
            last: Instant::now(),
            notifications: 0,
            queue_peak: 0,
            receive_wait_ms: 0.0,
            receive_wait_max_ms: 0.0,
            first_data_ms: None,
            command_ms: 0.0,
            parse_ms: 0.0,
            commit_wall_ms: 0.0,
            commit_max_ms: 0.0,
            commits: 0,
        }
    }
    fn committed(&mut self, began: Instant, queued: usize) {
        if !self.enabled {
            return;
        }
        let ms = began.elapsed().as_secs_f64() * 1000.0;
        self.commit_wall_ms += ms;
        self.commit_max_ms = self.commit_max_ms.max(ms);
        self.commits += 1;
        self.queue_peak = self.queue_peak.max(queued);
    }
    fn report(
        &mut self,
        event: &str,
        bytes: usize,
        records: u64,
        storage_ms: f64,
        mtu: Option<u64>,
        largest: usize,
    ) {
        if !self.enabled || (event == "progress" && self.last.elapsed() < Duration::from_secs(2)) {
            return;
        }
        let elapsed_ms = self.began.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "UOMI_BLE_TRACE {}",
            json!({
                "event": event, "elapsed_ms": elapsed_ms, "received_bytes": bytes,
                "kib_per_s": bytes as f64 / 1024.0 / (elapsed_ms / 1000.0).max(0.001),
                "committed_records": records, "notifications": self.notifications,
                "queue_peak_sampled": self.queue_peak, "queue_capacity": 64,
                "receive_wait_ms": self.receive_wait_ms, "receive_wait_max_ms": self.receive_wait_max_ms,
                "first_data_ms": self.first_data_ms, "command_ms": self.command_ms, "parse_ms": self.parse_ms,
                "commit_wall_ms": self.commit_wall_ms, "commit_max_ms": self.commit_max_ms,
                "storage_ms": storage_ms, "commits": self.commits,
                "mtu": mtu, "max_notification_bytes": largest,
            })
        );
        self.last = Instant::now();
    }
}
struct RingStream {
    start: u64,
    end: u64,
    sequence: u64,
    begun: bool,
    done: bool,
    tail: Vec<u8>,
}
impl RingStream {
    fn new(start: u64, count: u64) -> Result<Self> {
        Ok(Self {
            start,
            end: start.checked_add(count).ok_or("Invalid ring range")?,
            sequence: start,
            begun: false,
            done: false,
            tail: Vec::new(),
        })
    }
    fn accept(&mut self, message: &[u8]) -> Result<(Vec<(u64, Vec<u8>)>, bool)> {
        if self.done {
            return Err("Audio arrived after DONE".into());
        }
        let mut records = Vec::new();
        match message.first() {
            Some(5) => {
                if self.begun
                    || message.len() < 13
                    || u64::from_be_bytes(message[1..9].try_into().unwrap()) != self.start
                    || u32::from_be_bytes(message[9..13].try_into().unwrap()) as u64
                        != self.end - self.start
                {
                    return Err("Device recording range changed".into());
                }
                self.begun = true;
            }
            Some(3) => {
                if !self.begun {
                    return Err("Audio arrived before its range".into());
                }
                self.tail.extend_from_slice(&message[1..]);
                while self.tail.len() >= 444 {
                    if self.sequence >= self.end {
                        return Err("Too many ring packets".into());
                    }
                    records.push((self.sequence, self.tail.drain(..444).collect()));
                    self.sequence += 1;
                }
            }
            Some(4) => {
                if !self.begun
                    || message.len() < 10
                    || message[1] != 0
                    || u64::from_be_bytes(message[2..10].try_into().unwrap()) != self.end
                    || self.sequence != self.end
                    || !self.tail.is_empty()
                {
                    return Err("Incomplete Bluetooth transfer; committed audio is retained".into());
                }
                self.done = true;
                return Ok((records, true));
            }
            _ => return Err("Unexpected bulk notification".into()),
        }
        Ok((records, false))
    }
}

fn opus_duration(bytes: &[u8]) -> Result<f64> {
    let toc = *bytes.first().ok_or("Empty Opus frame")?;
    let config = toc >> 3;
    let per = if config >= 16 {
        2.5 * (1u32 << (config & 3)) as f64
    } else if config >= 12 {
        10.0 * (1u32 << (config & 1)) as f64
    } else {
        [10.0, 20.0, 40.0, 60.0][(config & 3) as usize]
    };
    let code = toc & 3;
    let n = if code == 0 {
        1
    } else if code == 3 {
        bytes.get(1).ok_or("Truncated Opus frame")? & 63
    } else {
        2
    };
    if n == 0 || per * n as f64 > 120.0 {
        return Err("Invalid Opus duration".into());
    }
    Ok(per * n as f64)
}
fn prepared_recording(
    device: &str,
    ring: Option<&str>,
    sequence: u64,
    raw: &[u8],
    received: &str,
) -> Result<(String, String, String, Vec<u8>)> {
    if raw.len() != 444 {
        return Err("Invalid ring packet length".into());
    }
    let mut hash = Sha256::new();
    hash.update(format!("{}:{sequence}:", ring.unwrap_or("legacy")));
    hash.update(raw);
    let digest = format!("{:x}", hash.finalize());
    // Match encodeURIComponent for stable keys generated by earlier clients.
    let escaped = device
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<String>();
    let key = format!("record:{escaped}:{digest}");
    let timestamp = u32::from_be_bytes(raw[..4].try_into().unwrap());
    let utc = timestamp > 0 && timestamp & 0x80000000 == 0;
    let captured = if utc {
        Some(iso_time(timestamp as u64 * 1000)?)
    } else {
        None
    };
    let mut durations = Vec::new();
    let mut blob = Vec::new();
    let mut pos = 4;
    while pos < 443 {
        let n = raw[pos] as usize;
        if n == 0 {
            pos += 1;
            continue;
        }
        if pos + 1 + n >= 444 {
            break;
        }
        let data = &raw[pos + 1..pos + 1 + n];
        let duration = opus_duration(data)?;
        durations.push(duration);
        blob.extend_from_slice(&(n as u16).to_le_bytes());
        blob.extend_from_slice(data);
        pos += n + 1;
    }
    let record = json!({"key":key,"deviceId":device,"ringId":ring,"sequence":sequence.to_string(),"capturedAt":captured,"timestampRaw":timestamp,"timing":if utc {"device-utc"} else {"device-uptime"},"uploaded":0,"bytes":444,"receivedAt":received});
    let mut index = record.clone();
    index["frameCount"] = json!(durations.len());
    index["durationMs"] = json!(durations.iter().sum::<f64>());
    let mut stored = json!({"binaryAudio":1,"record":record,"frameCount":durations.len()});
    if !durations.is_empty() {
        let prefix = format!("{device}:{digest}:");
        index["idPrefix"] = json!(prefix);
        stored["idPrefix"] = json!(prefix);
    } else {
        index["frameIds"] = json!([]);
        stored["frameIds"] = json!([]);
    }
    if durations
        .iter()
        .all(|value| Some(value) == durations.first())
    {
        let duration = durations.first().copied().unwrap_or(20.0);
        index["frameDurationMs"] = json!(duration);
        stored["frameDurationMs"] = json!(duration);
    } else {
        index["frameDurations"] = json!(durations);
        stored["frameDurations"] = json!(durations);
    }
    Ok((key, stored.to_string(), index.to_string(), blob))
}
#[cfg(test)]
fn recording(
    device: &str,
    ring: Option<&str>,
    sequence: u64,
    raw: &[u8],
    received: &str,
) -> Result<(String, String)> {
    let (key, stored, _, bytes) = prepared_recording(device, ring, sequence, raw, received)?;
    Ok((key, audio_store::unpack(&stored, &bytes)?))
}
// UTC formatter avoids a second date dependency and always includes milliseconds.
fn iso_time(ms: u64) -> Result<String> {
    // Civil-from-days algorithm (Gregorian), valid for device RTC and system timestamps.
    let secs = ms / 1000;
    let z = (secs / 86400) as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += if m <= 2 { 1 } else { 0 };
    Ok(format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs / 3600 % 24,
        secs / 60 % 60,
        secs % 60,
        ms % 1000
    ))
}
async fn commit(
    db: Arc<Mutex<Connection>>,
    records: Vec<(u64, Vec<u8>)>,
    device: String,
    ring: Option<String>,
    cursor: String,
) -> Result<f64> {
    tauri::async_runtime::spawn_blocking(move || {
        let began = Instant::now();
        let mut conn = db.lock().map_err(error)?;
        let tx = conn.transaction().map_err(error)?;
        let received = iso_time(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(error)?
                .as_millis() as u64,
        )?;
        let mut next = None;
        for (sequence, bytes) in records {
            let (key, metadata, index, audio) =
                prepared_recording(&device, ring.as_deref(), sequence, &bytes, &received)?;
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM kv WHERE key=?1 OR key=?2)",
                    rusqlite::params![key, format!("seen:{key}")],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if !exists {
                tx.execute(
                    "INSERT INTO recording_audio VALUES (?1,?2)",
                    rusqlite::params![key, audio],
                )
                .map_err(error)?;
                tx.execute("INSERT INTO record_index VALUES (?1,?2)", [&key, &index])
                    .map_err(error)?;
                tx.execute("INSERT INTO kv VALUES (?1,?2)", [&key, &metadata])
                    .map_err(error)?;
            }
            next = Some(sequence + 1);
        }
        if let Some(next) = next {
            put_value(&tx, &cursor, &next.to_string())?;
        }
        tx.commit().map_err(error)?;
        Ok(began.elapsed().as_secs_f64() * 1000.0)
    })
    .await
    .map_err(error)?
}

async fn bluez_mtu(device: String) -> Option<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        use dbus::blocking::stdintf::org_freedesktop_dbus::ObjectManager;
        let bus = dbus::blocking::Connection::new_system().ok()?;
        let proxy = bus.with_proxy("org.bluez", "/", Duration::from_millis(500));
        let objects = proxy.get_managed_objects().ok()?;
        let prefix = format!("/org/bluez/{device}/");
        for (path, interfaces) in objects {
            if !path.starts_with(&prefix) {
                continue;
            }
            if let Some(props) = interfaces.get("org.bluez.GattCharacteristic1") {
                if props.get("UUID").and_then(|v| v.0.as_str()) == Some(CONTROL) {
                    return props.get("MTU").and_then(|v| v.0.as_u64());
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn cancel_import(state: State<'_, Arc<Backend>>, id: String) -> Result<()> {
    let mut cancelled = state.bulk_cancelled.lock().map_err(error)?;
    if cancelled.len() >= 64 {
        cancelled.pop_front();
    }
    cancelled.push_back(id);
    state.bulk_cancel.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn import_ring(
    app: tauri::AppHandle,
    state: State<'_, Arc<Backend>>,
    request: Value,
) -> Result<Value> {
    let id = request["id"]
        .as_str()
        .filter(|v| v.len() <= 256)
        .ok_or("Invalid request identity")?
        .to_string();
    if state.bulk_cancelled.lock().map_err(error)?.contains(&id) {
        return Err("Import cancelled before admission".into());
    }
    let start = request["start"]
        .as_str()
        .ok_or("Missing start")?
        .parse::<u64>()
        .map_err(error)?;
    let count = request["count"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 1024)
        .ok_or("Invalid bounded range")?;
    start.checked_add(count).ok_or("Invalid ring range")?;
    let device = request["deviceId"]
        .as_str()
        .ok_or("Missing device")?
        .to_string();
    let ring = request["ringId"].as_str().map(str::to_string);
    let cursor = request["cursorKey"]
        .as_str()
        .filter(|v| v.starts_with("cursor:"))
        .ok_or("Invalid cursor")?
        .to_string();
    let mtu = bluez_mtu(state.device().await?.id().to_string()).await;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    {
        let mut active = state.bulk.lock().map_err(error)?;
        if active.is_some() {
            return Err("An import is already active".into());
        }
        *active = Some(tx);
    }
    let began = Instant::now();
    let mut trace = TransferTrace::new();
    if trace.enabled {
        eprintln!(
            "UOMI_BLE_TRACE {}",
            json!({"event":"start", "requested_records":count,"mtu":mtu})
        );
    }
    let mut last = Instant::now();
    let mut storage_ms = 0.0;
    let mut bytes = 0usize;
    let mut largest = 0usize;
    let mut committed = 0u64;
    let mut pending = Vec::new();
    let result:Result<()> = async {
        let (p,c)=characteristic(&state,SERVICE,CONTROL).await?;
        let mut command=vec![0x11];command.extend_from_slice(&start.to_be_bytes());command.extend_from_slice(&(count as u32).to_be_bytes());
        let command_began = Instant::now();
        p.write(&c,&command,WriteType::WithResponse).await.map_err(error)?;
        if trace.enabled { trace.command_ms = command_began.elapsed().as_secs_f64()*1000.0; }
        let mut stream=RingStream::new(start,count)?;
        loop {
            if state.bulk_cancelled.lock().map_err(error)?.contains(&id) {return Err("Import paused; committed audio is kept locally".into());}
            let receive_began = Instant::now();
            if trace.enabled { trace.queue_peak = trace.queue_peak.max(rx.len()); }
            let message=tokio::select! {
                _=state.bulk_cancel.notified()=>continue,
                value=tokio::time::timeout(Duration::from_secs(30),rx.recv())=>value.map_err(|_|"Bluetooth transfer idle timeout")?.ok_or("Bluetooth import disconnected")?,
            };
            if trace.enabled { let wait_ms = receive_began.elapsed().as_secs_f64()*1000.0; trace.receive_wait_ms += wait_ms; trace.receive_wait_max_ms = trace.receive_wait_max_ms.max(wait_ms); trace.notifications += 1; trace.queue_peak = trace.queue_peak.max(rx.len()); }
            largest=largest.max(message.len());
            if message.first()==Some(&3) {bytes+=message.len()-1; if trace.enabled && trace.first_data_ms.is_none() { trace.first_data_ms = Some(trace.began.elapsed().as_secs_f64()*1000.0); }}
            let parse_began = Instant::now();
            let (records,done)=stream.accept(&message)?;
            if trace.enabled { trace.parse_ms += parse_began.elapsed().as_secs_f64()*1000.0; }
            pending.extend(records);
            while pending.len()>=32 {
                let records=pending.drain(..32).collect();
                let commit_began = Instant::now();
                storage_ms+=commit(state.db.clone(),records,device.clone(),ring.clone(),cursor.clone()).await?;committed+=32;
                trace.committed(commit_began, rx.len());
                if last.elapsed().as_millis()>=150 {
                    let _=app.emit("uomi:import",json!({"requestId":id,"completed":committed,"elapsedMs":began.elapsed().as_secs_f64()*1000.0,"storageMs":storage_ms,"receivedBytes":bytes,"maxNotificationBytes":largest,"mtu":mtu.filter(|value|*value>=(largest+3) as u64)}));last=Instant::now();
                }
            }
            trace.report("progress", bytes, committed, storage_ms, mtu, largest);
            if done {
                if !pending.is_empty() {let n=pending.len() as u64;let commit_began=Instant::now();storage_ms+=commit(state.db.clone(),std::mem::take(&mut pending),device.clone(),ring.clone(),cursor.clone()).await?;committed+=n;trace.committed(commit_began, rx.len());}
                return Ok(());
            }
        }
    }.await;
    trace.report(
        if result.is_ok() { "done" } else { "error" },
        bytes,
        committed,
        storage_ms,
        mtu,
        largest,
    );
    *state.bulk.lock().map_err(error)? = None;
    state
        .bulk_cancelled
        .lock()
        .map_err(error)?
        .retain(|value| value != &id);
    if result.is_err() {
        if let Ok((p, c)) = characteristic(&state, SERVICE, CONTROL).await {
            let _ = p.write(&c, &[3], WriteType::WithResponse).await;
        }
    }
    if result.is_err() && !pending.is_empty() {
        commit(
            state.db.clone(),
            pending,
            device.clone(),
            ring.clone(),
            cursor.clone(),
        )
        .await?;
    }
    result?;
    Ok(
        json!({"requestId":id,"completed":committed,"elapsedMs":began.elapsed().as_secs_f64()*1000.0,"storageMs":storage_ms,"receivedBytes":bytes,"maxNotificationBytes":largest,"mtu":mtu.filter(|value| *value >= (largest+3) as u64),"txPhy":null,"rxPhy":null,"connectionIntervalMs":null}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_validates_ranges_fragmentation_done_and_overrun() {
        let mut begin = vec![5];
        begin.extend_from_slice(&7u64.to_be_bytes());
        begin.extend_from_slice(&2u32.to_be_bytes());
        let mut done = vec![4, 0];
        done.extend_from_slice(&9u64.to_be_bytes());
        let mut stream = RingStream::new(7, 2).unwrap();
        assert!(stream.accept(&[3, 1]).is_err());
        stream.accept(&begin).unwrap();
        assert!(stream.accept(&done).is_err());
        let raw = vec![42u8; 888];
        let mut records = Vec::new();
        for fragment in raw.chunks(19) {
            let mut data = vec![3];
            data.extend_from_slice(fragment);
            records.extend(stream.accept(&data).unwrap().0);
        }
        assert_eq!(records, vec![(7, vec![42; 444]), (8, vec![42; 444])]);
        assert!(stream.accept(&done).unwrap().1);
        assert!(stream.accept(&[vec![3], vec![0; 444]].concat()).is_err());
        let mut partial = RingStream::new(7, 2).unwrap();
        partial.accept(&begin).unwrap();
        partial.accept(&[3, 0]).unwrap();
        assert!(partial.accept(&done).is_err());
        assert!(RingStream::new(u64::MAX, 2).is_err());
    }
    #[tokio::test]
    async fn cursor_failure_rolls_back_binary_audio_and_retries_respect_tombstones() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE recording_audio(key TEXT PRIMARY KEY,data BLOB NOT NULL);CREATE TABLE record_index(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE notion_index(key TEXT PRIMARY KEY,target TEXT,device TEXT,start REAL);CREATE TRIGGER fail_cursor BEFORE INSERT ON kv WHEN NEW.key='cursor:test' BEGIN SELECT RAISE(ABORT,'disk failure');END;").unwrap();
        let db = Arc::new(Mutex::new(conn));
        let mut raw = vec![0u8; 444];
        raw[4] = 3;
        raw[5..8].copy_from_slice(&[248, 255, 254]);
        assert!(commit(
            db.clone(),
            vec![(0, raw.clone())],
            "d".into(),
            None,
            "cursor:test".into()
        )
        .await
        .is_err());
        {
            let conn = db.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM recording_audio", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM kv", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            conn.execute_batch("DROP TRIGGER fail_cursor").unwrap();
        }
        commit(
            db.clone(),
            vec![(0, raw.clone())],
            "d".into(),
            None,
            "cursor:test".into(),
        )
        .await
        .unwrap();
        let (key, _) = recording("d", None, 0, &raw, "received").unwrap();
        {
            let mut conn = db.lock().unwrap();
            let tx = conn.transaction().unwrap();
            put_value(&tx, &format!("seen:{key}"), &key).unwrap();
            remove_value(&tx, &key).unwrap();
            tx.commit().unwrap();
        }
        commit(
            db.clone(),
            vec![(0, raw)],
            "d".into(),
            None,
            "cursor:test".into(),
        )
        .await
        .unwrap();
        let conn = db.lock().unwrap();
        assert!(audio_store::read(&conn, &key).unwrap().is_none());
        assert_eq!(
            audio_store::read(&conn, "cursor:test").unwrap().unwrap(),
            "1"
        );
    }
    #[test]
    fn ring_identity_duration_and_timestamp_match_js_contract() {
        let mut bytes = [0u8; 444];
        bytes[..4].copy_from_slice(&1767225600u32.to_be_bytes());
        bytes[4] = 3;
        bytes[5..8].copy_from_slice(&[248, 255, 254]);
        let (_, raw) = recording("E1:4C", None, 7, &bytes, "received").unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let digest = format!("{:x}", Sha256::digest([b"legacy:7:", &bytes[..]].concat()));
        assert_eq!(value["key"], format!("record:E1%3A4C:{digest}"));
        assert_eq!(value["capturedAt"], "2026-01-01T00:00:00.000Z");
        assert_eq!(value["frames"][0]["data"], "+P/+");
        assert_eq!(value["frames"][0]["durationMs"].as_f64(), Some(20.0));
    }
}
