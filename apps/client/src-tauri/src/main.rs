#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_store;
mod credentials;
mod bulk_import;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use flate2::{
    write::{GzEncoder, ZlibEncoder},
    Compression,
};
use futures_util::StreamExt;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager as _, State};
use tokio::{io::AsyncWriteExt, process::Command, sync::Mutex as AsyncMutex};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

struct Backend {
    db: Arc<Mutex<Connection>>,
    adapter: AsyncMutex<Option<Adapter>>,
    device: AsyncMutex<Option<Peripheral>>,
    notifications: AsyncMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    mode: Mutex<String>,
    seconds: Mutex<u64>,
    ticker: tokio::sync::Notify,
    periodic: bool,
    http: reqwest::Client,
    credentials: credentials::CredentialCache,
    bulk: Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>,
    bulk_cancel: tokio::sync::Notify,
    bulk_cancelled: Mutex<std::collections::VecDeque<String>>,
}
impl Backend {
    async fn adapter(&self) -> Result<Adapter> {
        let mut cached = self.adapter.lock().await;
        if let Some(a) = cached.as_ref() {
            return Ok(a.clone());
        }
        let manager = Manager::new().await.map_err(error)?;
        let adapter = manager
            .adapters()
            .await
            .map_err(error)?
            .into_iter()
            .next()
            .ok_or("No Bluetooth adapter found. Enable Bluetooth and try again.")?;
        *cached = Some(adapter.clone());
        Ok(adapter)
    }
    async fn device(&self) -> Result<Peripheral> {
        self.device
            .lock()
            .await
            .clone()
            .ok_or("Connect an Omi before accessing audio.".into())
    }
}

