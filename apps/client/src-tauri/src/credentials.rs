//! Session-only credential cache. Reads and explicit writes share one serialized gate.
use super::*;
use std::{collections::HashMap, future::Future};

#[derive(Default)]
pub struct CredentialCache {
    values: AsyncMutex<HashMap<String, String>>,
}
impl CredentialCache {
    pub async fn read<F, Fut>(&self, name: &str, mut load: F) -> Result<String>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<String>>,
    {
        let mut values = self.values.lock().await;
        if let Some(value) = values.get(name) {
            return Ok(value.clone());
        }
        let mut last = Ok(String::new());
        let mut had_error = false;
        for attempt in 0..3 {
            last = load().await;
            had_error |= last.is_err();
            if let Ok(value) = &last {
                if !value.is_empty() {
                    values.insert(name.into(), value.clone());
                    return Ok(value.clone());
                }
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(150 * (attempt + 1))).await;
            }
        }
        // Never report a partly failed lookup as definitive absence.
        if had_error && last.as_ref().is_ok_and(|value| value.is_empty()) {
            return Err("Could not reliably read the Linux keyring. Unlock it and retry.".into());
        }
        // Never cache a failed or empty lookup. A later unlock/save can recover.
        last
    }
    pub async fn write<F, Fut>(&self, name: &str, value: &str, persist: F) -> Result<String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let mut values = self.values.lock().await;
        persist().await?;
        if value.is_empty() {
            values.remove(name);
        } else {
            values.insert(name.into(), value.into());
        }
        Ok(value.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn concurrent_requests_read_the_keyring_once_and_reuse_the_successful_value() {
        let cache = Arc::new(CredentialCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for _ in 0..12 {
            let cache = cache.clone();
            let calls = calls.clone();
            jobs.push(tokio::spawn(async move {
                cache
                    .read("notion", || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok("test-value".into())
                    })
                    .await
                    .unwrap()
            }));
        }
        for job in jobs {
            assert_eq!(job.await.unwrap(), "test-value");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            cache
                .read("notion", || async {
                    Err("temporary keyring failure".into())
                })
                .await
                .unwrap(),
            "test-value"
        );
    }
    #[tokio::test]
    async fn transient_empty_or_error_lookups_retry_without_becoming_a_missing_token() {
        let cache = CredentialCache::default();
        let calls = AtomicUsize::new(0);
        let result = cache
            .read("notion", || async {
                match calls.fetch_add(1, Ordering::SeqCst) {
                    0 => Ok(String::new()),
                    1 => Err("locked".into()),
                    _ => Ok("recovered".into()),
                }
            })
            .await
            .unwrap();
        assert_eq!(result, "recovered");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn an_unreliable_empty_lookup_is_not_cached_and_can_recover_later() {
        let cache = CredentialCache::default();
        let calls = AtomicUsize::new(0);
        let result = cache
            .read("notion", || async {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err("locked".into())
                } else {
                    Ok(String::new())
                }
            })
            .await;
        assert!(result.unwrap_err().contains("keyring"));
        assert_eq!(
            cache
                .read("notion", || async { Ok("recovered".into()) })
                .await
                .unwrap(),
            "recovered"
        );
    }
    #[tokio::test]
    async fn explicit_save_waits_for_inflight_reads_and_cannot_be_overwritten_by_them() {
        let cache = Arc::new(CredentialCache::default());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, finish) = tokio::sync::oneshot::channel();
        let reader_cache = cache.clone();
        let reader = tokio::spawn(async move {
            let mut started = Some(started);
            let mut finish = Some(finish);
            reader_cache
                .read("notion", || {
                    let started = started.take().unwrap();
                    let finish = finish.take().unwrap();
                    async move {
                        let _ = started.send(());
                        let _ = finish.await;
                        Ok("old".into())
                    }
                })
                .await
                .unwrap()
        });
        ready.await.unwrap();
        let writer_cache = cache.clone();
        let writer = tokio::spawn(async move {
            writer_cache
                .write("notion", "new", || async { Ok(()) })
                .await
                .unwrap()
        });
        release.send(()).unwrap();
        assert_eq!(reader.await.unwrap(), "old");
        assert_eq!(writer.await.unwrap(), "new");
        assert_eq!(
            cache
                .read("notion", || async { panic!("must use saved value") })
                .await
                .unwrap(),
            "new"
        );
    }
    #[tokio::test]
    async fn successful_edits_replace_cache_failed_edits_preserve_it_and_clear_invalidates_it() {
        let cache = CredentialCache::default();
        cache
            .write("notion", "old", || async { Ok(()) })
            .await
            .unwrap();
        assert!(cache
            .write("notion", "lost", || async { Err("write failed".into()) })
            .await
            .is_err());
        assert_eq!(
            cache
                .read("notion", || async { panic!("must use cache") })
                .await
                .unwrap(),
            "old"
        );
        cache
            .write("notion", "new", || async { Ok(()) })
            .await
            .unwrap();
        assert_eq!(
            cache
                .read("notion", || async { panic!("must use cache") })
                .await
                .unwrap(),
            "new"
        );
        cache
            .write("notion", "", || async { Ok(()) })
            .await
            .unwrap();
        assert_eq!(
            cache
                .read("notion", || async { Ok("external-update".into()) })
                .await
                .unwrap(),
            "external-update"
        );
    }
}
