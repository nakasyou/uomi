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

pub fn read(conn: &Connection, key: &str) -> Result<Option<String>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0))
        .optional()
        .map_err(error)?;
    let Some(raw) = raw else { return Ok(None) };
    if !key.starts_with("record:") {
        return Ok(Some(raw));
    }
    let packed: Value = serde_json::from_str(&raw).map_err(error)?;
    if packed["binaryAudio"] != 1 {
        return Ok(Some(raw));
    }
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT data FROM recording_audio WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .map_err(error)?;
    Ok(Some(unpack(&raw, &bytes)?))
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