fn record_index(value: &str) -> Result<String> {
    let mut record: Value = serde_json::from_str(value).map_err(error)?;
    let frames = record["frames"].as_array().ok_or("Invalid recording frames")?;
    let count = frames.len();
    let durations: Vec<f64> = frames.iter().map(|f| f["durationMs"].as_f64().unwrap_or(0.0)).collect();
    let ids: Vec<String> = frames.iter().map(|f| f["id"].as_str().unwrap_or("").to_string()).collect();
    let prefix = ids.first().and_then(|id| id.strip_suffix('0')).map(str::to_string);
    let common = prefix.as_ref().is_some_and(|p| ids.iter().enumerate().all(|(i,id)| *id == format!("{p}{i}")));
    let object = record.as_object_mut().ok_or("Invalid recording")?;
    object.remove("frames");
    object.insert("frameCount".into(), json!(count));
    object.insert("durationMs".into(), json!(durations.iter().sum::<f64>()));
    if durations.iter().all(|d| Some(d) == durations.first()) { object.insert("frameDurationMs".into(), json!(durations.first().copied().unwrap_or(20.0))); }
    else { object.insert("frameDurations".into(), json!(durations)); }
    if common { object.insert("idPrefix".into(), json!(prefix)); }
    else { object.insert("frameIds".into(), json!(ids)); }
    serde_json::to_string(&record).map_err(error)
}
fn put_value(conn: &Connection, key: &str, value: &str) -> Result<()> {
    let stored = if key.starts_with("record:") {
        let (metadata,bytes) = audio_store::pack(value)?;
        conn.execute("INSERT INTO recording_audio VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data WHERE data!=excluded.data",rusqlite::params![key,bytes]).map_err(error)?;
        metadata
    } else { value.to_string() };
    conn.execute("INSERT INTO kv VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key,stored.as_str()]).map_err(error)?;
    if key.starts_with("record:") {
        conn.execute("INSERT INTO record_index VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key,&record_index(value)?]).map_err(error)?;
    }
    if key.starts_with("notion:page:") {
        let page: Value = serde_json::from_str(value).map_err(error)?;
        let target = key.split(':').nth(2).ok_or("Missing mirror target")?;
        let device = page["properties"]["Device"]["rich_text"][0]["text"]["content"].as_str().or_else(|| page["properties"]["Device"]["rich_text"][0]["plain_text"].as_str()).unwrap_or("");
        let start = page["properties"]["Recorded at"]["date"]["start"].as_str().unwrap_or("");
        conn.execute("INSERT OR REPLACE INTO notion_index(key,target,device,start) VALUES (?1,?2,?3,(julianday(?4)-2440587.5)*86400000)",[key,target,device,start]).map_err(error)?;
    }
    Ok(())
}
fn remove_value(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM recording_audio WHERE key=?1", [key]).map_err(error)?;
    conn.execute("DELETE FROM kv WHERE key=?1", [key]).map_err(error)?;
    if key.starts_with("record:") { conn.execute("DELETE FROM record_index WHERE key=?1", [key]).map_err(error)?; }
    if key.starts_with("notion:page:") { conn.execute("DELETE FROM notion_index WHERE key=?1", [key]).map_err(error)?; }
    Ok(())
}

#[tauri::command]
async fn kv(
    state: State<'_, Arc<Backend>>,
    action: String,
    key: String,
    value: Option<String>,
) -> Result<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(error)?;
        match action.as_str() {
            "optimizeAudio" => {
                let rows = {
                    let mut query=conn.prepare("SELECT k.key,k.value FROM kv k LEFT JOIN recording_audio a ON a.key=k.key WHERE k.key>='record:' AND k.key<'record;' AND a.key IS NULL LIMIT 128").map_err(error)?;
                    let rows=query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(error)?; rows
                };
                let count=rows.len(); let tx=conn.transaction().map_err(error)?;
                for (key,value) in rows {put_value(&tx,&key,&value)?;}
                tx.commit().map_err(error)?; Ok(json!(count))
            },
            "get" => Ok(audio_store::read(&conn,&key)?.map_or(Value::Null, Value::String)),
            "put" => { let tx = conn.transaction().map_err(error)?; put_value(&tx,&key,&value.ok_or("Missing value")?)?; tx.commit().map_err(error)?; Ok(Value::Null) },
            "remove" => { let tx = conn.transaction().map_err(error)?; remove_value(&tx,&key)?; tx.commit().map_err(error)?; Ok(Value::Null) },
            "batch" => {
                let batch: Value = serde_json::from_str(&value.ok_or("Missing batch")?).map_err(error)?;
                let tx = conn.transaction().map_err(error)?;
                for entry in batch["puts"].as_array().ok_or("Missing puts")? { put_value(&tx,entry["key"].as_str().ok_or("Missing key")?,entry["value"].as_str().ok_or("Missing value")?)?; }
                for entry in batch["removes"].as_array().ok_or("Missing removes")? { remove_value(&tx,entry.as_str().ok_or("Missing key")?)?; }
                tx.commit().map_err(error)?; Ok(Value::Null)
            },
            "getMany" => {
                let keys: Vec<String> = serde_json::from_str(&value.ok_or("Missing keys")?).map_err(error)?;
                if keys.len()>256 {return Err("Too many storage keys".into());}
                let mut out = Vec::new();
                for key in keys { if let Some(value) = audio_store::read(&conn,&key)? {out.push(json!({"key":key,"value":value}));} }
                Ok(json!(out))
            },
            "mirror" => {
                let request: Value = serde_json::from_str(&value.ok_or("Missing query")?).map_err(error)?;
                let target = request["target"].as_str().ok_or("Missing target")?;
                let lower = request["from"].as_f64().map(|v| format!("{}", v-900000.0));
                let upper = request["until"].as_f64().map(|v| format!("{}", v));
                let devices = request["devices"].as_array().cloned().unwrap_or_default();
                let count_only=request["countOnly"].as_bool().unwrap_or(false);
                let mut sql = format!("SELECT {} FROM notion_index i JOIN kv k ON k.key=i.key WHERE i.target=?",if count_only {"COUNT(*)"} else {"k.value"});
                let mut params = vec![rusqlite::types::Value::Text(target.to_string())];
                if let Some(lower) = lower {sql.push_str(" AND (i.start IS NULL OR i.start>=?)");params.push(rusqlite::types::Value::Real(lower.parse().map_err(error)?));}
                if let Some(upper) = upper {sql.push_str(" AND (i.start IS NULL OR i.start<=?)");params.push(rusqlite::types::Value::Real(upper.parse().map_err(error)?));}
                if !devices.is_empty() {sql.push_str(&format!(" AND i.device IN ({})",vec!["?";devices.len()].join(","))); for device in devices {params.push(rusqlite::types::Value::Text(device.as_str().ok_or("Invalid device")?.to_string()));}}
                if let Some(search)=request["search"].as_str() {sql.push_str(" AND instr(lower(k.value),lower(?))>0");params.push(rusqlite::types::Value::Text(search.to_string()));}
                if count_only {
                    return Ok(json!(conn.query_row(&sql,rusqlite::params_from_iter(params),|r|r.get::<_,i64>(0)).map_err(error)?));
                }
                sql.push_str(" ORDER BY i.start DESC,i.key DESC LIMIT ? OFFSET ?");
                params.push(rusqlite::types::Value::Integer(request["limit"].as_i64().unwrap_or(1000).clamp(1,10000)));
                params.push(rusqlite::types::Value::Integer(request["offset"].as_i64().unwrap_or(0).max(0)));
                let mut query=conn.prepare(&sql).map_err(error)?;
                let rows=query.query_map(rusqlite::params_from_iter(params),|r|r.get::<_,String>(0)).map_err(error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
                Ok(json!(rows))
            },
            "catalog" => {
                let after = value.unwrap_or_default();
                let rows = {
                    let mut query = conn.prepare("SELECT k.key, CASE WHEN i.key IS NULL THEN k.value ELSE '' END, i.value FROM kv k LEFT JOIN record_index i ON k.key=i.key WHERE k.key> ?1 AND k.key>='record:' AND k.key<'record;' ORDER BY k.key LIMIT 256").map_err(error)?;
                    let rows = query.query_map([after], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).map_err(error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
                    rows
                };
                let tx = conn.transaction().map_err(error)?;
                let mut out = Vec::new();
                for (key,raw,cached) in rows {
                    let summary = match cached { Some(value) => value, None => {let index=record_index(&raw)?; tx.execute("INSERT OR REPLACE INTO record_index VALUES (?1,?2)",[&key,&index]).map_err(error)?; index} };
                    out.push(json!({"key":key,"value":summary}));
                }
                tx.commit().map_err(error)?; Ok(json!(out))
            },
            "entries" => {
                let mut query = conn.prepare("SELECT key,value FROM kv WHERE key>=?1 AND key<?2 AND key>?3 ORDER BY key LIMIT 256").map_err(error)?;
                let upper = format!("{}\u{10ffff}", key);
                let values = query.query_map(rusqlite::params![key, upper, value.unwrap_or_default()], |r| Ok(json!({"key":r.get::<_,String>(0)?, "value":r.get::<_,String>(1)?}))).map_err(error)?
                    .collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
                let mut out=Vec::new();
                for entry in values {let key=entry["key"].as_str().ok_or("Invalid key")?;out.push(json!({"key":key,"value":audio_store::read(&conn,key)?}));}
                Ok(json!(out))
            },
            "list" => {
                let mut query = conn.prepare("SELECT key FROM kv WHERE substr(key,1,?1)=?2 ORDER BY key").map_err(error)?;
                let values = query.query_map(rusqlite::params![key.len(), key], |r| r.get::<_,String>(0)).map_err(error)?
                    .collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
                Ok(json!(values))
            },
            _ => Err("Unknown storage operation".into()),
        }
    }).await.map_err(error)?
}

async fn stored_credential(state: &Backend,name: &str) -> Result<String> {
    state.credentials.read(name,|| lookup_credential(name)).await
}
async fn lookup_credential(name: &str) -> Result<String> {
    let output = tokio::time::timeout(Duration::from_secs(10), Command::new("secret-tool")
        .kill_on_drop(true)
        .args(["lookup", "application", "me.uomi.client", "key", name])
        .output()).await.map_err(|_| "Linux keyring lookup timed out. Unlock your keyring and retry.".to_string())?
        .map_err(|_| "Install libsecret-tools and start a Secret Service keyring (GNOME Keyring or KWallet).".to_string())?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end_matches('\n')
            .to_string());
    }
    if output.status.code() == Some(1) && output.stderr.is_empty() {
        return Ok(String::new());
    }
    Err("Your Linux keyring is unavailable or locked. Unlock it and try again.".into())
}
#[tauri::command]
async fn secret(state: State<'_,Arc<Backend>>,value: Option<String>) -> Result<String> { credential(state,"webhook".into(), value).await }
#[tauri::command]
async fn credential(state: State<'_,Arc<Backend>>,name: String, value: Option<String>) -> Result<String> {
    if !["notion", "transcriber", "webhook", "sites-api", "sites-access"].contains(&name.as_str()) { return Err("Unknown credential".into()); }
    let Some(value)=value else {return stored_credential(&state,&name).await};
    if value.contains(['\n','\r']) {return Err("The secret cannot contain line breaks.".into());}
    state.credentials.write(&name,&value,||async {
        if value.is_empty() {
            let output=tokio::time::timeout(Duration::from_secs(15),Command::new("secret-tool").kill_on_drop(true)
                .args(["clear","application","me.uomi.client","key",&name]).output()).await
                .map_err(|_|"Linux keyring clear timed out".to_string())?.map_err(|_|"Could not access the Linux keyring".to_string())?;
            if !output.status.success() {return Err("Could not clear your Linux keyring secret".into());}
        } else {
            let mut child=Command::new("secret-tool").kill_on_drop(true)
                .args(["store","--label=Uomi connection credential","application","me.uomi.client","key",&name])
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped())
                .spawn().map_err(|_|"Could not access the Linux keyring".to_string())?;
            let mut input=child.stdin.take().ok_or("Could not open keyring input")?;
            input.write_all(value.as_bytes()).await.map_err(|_|"Could not write credential to keyring".to_string())?;drop(input);
            let output=tokio::time::timeout(Duration::from_secs(15),child.wait_with_output()).await
                .map_err(|_|"Linux keyring save timed out. Unlock it and retry.".to_string())?.map_err(|_|"Could not save the credential".to_string())?;
            if !output.status.success() {return Err("Could not save the credential. Unlock your Linux keyring and retry.".into());}
        }
        Ok(())
    }).await
}

