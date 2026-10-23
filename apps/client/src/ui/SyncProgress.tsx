import React, { useEffect, useRef, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { Text, ProgressBar, Divider, useTheme } from 'react-native-paper'
import { SyncEta, etaLabel } from '../core/eta'
import type { ImportMetrics, SyncProgress } from '../core/types'
const count = (v: number) => v.toLocaleString()
function bytes(n: number) {
  return n < 1024
    ? `${Math.round(n)} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(1)} MiB`
}
export function SyncProgressView({
  progress,
  transfer,
  active = true,
}: {
  progress: SyncProgress
  transfer?: ImportMetrics
  active?: boolean
}) {
  const theme = useTheme()
  const estimator = useRef(new SyncEta())
  const [clock, setClock] = useState({ remaining: null as number | null, now: Date.now() })
  useEffect(() => {
    const update = () => {
      const now = Date.now()
      setClock({ remaining: estimator.current.remaining(progress, now), now })
    }
    update()
    if (!active) return
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [progress, active])
  const upload = progress.stage === 'upload' && progress.chunksTotal !== undefined
  const completed = upload ? (progress.chunksSubmitted ?? 0) : progress.completed
  const total = upload ? progress.chunksTotal! : progress.total
  const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : null
  const unit = upload
    ? 'chunks uploaded'
    : (progress.unit ?? (progress.stage === 'import' ? 'records saved locally' : 'items'))
  const inProgress = progress.chunksActive ?? 0
  const preparing = progress.chunksPreparing ?? 0
  const queued = Math.max(0, total - completed - inProgress - preparing)
  const updatedSeconds = progress.updatedAt
    ? Math.max(0, Math.floor((clock.now - progress.updatedAt) / 1000))
    : null
  const metrics = progress.stage === 'import' ? transfer : undefined
  const secondary = { color: theme.colors.onSurfaceVariant }
  return (
    <View style={styles.group}>
      <View style={styles.summary} accessibilityLiveRegion="polite">
        <Text variant="titleMedium" style={styles.counter}>
          {count(completed)}
          {total > 0 ? ` / ${count(total)}` : ''} {unit}
        </Text>
        {ratio !== null && (
          <Text variant="titleMedium" style={styles.numerals}>
            {Math.round(ratio * 100)}%
          </Text>
        )}
      </View>
      <View style={styles.track}>
        <ProgressBar
          progress={ratio ?? 0}
          indeterminate={ratio === null && active}
          accessibilityLabel={upload ? 'Audio upload progress' : 'Sync progress'}
          accessibilityValue={total > 0 ? { min: 0, max: total, now: completed } : undefined}
          style={styles.bar}
        />
      </View>
      {upload ? (
        <>
          {active && (
            <Text variant="bodyMedium" style={secondary}>
              {`${inProgress} uploading · ${preparing} preparing · ${count(queued)} queued`}
            </Text>
          )}
          {active && (
            <View style={styles.summary}>
              <Text variant="bodySmall" style={secondary}>
                {active && completed < total
                  ? etaLabel(clock.remaining)
                  : completed === total
                    ? 'Transfer complete'
                    : 'Transfer paused'}
              </Text>
              {updatedSeconds !== null && (
                <Text variant="bodySmall" style={secondary}>
                  {active
                    ? updatedSeconds < 2
                      ? 'Updated just now'
                      : `Updated ${updatedSeconds}s ago`
                    : 'Latest transfer results'}
                </Text>
              )}
            </View>
          )}
          <Divider style={styles.divider} />
          <View style={styles.summary} accessibilityLiveRegion="polite">
            <Text variant="bodyMedium">
              {progress.checkingSaves ? 'Checking server saves' : 'Saved on server'}
            </Text>
            <Text variant="bodyMedium" style={styles.numerals}>
              {count(progress.chunksCompleted ?? 0)} confirmed
            </Text>
          </View>
          {!!progress.chunksSaveFailed && (
            <Text variant="bodyMedium" style={{ color: theme.colors.error }}>
              {count(progress.chunksSaveFailed)} saves need attention. Original audio is kept
              locally.
            </Text>
          )}
          {!!progress.chunksStaged && (
            <Text variant="bodyMedium" style={secondary}>
              {count(progress.chunksStaged)} awaiting confirmation.{' '}
              {active ? 'Checking automatically.' : 'Check again with Upload local audio.'}
            </Text>
          )}
        </>
      ) : (
        <>
          {progress.detail ? <Text variant="bodyMedium">{progress.detail}</Text> : null}
          {active && (
            <Text variant="bodyMedium" style={secondary}>
              {etaLabel(clock.remaining)}
            </Text>
          )}
        </>
      )}
      {metrics ? (
        <>
          <Text variant="bodyMedium" style={secondary}>
            {bytes(metrics.receivedBytes)} received ·{' '}
            {metrics.elapsedMs > 0
              ? `${bytes(metrics.receivedBytes / (metrics.elapsedMs / 1000))}/s`
              : 'Measuring speed…'}
          </Text>
          <Text variant="bodySmall" style={secondary}>
            Elapsed {(metrics.elapsedMs / 1000).toFixed(1)}s · Storage{' '}
            {(metrics.storageMs / 1000).toFixed(1)}s
            {metrics.elapsedMs > 0
              ? ` · ${(metrics.completed / (metrics.elapsedMs / 1000)).toFixed(1)} records/s`
              : ''}
          </Text>
        </>
      ) : null}
    </View>
  )
}
const styles = StyleSheet.create({
  group: { gap: 10, flexGrow: 0, flexShrink: 0 },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
    flexWrap: 'wrap',
  },
  counter: { flexShrink: 1, fontVariant: ['tabular-nums'] },
  numerals: { fontVariant: ['tabular-nums'] },
  divider: { marginVertical: 6 },
  // Paper's web progressbar root uses height: 100%. Give that percentage a
  // definite containing height so WebKit cannot size it against the whole group.
  track: {
    height: 6,
    minHeight: 6,
    maxHeight: 6,
    width: '100%',
    flexGrow: 0,
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: 3,
  },
  bar: { height: 6, borderRadius: 3, flexGrow: 0, flexShrink: 0, overflow: 'hidden' },
})
