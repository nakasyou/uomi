import React, { useEffect, useRef, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { Text, ProgressBar } from 'react-native-paper'
import { SyncEta, etaLabel } from '../core/eta'
import type { ImportMetrics, SyncProgress } from '../core/types'
const count = (v: number) => v.toLocaleString()
function bytes(n: number) {
  return n < 1024 ? `${Math.round(n)} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`
}
export function SyncProgressView({ progress, transfer }: { progress: SyncProgress; transfer?: ImportMetrics }) {
  const estimator = useRef(new SyncEta()), [remaining, setRemaining] = useState<number | null>(null)
  useEffect(() => {
    const update = () => setRemaining(estimator.current.remaining(progress, Date.now()))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [progress])
  const ratio = progress.total > 0 ? Math.max(0, Math.min(1, progress.completed / progress.total)) : null
  const unit = progress.unit ?? (progress.stage === 'import' ? 'records saved locally' : progress.stage === 'upload' ? 'packets confirmed in Notion' : 'items')
  const metrics = progress.stage === 'import' ? transfer : undefined
  return <View style={styles.group} accessibilityLiveRegion="polite">
    <View style={styles.bar}>
      <ProgressBar progress={ratio ?? 0} indeterminate={ratio === null} style={styles.bar} />
    </View>
    <Text variant="titleMedium">
      {count(progress.completed)}{progress.total > 0 ? ` / ${count(progress.total)}` : ''} {unit}
      {ratio !== null ? ` · ${(ratio * 100).toFixed(1)}%` : ''}
    </Text>
    {progress.detail ? <Text variant="bodyMedium">{progress.detail}</Text> : null}
    {progress.chunksTotal !== undefined ? <Text variant="bodyMedium">
      Chunks: {progress.chunksSubmitted ?? 0} / {progress.chunksTotal} sent · {progress.chunksCompleted ?? 0} confirmed in Notion
      {progress.chunksStaged ? ` · ${progress.chunksStaged} awaiting confirmation` : ''}
    </Text> : null}
    <Text variant="bodyMedium">{etaLabel(remaining)}</Text>
    {metrics ? <>
      <Text variant="bodyMedium">
        {bytes(metrics.receivedBytes)} received · {metrics.elapsedMs > 0 ? `${bytes(metrics.receivedBytes / (metrics.elapsedMs / 1000))}/s` : 'Measuring speed…'}
      </Text>
      <Text variant="bodyMedium">
        Elapsed {(metrics.elapsedMs / 1000).toFixed(1)}s · Storage {(metrics.storageMs / 1000).toFixed(1)}s
        {metrics.elapsedMs > 0 ? ` · ${(metrics.completed / (metrics.elapsedMs / 1000)).toFixed(1)} records/s` : ''}
      </Text>
      <Text variant="bodySmall">
        {metrics.mtu ? `MTU ${metrics.mtu} · ` : ''}Largest notification {bytes(metrics.maxNotificationBytes)}
        {metrics.connectionIntervalMs ? ` · Connection interval ${metrics.connectionIntervalMs}ms` : ''}
        {metrics.txPhy ? ` · TX PHY ${metrics.txPhy}` : ''}{metrics.rxPhy ? ` · RX PHY ${metrics.rxPhy}` : ''}
      </Text>
    </> : null}
  </View>
}
const styles = StyleSheet.create({
  group: { gap: 8, flexGrow: 0, flexShrink: 0 },
  bar: { height: 4, minHeight: 4, maxHeight: 4, flexGrow: 0, flexShrink: 0, overflow: 'hidden' },
})