#[tauri::command]
async fn notion(state: State<'_, Arc<Backend>>, request: Value) -> Result<Value> {
    let path = request["path"].as_str().ok_or("Missing Notion path")?;
    if !path.starts_with('/') || path.contains("..") || path.contains(['?', '#', '\\']) || path.contains("://") {
        return Err("Invalid Notion path".into());
    }
    let token = stored_credential(&state,"notion").await?;
    if token.is_empty() { return Err("Set a Notion connection token in Settings.".into()); }
    let method = match request["method"].as_str() { Some("GET") => reqwest::Method::GET, Some("POST") => reqwest::Method::POST, Some("PATCH") => reqwest::Method::PATCH, _ => return Err("Unsupported Notion method".into()) };
    let mut req = state.http.request(method, format!("https://api.notion.com/v1{path}"))
        .header("Authorization", format!("Bearer {token}")).header("Notion-Version", "2025-09-03");
    if request["upload"].is_object() {
        let upload = &request["upload"];
        let bytes = B64.decode(upload["base64"].as_str().ok_or("Missing file bytes")?).map_err(error)?;
        let part = reqwest::multipart::Part::bytes(bytes).file_name(upload["filename"].as_str().unwrap_or("audio.ogg").to_string()).mime_str(upload["contentType"].as_str().unwrap_or("application/octet-stream")).map_err(error)?;
        let mut form = reqwest::multipart::Form::new().part("file", part);
        if let Some(n) = upload["part"].as_u64() { form = form.text("part_number", n.to_string()); }
        req = req.multipart(form);
    } else if !request["body"].is_null() { req = req.json(&request["body"]); }
    let response = req.send().await.map_err(|_| "Notion connection failed. Your local audio is retained.".to_string())?;
    if !response.status().is_success() {
        return Err(format!("Notion HTTP {}. Check connection permissions and retry.{}", response.status().as_u16(), response.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(|v| format!(" Retry after {v}s.")).unwrap_or_default()));
    }
    response.json().await.map_err(|_| "Invalid Notion response".into())
}
#[tauri::command]
async fn verify_notion_audio(state: State<'_, Arc<Backend>>, url: String, sha256: String, download: Option<bool>) -> Result<Option<String>> {
    let url = reqwest::Url::parse(&url).map_err(error)?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() { return Err("Invalid audio attachment URL".into()); }
    let response = state.http.get(url).send().await.map_err(|_| "Could not verify audio; local audio is retained".to_string())?;
    if !response.status().is_success() { return Err("Could not verify audio; local audio is retained".into()); }
    let mut stream = response.bytes_stream();
    let mut digest = Sha256::new(); let mut length = 0usize; let mut audio=download.unwrap_or(false).then(Vec::new);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Audio verification interrupted; local audio is retained".to_string())?;
        length += chunk.len(); if length > 64*1024*1024 { return Err("Audio verification limit exceeded; local audio is retained".into()); }
        digest.update(&chunk); if let Some(ref mut audio)=audio {audio.extend_from_slice(&chunk);}
    }
    if format!("{:x}",digest.finalize()) != sha256 { return Err("Audio verification hash mismatch; local audio is retained".into()); }
    Ok(audio.map(|bytes| B64.encode(bytes)))
}

