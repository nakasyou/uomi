//! Versioned binary audio storage. Legacy JSON remains readable until explicitly migrated.
use super::*;

pub fn pack(raw: &str) -> Result<(String, Vec<u8>)> {
    let mut record: Value = serde_json::from_str(raw).map_err(error)?;
    let frames = record
        .as_object_mut()
        .ok_or("Invalid recording")?
        .remove("frames")
        .ok_or("Missing frames")?;
    let frames = frames.as_array().ok_or("Invalid frames")?;
    let summary: Value = serde_json::from_str(&record_index(raw)?).map_err(error)?;
    let mut packed = json!({"binaryAudio":1,"record":record});
    for name in [
        "frameCount",
        "frameDurationMs",
        "frameDurations",
        "idPrefix",
        "frameIds",
    ] {
        if let Some(value) = summary.get(name) {
            packed[name] = value.clone();
        }
    }
    let mut bytes = Vec::new();
    let mut offsets = Vec::new();
    let mut extras = Vec::new();
    let mut offset = 0.0;
    let mut irregular = false;
    for frame in frames {
        let data = B64
            .decode(frame["data"].as_str().ok_or("Missing frame bytes")?)
            .map_err(error)?;
        let len = u16::try_from(data.len()).map_err(error)?;
        bytes.extend_from_slice(&len.to_le_bytes());
        bytes.extend_from_slice(&data);
        let original_offset = frame["offsetMs"].as_f64().ok_or("Missing frame offset")?;
        irregular |= original_offset != offset;
        offsets.push(json!(original_offset));
        offset += frame["durationMs"]
            .as_f64()
            .ok_or("Missing frame duration")?;
        let mut extra = frame.clone();
        for key in ["id", "data", "durationMs", "offsetMs"] {
            extra.as_object_mut().unwrap().remove(key);
        }
        extras.push(extra);
    }
    if irregular {
        packed["offsets"] = json!(offsets);
    }
    if extras.iter().any(|v| !v.as_object().unwrap().is_empty()) {
        packed["extras"] = json!(extras);
    }
    Ok((packed.to_string(), bytes))
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9007199254740992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

pub fn unpack(raw: &str, bytes: &[u8]) -> Result<String> {
    let packed: Value = serde_json::from_str(raw).map_err(error)?;
    if packed["binaryAudio"] != 1 {
        return Ok(raw.to_string());
    }
    let count = packed["frameCount"].as_u64().ok_or("Invalid frame count")? as usize;
    let mut record = packed["record"].clone();
    let mut frames = Vec::new();
    let mut cursor = 0;
    let mut offset = 0.0;
    for i in 0..count {
        if cursor + 2 > bytes.len() {
            return Err("Truncated binary audio".into());
        }
        let size = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
        cursor += 2;
        if cursor + size > bytes.len() {
            return Err("Truncated binary audio".into());
        }
        let duration = packed["frameDurationMs"]
            .as_f64()
            .or_else(|| packed["frameDurations"][i].as_f64())
            .ok_or("Invalid frame duration")?;
        let id = match packed["idPrefix"].as_str() {
            Some(prefix) => format!("{prefix}{i}"),
            None => packed["frameIds"][i]
                .as_str()
                .ok_or("Invalid frame identity")?
                .to_string(),
        };
        let mut frame = packed["extras"][i].as_object().cloned().unwrap_or_default();
        frame.insert("id".into(), json!(id));
        frame.insert(
            "data".into(),
            json!(B64.encode(&bytes[cursor..cursor + size])),
        );
        frame.insert("durationMs".into(), number(duration));
        frame.insert(
            "offsetMs".into(),
            number(packed["offsets"][i].as_f64().unwrap_or(offset)),
        );
        frames.push(Value::Object(frame));
        cursor += size;
        offset += duration;
    }
    if cursor != bytes.len() {
        return Err("Unexpected binary audio bytes".into());
    }
    record["frames"] = json!(frames);
    Ok(record.to_string())
}

pub fn stored_value(key: &str, raw: String, bytes: Option<Vec<u8>>) -> Result<String> {
    if !key.starts_with("record:") {
        return Ok(raw);
    }
    let packed: Value = serde_json::from_str(&raw).map_err(error)?;
    if packed["binaryAudio"] != 1 {
        return Ok(raw);
    }
    unpack(&raw, &bytes.ok_or("Missing binary audio")?)
}

pub fn read(conn: &Connection, key: &str) -> Result<Option<String>> {
    let row: Option<(String,Option<Vec<u8>>)> = conn.query_row(
        "SELECT k.value,a.data FROM kv k LEFT JOIN recording_audio a ON a.key=k.key WHERE k.key=?1",
        [key], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(error)?;
    row.map(|(raw, bytes)| stored_value(key, raw, bytes))
        .transpose()
}

pub fn read_many(conn: &Connection, keys: &[String]) -> Result<Vec<Value>> {
    if keys.len() > 256 {
        return Err("Too many storage keys".into());
    }
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let sql=format!("SELECT k.key,k.value,a.data FROM kv k LEFT JOIN recording_audio a ON a.key=k.key WHERE k.key IN ({})",vec!["?";keys.len()].join(","));
    let mut query = conn.prepare_cached(&sql).map_err(error)?;
    let mut rows = query
        .query(rusqlite::params_from_iter(keys))
        .map_err(error)?;
    let mut values = std::collections::HashMap::new();
    while let Some(row) = rows.next().map_err(error)? {
        let key: String = row.get(0).map_err(error)?;
        let value = stored_value(&key, row.get(1).map_err(error)?, row.get(2).map_err(error)?)?;
        values.insert(key, value);
    }
    Ok(keys
        .iter()
        .filter_map(|key| {
            values
                .get(key)
                .map(|value| json!({"key":key,"value":value}))
        })
        .collect())
}

// Acknowledgements touch metadata only. Original Opus BLOBs never cross IPC or
// get decoded/repacked simply to advance a durable upload receipt.
pub fn acknowledge(conn: &Connection, updates: &[Value]) -> Result<()> {
    if updates.len() > 256 {
        return Err("Too many acknowledgement updates".into());
    }
    let mut read = conn
        .prepare_cached(
            "SELECT k.value,i.value FROM kv k JOIN record_index i ON i.key=k.key WHERE k.key=?1",
        )
        .map_err(error)?;
    let mut write = conn
        .prepare_cached("UPDATE kv SET value=?2 WHERE key=?1 AND value!=?2")
        .map_err(error)?;
    let mut index = conn
        .prepare_cached("UPDATE record_index SET value=?2 WHERE key=?1 AND value!=?2")
        .map_err(error)?;
    for update in updates {
        let key = update["key"]
            .as_str()
            .filter(|k| k.starts_with("record:"))
            .ok_or("Invalid acknowledgement key")?;
        let target = update["target"]
            .as_str()
            .ok_or("Missing acknowledgement target")?;
        let uploaded = update["uploaded"]
            .as_u64()
            .ok_or("Invalid acknowledged frame count")?;
        let (raw, summary): (String, String) = read
            .query_row([key], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(error)?;
        let mut summary: Value = serde_json::from_str(&summary).map_err(error)?;
        if uploaded
            > summary["frameCount"]
                .as_u64()
                .ok_or("Invalid recording frame count")?
        {
            return Err("Acknowledgement exceeds source frames".into());
        }
        if summary["notionTarget"] == target && summary["uploaded"].as_u64().unwrap_or(0) > uploaded
        {
            continue;
        }
        summary["uploaded"] = json!(uploaded);
        summary["notionTarget"] = json!(target);
        let mut stored: Value = serde_json::from_str(&raw).map_err(error)?;
        let record = if stored["binaryAudio"] == 1 {
            &mut stored["record"]
        } else {
            &mut stored
        };
        record["uploaded"] = json!(uploaded);
        record["notionTarget"] = json!(target);
        write
            .execute(rusqlite::params![key, stored.to_string()])
            .map_err(error)?;
        index
            .execute(rusqlite::params![key, summary.to_string()])
            .map_err(error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readonly_source_sample_survives_binary_conversion() {
        let Ok(path) = std::env::var("UOMI_VERIFY_SOURCE") else {
            return;
        };
        let source =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut query=source.prepare("SELECT value FROM kv WHERE key>='record:' AND key<'record;' ORDER BY key LIMIT 2000").unwrap();
        let rows = query.query_map([], |r| r.get::<_, String>(0)).unwrap();
        let mut count = 0;
        let mut json_size = 0;
        let mut metadata_size = 0;
        let mut audio_size = 0;
        for row in rows {
            let raw = row.unwrap();
            let original: Value = serde_json::from_str(&raw).unwrap();
            let (metadata, bytes) = pack(&raw).unwrap();
            let decoded: Value = serde_json::from_str(&unpack(&metadata, &bytes).unwrap()).unwrap();
            assert_eq!(decoded, original);
            count += 1;
            json_size += raw.len();
            metadata_size += metadata.len();
            audio_size += bytes.len();
        }
        assert!(count > 0);
        println!("Verified {count} read-only source records: original JSON {json_size} bytes; binary {audio_size} bytes + metadata {metadata_size} bytes");
    }
    #[test]
    fn roundtrip_preserves_packets_ids_offsets_and_extras() {
        let raw=json!({"key":"record:a","deviceId":"d","frames":[{"id":"a:0","data":"+P/+","durationMs":20,"offsetMs":0,"custom":"preserve"},{"id":"other","data":"8P/+","durationMs":10,"offsetMs":25}],"uploaded":1}).to_string();
        let (metadata, bytes) = pack(&raw).unwrap();
        assert!(!metadata.contains("+P/+"));
        assert!(!metadata.contains("\"data\""));
        assert_eq!(bytes, vec![3, 0, 248, 255, 254, 3, 0, 240, 255, 254]);
        assert_eq!(
            serde_json::from_str::<Value>(&unpack(&metadata, &bytes).unwrap()).unwrap(),
            serde_json::from_str::<Value>(&raw).unwrap()
        );
        assert!(unpack(&metadata, &bytes[..9]).is_err());
    }
}