#[tauri::command]
async fn notion_file(state: State<'_, Arc<Backend>>, page_id: String, property: String, file_url: Option<String>) -> Result<String> {
    if !page_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || !["Transcript", "Manifest"].contains(&property.as_str()) { return Err("Invalid attachment request".into()); }
    let url = if let Some(url) = file_url { url } else {
        let page = notion(state.clone(), json!({"path":format!("/pages/{page_id}"),"method":"GET"})).await?;
        page["properties"][&property]["files"][0]["file"]["url"].as_str().ok_or("No attachment available")?.to_string()
    };
    if !url.starts_with("https://") { return Err("Invalid Notion attachment URL".into()); }
    let response = state.http.get(url).send().await.map_err(|_| "Could not fetch Notion attachment".to_string())?;
    if !response.status().is_success() { return Err("Could not fetch Notion attachment".into()); }
    let mut stream=response.bytes_stream(); let mut bytes=Vec::new();
    while let Some(chunk)=stream.next().await {let chunk=chunk.map_err(|_| "Could not read attachment".to_string())?;if bytes.len()+chunk.len()>32*1024*1024{return Err("Attachment is too large".into());}bytes.extend_from_slice(&chunk);}
    String::from_utf8(bytes).map_err(|_| "Invalid attachment text".into())
}
#[tauri::command]
async fn transcriber_reserve(state: State<'_, Arc<Backend>>, endpoint: String, manifest: Value, source: String) -> Result<String> {
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "Invalid transcriber URL".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {return Err("Use an HTTPS transcriber URL".into());}
    let url = url.join("reserve").map_err(error)?;
    let token = stored_credential(&state,"transcriber").await?;
    if token.is_empty() {return Err("Set a transcriber secret to coordinate Notion uploads".into());}
    let body = json!({"id":manifest["id"],"sha256":manifest["sha256"],"deviceId":manifest["deviceId"],"capturedAt":manifest["capturedAt"],"durationMs":manifest["durationMs"],"frameIds":manifest["frameIds"],"gaps":manifest["gaps"],"source":source});
    let response = state.http.post(url).bearer_auth(token).json(&body).send().await.map_err(|_| "The upload coordinator is unavailable. Local audio is retained.".to_string())?;
    if !response.status().is_success() {return Err("The upload coordinator could not reserve this recording. Check its database and secret; local audio is retained.".into());}
    let result:Value=response.json().await.map_err(error)?;
    let id=result["pageId"].as_str().ok_or("Invalid reservation response")?;
    if id.len()<32 || !id.chars().all(|c|c.is_ascii_hexdigit()||c=='-') {return Err("Invalid reserved page ID".into());}
    Ok(id.to_string())
}

#[tauri::command]
async fn transcriber_notify(state: State<'_, Arc<Backend>>, endpoint: String, page_id: String) -> Result<()> {
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "Invalid transcriber URL".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() { return Err("Use an HTTPS transcriber URL".into()); }
    let token = stored_credential(&state,"transcriber").await?;
    if token.is_empty() { return Err("Set a transcriber webhook secret".into()); }
    let result = state.http.post(url).timeout(Duration::from_secs(15)).bearer_auth(token).json(&json!({"pageId":page_id})).send().await.map_err(|_| "Audio is in Notion, but the transcriber could not be reached. Retry notification.".to_string())?;
    if !result.status().is_success() { return Err(format!("Transcriber HTTP {}. Audio is already saved in Notion.",result.status().as_u16())); }
    Ok(())
}

#[tauri::command]
fn hash(value: String) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(B64.decode(value).map_err(error)?)
    ))
}

#[derive(Serialize)]
struct Device {
    address: String,
    name: String,
}
#[tauri::command]
async fn scan(state: State<'_, Arc<Backend>>) -> Result<Vec<Device>> {
    let adapter = state.adapter().await?;
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(error)?;
    tokio::time::sleep(Duration::from_secs(7)).await;
    let mut result = Vec::new();
    for p in adapter.peripherals().await.map_err(error)? {
        if let Some(properties) = p.properties().await.map_err(error)? {
            let name = properties.local_name.unwrap_or_default();
            if name.to_lowercase().contains("omi")
                || name.to_lowercase().contains("friend")
                || properties
                    .services
                    .iter()
                    .any(|uuid| uuid.to_string() == "19b10000-e8f2-537e-4f6c-d104768a1214")
            {
                result.push(Device {
                    address: p.id().to_string(),
                    name,
                });
            }
        }
    }
    adapter.stop_scan().await.map_err(error)?;
    Ok(result)
}
#[tauri::command]
async fn disconnect(state: State<'_, Arc<Backend>>) -> Result<()> {
    if let Some(task) = state.notifications.lock().await.take() {
        task.abort();
    }
    if let Some(p) = state.device.lock().await.take() {
        let _ = p.disconnect().await;
    }
    Ok(())
}
#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    state: State<'_, Arc<Backend>>,
    address: String,
) -> Result<()> {
    if let Some(p) = state.device.lock().await.as_ref() {
        if p.id().to_string() == address && p.is_connected().await.map_err(error)? {
            return Ok(());
        }
    }
    disconnect(state.clone()).await?;
    let adapter = state.adapter().await?;
    let mut found = None;
    for attempt in 0..2 {
        for p in adapter.peripherals().await.map_err(error)? {
            if p.id().to_string() == address {
                found = Some(p);
                break;
            }
        }
        if found.is_some() {
            break;
        }
        if attempt == 0 {
            adapter
                .start_scan(ScanFilter::default())
                .await
                .map_err(error)?;
            tokio::time::sleep(Duration::from_secs(5)).await;
            adapter.stop_scan().await.map_err(error)?;
        }
    }
    let p = found.ok_or("Your Omi was not found. Keep it nearby and try syncing again.")?;
    // Keep ownership before connecting so error cleanup can close a partially
    // established link, including a service-discovery failure.
    *state.device.lock().await = Some(p.clone());
    if !p.is_connected().await.map_err(error)? {
        tokio::time::timeout(Duration::from_secs(20), p.connect())
            .await
            .map_err(|_| {
                "Bluetooth connection timed out. Move Omi closer and try again.".to_string()
            })?
            .map_err(error)?;
    }
    tokio::time::timeout(Duration::from_secs(20), p.discover_services())
        .await
        .map_err(|_| "Omi service discovery timed out. Try reconnecting.".to_string())?
        .map_err(error)?;
    let mut stream = p.notifications().await.map_err(error)?;
    let bulk_state=state.inner().clone();
    *state.notifications.lock().await = Some(tauri::async_runtime::spawn(async move {
        let trace = bulk_import::trace_enabled();
        let mut trace_last = std::time::Instant::now();
        let mut blocked_sends = 0u64;
        let mut blocked_ms = 0.0f64;
        let mut max_blocked_ms = 0.0f64;
        while let Some(n) = stream.next().await {
            // Custody firmware may require a live subscription to persist connected
            // audio; canonical import uses the ring and discards this duplicate stream.
            if n.uuid.to_string() == "19b10001-e8f2-537e-4f6c-d104768a1214" && bulk_state.bulk.lock().map(|v|v.is_some()).unwrap_or(false) {continue;}
            if n.uuid.to_string() == "30295781-4301-eabd-2904-2849adfeae43" && matches!(n.value.first(),Some(3|4|5)) {
                let target=bulk_state.bulk.lock().ok().and_then(|guard|guard.clone());
                if let Some(target)=target {
                    let full = trace && target.capacity() == 0;
                    let began = std::time::Instant::now();
                    let is_done = n.value.first() == Some(&4);
                    let sent = target.send(n.value).await.is_ok();
                    if full {
                        let ms = began.elapsed().as_secs_f64()*1000.0;
                        blocked_sends += 1;
                        blocked_ms += ms;
                        max_blocked_ms = max_blocked_ms.max(ms);
                        if trace_last.elapsed() >= Duration::from_secs(2) {
                            eprintln!("UOMI_BLE_TRACE {}", json!({"event":"receiver_backpressure","blocked_sends":blocked_sends,"blocked_ms":blocked_ms,"max_blocked_ms":max_blocked_ms,"send_ok":sent}));
                            trace_last = std::time::Instant::now();
                            blocked_sends = 0; blocked_ms = 0.0; max_blocked_ms = 0.0;
                        }
                    }
                    // Flush the last partial window at protocol DONE, too.
                    if trace && blocked_sends > 0 && is_done {
                        eprintln!("UOMI_BLE_TRACE {}", json!({"event":"receiver_backpressure","blocked_sends":blocked_sends,"blocked_ms":blocked_ms,"max_blocked_ms":max_blocked_ms}));
                        blocked_sends = 0; blocked_ms = 0.0; max_blocked_ms = 0.0;
                    }
                    continue;
                }
            }
            let _ = app.emit(
                "uomi:ble",
                json!({"char":n.uuid.to_string(),"data":B64.encode(n.value)}),
            );
        }
    }));
    *state.device.lock().await = Some(p);
    Ok(())
}
async fn characteristic(
    state: &Backend,
    service: &str,
    char: &str,
) -> Result<(Peripheral, btleplug::api::Characteristic)> {
    let device = state.device().await?;
    let service = Uuid::parse_str(service).map_err(error)?;
    let char = Uuid::parse_str(char).map_err(error)?;
    let characteristic = device
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == char && c.service_uuid == service)
        .ok_or_else(|| format!("The device does not expose BLE characteristic {char} in service {service}."))?;
    Ok((device, characteristic))
}
#[tauri::command]
async fn read(state: State<'_, Arc<Backend>>, service: String, char: String) -> Result<String> {
    let (p, c) = characteristic(&state, &service, &char).await?;
    Ok(B64.encode(p.read(&c).await.map_err(error)?))
}
#[tauri::command]
async fn write(
    state: State<'_, Arc<Backend>>,
    service: String,
    char: String,
    value: String,
) -> Result<()> {
    let (p, c) = characteristic(&state, &service, &char).await?;
    p.write(
        &c,
        &B64.decode(value).map_err(error)?,
        WriteType::WithResponse,
    )
    .await
    .map_err(error)
}
#[tauri::command]
async fn notify(
    state: State<'_, Arc<Backend>>,
    service: String,
    char: String,
    enabled: bool,
) -> Result<()> {
    let (p, c) = characteristic(&state, &service, &char).await?;
    if enabled {
        p.subscribe(&c).await.map_err(error)
    } else {
        p.unsubscribe(&c).await.map_err(error)
    }
}
#[tauri::command]
async fn wifi() -> bool {
    Command::new("nmcli")
        .args(["-t", "-f", "TYPE,STATE", "device"])
        .output()
        .await
        .map(|o| {
            o.status.success()
                && String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .any(|l| l == "wifi:connected")
        })
        .unwrap_or(false)
}

async fn systemctl(args: &[&str]) -> Result<()> {
    let result = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .await
        .map_err(error)?;
    if !result.status.success() {
        return Err("Could not configure the systemd user timer. Start a systemd user session and try again.".into());
    }
    Ok(())
}
fn unit_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('%', "%%")
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace(['\n', '\r'], "")
    )
}
#[tauri::command]
async fn schedule(state: State<'_, Arc<Backend>>, settings: Value) -> Result<()> {
    let mode = settings["mode"].as_str().ok_or("Missing sync mode")?;
    if !["manual", "realtime", "periodic"].contains(&mode) {
        return Err("Invalid sync mode".into());
    }
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let dir = PathBuf::from(home).join(".config/systemd/user");
    if mode == "periodic" {
        let exe = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe().map_err(error)?);
        std::fs::create_dir_all(&dir).map_err(error)?;
        std::fs::write(dir.join("uomi-sync.service"),format!("[Unit]\nDescription=Uomi Wi-Fi audio sync\n[Service]\nType=oneshot\nExecStart={} --periodic\nTimeoutStartSec=9min\n",unit_quote(&exe.to_string_lossy()))).map_err(error)?;
        std::fs::write(dir.join("uomi-sync.timer"),"[Unit]\nDescription=Check Uomi periodic sync\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=15min\nPersistent=true\n[Install]\nWantedBy=timers.target\n").map_err(error)?;
        systemctl(&["daemon-reload"]).await?;
        systemctl(&["enable", "--now", "uomi-sync.timer"]).await?;
    } else if dir.join("uomi-sync.timer").exists() {
        systemctl(&["disable", "--now", "uomi-sync.timer"]).await?;
        for name in ["uomi-sync.timer", "uomi-sync.service"] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        systemctl(&["daemon-reload"]).await?;
    }
    *state.mode.lock().map_err(error)? = mode.to_string();
    *state.seconds.lock().map_err(error)? = settings["segmentSeconds"]
        .as_u64()
        .unwrap_or(30)
        .clamp(1, 900);
    state.ticker.notify_one();
    Ok(())
}
#[tauri::command]
async fn post(
    state: State<'_, Arc<Backend>>,
    endpoint: String,
    header: String,
    body: String,
    compression: String,
    id: String,
) -> Result<bool> {
    let url = reqwest::Url::parse(&endpoint).map_err(error)?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Use an HTTPS webhook URL without credentials.".into());
    }
    let secret = stored_credential(&state,"sites-api").await?;
    if secret.is_empty() {
        return Err("Set your webhook secret in Settings.".into());
    }
    let bytes = match compression.as_str() {
        "gzip" => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(body.as_bytes()).map_err(error)?;
            encoder.finish().map_err(error)?
        }
        "deflate" => {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(body.as_bytes()).map_err(error)?;
            encoder.finish().map_err(error)?
        }
        "none" => body.into_bytes(),
        _ => return Err("Unsupported compression".into()),
    };
    let mut request = state
        .http
        .post(url)
        .header("Content-Type", "application/vnd.uomi.audio+json")
        .header(header, secret)
        .header("Idempotency-Key", id)
        .header("X-Uomi-Schema", "1")
        .body(bytes);
    let access = stored_credential(&state,"sites-access").await?;
    if !access.is_empty() { request = request.header("OAI-Sites-Authorization", format!("Bearer {access}")); }
    if compression != "none" {
        request = request.header("Content-Encoding", compression);
    }
    let response = request.send().await.map_err(|_| {
        "Webhook could not be reached. Check the endpoint and network; your audio stays queued."
            .to_string()
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "Webhook returned HTTP {}. Audio stays queued; sync again to retry.",
            response.status().as_u16()
        ));
    }
    let receipt: Value = response.json().await.map_err(error)?;
    Ok(receipt["notion_saved"].as_bool().unwrap_or(false))
}
#[tauri::command]
fn smoke_ready(app: tauri::AppHandle) {
    if cfg!(debug_assertions) && std::env::var_os("UOMI_SMOKE_TEST").is_some() {
        println!("UOMI_TAURI_SMOKE_OK");
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            app.exit(0);
        });
    }
}
#[tauri::command]
fn is_periodic(state: State<'_, Arc<Backend>>) -> bool {
    state.periodic
}
#[tauri::command]
fn finish_periodic(app: tauri::AppHandle, state: State<'_, Arc<Backend>>, success: bool) {
    if state.periodic {
        app.exit(if success { 0 } else { 1 });
    }
}

fn main() {
    let periodic = std::env::args().any(|arg| arg == "--periodic");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,args,_| {
            if args.iter().any(|a| a == "--periodic") { let _ = app.emit("uomi:periodic",()); }
            else if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = Connection::open(dir.join("uomi.sqlite"))?;
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recording_audio (key TEXT PRIMARY KEY,data BLOB NOT NULL); CREATE TABLE IF NOT EXISTS record_index (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notion_index(key TEXT PRIMARY KEY,target TEXT NOT NULL,device TEXT NOT NULL,start REAL); CREATE INDEX IF NOT EXISTS notion_time ON notion_index(target,start,device)")?;
            let state = Arc::new(Backend { db: Arc::new(Mutex::new(conn)), adapter: AsyncMutex::new(None), device: AsyncMutex::new(None), notifications: AsyncMutex::new(None), mode: Mutex::new("manual".into()), seconds: Mutex::new(30), ticker: tokio::sync::Notify::new(), periodic, credentials: credentials::CredentialCache::default(), bulk: Mutex::new(None), bulk_cancel: tokio::sync::Notify::new(), bulk_cancelled: Mutex::new(std::collections::VecDeque::new()), http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120)).build()? });
            app.manage(state.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let mode = state.mode.lock().unwrap().clone();
                    if mode != "realtime" {
                        // Sleep until settings change: Manual/Periodic have no
                        // continuously waking real-time timer.
                        state.ticker.notified().await;
                        continue;
                    }
                    let seconds = *state.seconds.lock().unwrap();
                    if tokio::time::timeout(Duration::from_secs(seconds), state.ticker.notified()).await.is_err() {
                        let _ = handle.emit("uomi:tick",());
                    }
                }
            });
            use tauri::menu::{Menu,MenuItem};
            let open = MenuItem::with_id(app,"open","Open Uomi",true,None::<&str>)?;
            let quit = MenuItem::with_id(app,"quit","Quit Uomi",true,None::<&str>)?;
            let menu = Menu::with_items(app,&[&open,&quit])?;
            tauri::tray::TrayIconBuilder::new().icon(app.default_window_icon().ok_or("Missing app icon")?.clone()).tooltip("Uomi").menu(&menu)
                .on_menu_event(|app,event| match event.id.as_ref() { "open" => if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}, "quit"=>app.exit(0), _=>{} }).build(app)?;
            if periodic { if let Some(window) = app.get_webview_window("main") { window.hide()?; } }
            Ok(())
        })
        .on_window_event(|window,event| {
            match event {
                tauri::WindowEvent::CloseRequested {api,..} => {
                    let state = window.state::<Arc<Backend>>();
                    if *state.mode.lock().unwrap() == "realtime" { api.prevent_close(); let _=window.hide(); let _=window.emit("uomi:active",false); }
                },
                // Focus can move to a notification, screenshot tool, or another
                // window while Uomi remains visible. Only minimization means
                // the manual-mode desktop session has left the foreground.
                tauri::WindowEvent::Focused(true) => {let _=window.emit("uomi:active",true);},
                tauri::WindowEvent::Resized(_) => {
                    if let Ok(minimized) = window.is_minimized() {
                        let _=window.emit("uomi:active",!minimized);
                    }
                },
                _=>{}
            }
        })
        .invoke_handler(tauri::generate_handler![bulk_import::import_ring,bulk_import::cancel_import,kv,secret,credential,notion,notion_file,verify_notion_audio,transcriber_notify,transcriber_reserve,hash,scan,connect,disconnect,read,write,notify,wifi,schedule,post,is_periodic,finish_periodic,smoke_ready])
        .run(tauri::generate_context!()).expect("Uomi could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unit_paths_are_escaped_without_shell_interpretation() {
        assert_eq!(unit_quote("/tmp/app name%v"), "\"/tmp/app name%%v\"");
        assert_eq!(unit_quote("a\"b\\c\nd"), "\"a\\\"b\\\\cd\"");
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;
    fn database() -> Connection {
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE recording_audio(key TEXT PRIMARY KEY,data BLOB NOT NULL); CREATE TABLE record_index(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE notion_index(key TEXT PRIMARY KEY,target TEXT,device TEXT,start REAL);").unwrap();
        conn
    }
    fn recording() -> String {
        json!({"key":"record:one","deviceId":"omi","sequence":"1","ringId":null,"capturedAt":null,"timestampRaw":1,"timing":"device-uptime","uploaded":0,"bytes":444,"receivedAt":"2026-01-01T00:00:00Z","frames":[{"id":"packet:0","data":"+P/+","durationMs":20,"offsetMs":0},{"id":"packet:1","data":"+P/+","durationMs":20,"offsetMs":20}]}).to_string()
    }
    #[test]
    fn compact_catalog_keeps_frame_identity_and_duration_without_audio() {
        let index:Value=serde_json::from_str(&record_index(&recording()).unwrap()).unwrap();
        assert!(index.get("frames").is_none());
        assert_eq!(index["idPrefix"],"packet:");
        assert_eq!(index["frameCount"],2);
        assert_eq!(index["durationMs"],40.0);
        assert_eq!(index["frameDurationMs"],20.0);
    }
    #[test]
    fn binary_migration_is_atomic_and_legacy_remains_readable() {
        let mut conn=database();let original=recording();
        conn.execute("INSERT INTO kv VALUES ('record:one',?1)",[&original]).unwrap();
        assert_eq!(audio_store::read(&conn,"record:one").unwrap().unwrap(),original);
        {let tx=conn.transaction().unwrap();put_value(&tx,"record:one",&original).unwrap();}
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM recording_audio",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(audio_store::read(&conn,"record:one").unwrap().unwrap(),original);
        {let tx=conn.transaction().unwrap();put_value(&tx,"record:one",&original).unwrap();tx.commit().unwrap();}
        assert_eq!(audio_store::read(&conn,"record:one").unwrap().unwrap(),original);
        let stored:String=conn.query_row("SELECT value FROM kv WHERE key='record:one'",[],|r|r.get(0)).unwrap();
        assert!(!stored.contains("+P/+"));
        let mut acknowledged:Value=serde_json::from_str(&original).unwrap();acknowledged["uploaded"]=json!(1);
        {let tx=conn.transaction().unwrap();put_value(&tx,"record:one",&acknowledged.to_string()).unwrap();tx.commit().unwrap();}
        assert_eq!(serde_json::from_str::<Value>(&audio_store::read(&conn,"record:one").unwrap().unwrap()).unwrap(),acknowledged);
    }
    #[test]
    fn rollback_preserves_originals_and_removal_commits_with_its_tombstone() {
        let mut conn=database();let original=recording();
        put_value(&conn,"record:one",&original).unwrap();
        {let tx=conn.transaction().unwrap();put_value(&tx,"seen:record:one","record:one").unwrap();remove_value(&tx,"record:one").unwrap();}
        assert_eq!(audio_store::read(&conn,"record:one").unwrap().unwrap(),original);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM kv WHERE key LIKE 'seen:%'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        {let tx=conn.transaction().unwrap();put_value(&tx,"seen:record:one","record:one").unwrap();remove_value(&tx,"record:one").unwrap();tx.commit().unwrap();}
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM record_index",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM recording_audio",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM kv WHERE key LIKE 'seen:%'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
}
