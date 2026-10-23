# Query performance

Migration `0006_query_performance.sql` adds indexes for the actual recording/job
access patterns. Existing data and public IDs are retained. A virtual `sort_time`
column normalizes unknown clocks to zero without duplicating stored timestamps.

Run the regression evidence from the repository root:

```sh
node --import tsx --test apps/web/tests/query-performance.test.js
```

The test seeds **20,000 recordings/jobs and 60,000 source ranges**, including sparse
stars, completed history, queued/expired work, delayed retries, rare Japanese
search matches and unknown-clock ties. It runs `ANALYZE`, captures SQL actually
executed by the API, then evaluates `EXPLAIN QUERY PLAN` with its real parameters.
Assertions check selected access paths and statement counts, not fragile wall-clock
timings. Separate tests exercise real lease fencing and result correctness.

| Path                                  | Previous plan/problem                                                | Current access                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Newest recordings                     | Ordered expression-index scan                                        | Ordered `recordings_page` scan; stops at requested page                                                                                 |
| Cursor, including tied/unknown clocks | OR predicate scanned earlier pages                                   | Composite `(sort_time,id)` index seek; MCP uses the reverse direction                                                                   |
| Stars                                 | Scanned newest history looking for sparse stars                      | Partial `recordings_starred_newest` ordered index                                                                                       |
| Date upper bound                      | Scanned newest rows before the selected range                        | `recordings_page` seeks `sort_time<to`, retaining exact overlap predicates                                                              |
| Empty future date range               | Could walk the entire newest index                                   | `recordings_end` existence probe returns an empty page immediately                                                                      |
| Ready search                          | Ran maintenance counts and could read R2 manifests                   | Indexed `search_version=0 LIMIT 1` probe; no maintenance/R2 once ready                                                                  |
| Three-plus-character search           | Compact trigram FTS                                                  | FTS candidate search + integer recording-key lookup + exact substring verification                                                      |
| Recent jobs                           | Full table scan and temporary sort                                   | `jobs_recent` ordered scan, bounded to 100 results                                                                                      |
| Job claim                             | OR branches, processing status-only lookup, unbounded candidate sort | Disjoint partial `jobs_due` / `jobs_expired` indexes; each contributes at most requested limit, final merge sorts at most 16 candidates |
| Exhausted jobs                        | Every poll scanned all recordings twice                              | Partial `jobs_exhausted` index, at most 100 expirations per request, recording updates target returned IDs                              |
| Claimed job metadata/status           | Two round trips per claimed job                                      | One batched metadata read and two mode-specific batched updates                                                                         |
| Optional backup queue                 | Broad backup index and temporary sort                                | Partial `backup_due` in retry/lease order, maximum two jobs                                                                             |
| Chunk receipts and aliases            | Primary/unique indexes                                               | Preserved indexed batched ID lookups, no per-chunk query loop                                                                           |
| Historical import identity            | Multi-index OR                                                       | Preserved page/public-ID indexes; primary-owned records skip network work                                                               |
| Source overlap/import cleanup         | Indexed overlap; cleanup lacked child-key index                      | Preserved device/prefix/range seek; `source_recording` indexes cleanup; JSON source claims use one SQL statement                        |

A normal claim of eight jobs now executes **five statements**, independent of the
claim size: bounded expiration, atomic claim, one metadata query, and two status
updates. The prior implementation executed twenty statements (three expiration/
status sweeps, claim, and sixteen per-job reads/writes). When exhaustion actually
occurs, up to two additional bounded recording updates run. No transcription or
Notion I/O is performed inside these database operations.

`GET /api/recordings/:id/status` executes one primary-key query with two indexed
job summaries. It returns revision, boolean audio availability, statuses, progress
and errors. It never selects or serializes transcript/segment columns. The payload
regression inserts megabytes of text/segments and verifies a response below 1 KiB;
the UI fetches full content only when the revision/audio availability changes.

Two-character literal substring search intentionally remains a scan: a trigram
index cannot represent a two-character key. Date-only lower-bound overlap may
still inspect ordered candidates because recordings can span arbitrary intervals;
assuming `recorded_at>=from` would lose long overlapping recordings. The indexed
emptiness probe avoids the worst no-match future case. Full storage/daily
aggregates remain explicit diagnostics (`index_status`), not ordinary searches or
status polls. Temporary sorting for FTS result chronology is limited to matched
candidates, rather than all recording history.

`0007_notion_cutover.sql` further narrows `backup_due` to new uploads or changed
primary recordings. Untouched historical Notion snapshots are excluded, and their
old dirty backup revisions/leases are cleared before cutover refresh. This prevents
a queue of stale cache snapshots from rewriting the historical source.

Storage diagnostics deliberately run only for an explicit `index_status` request.
They report source-range cardinality, frame spans, UTF-8 identity bytes and the
largest recordings, plus supported SQLite allocation/free-page counters. Unsupported
PRAGMAs return their own diagnostic errors. These counters distinguish payload
and identity/index overhead from allocated free space; physical D1 bytes alone do
not establish duplicate data. Source identities include per-packet hashes, so
combining ranges with different prefixes would lose deduplication correctness.

## Live storage evidence after the diagnostics release

The connected production `index_status` call after deployment
`appgdep_6adb7455f4708191b4fc7e7be537623d` reported:

| Measurement                           |                          Value |
| ------------------------------------- | -----------------------------: |
| Physical D1 size                      | 121,171,968 bytes (115.56 MiB) |
| Recordings / primary audio copies     |                      213 / 145 |
| Source ranges / distinct prefixes     |              296,518 / 296,504 |
| Frames / mean frames per range        |              1,317,449 / 4.443 |
| Source device strings                 |          6,226,908 UTF-8 bytes |
| Source prefix strings                 |         25,797,038 UTF-8 bytes |
| Combined source identity payload      |   32,023,946 bytes (30.54 MiB) |
| Original + normalized transcript text |                   96,293 bytes |
| FTS data + term payload               |                   89,929 bytes |
| Legacy manifest blobs in D1           |                        0 bytes |

The difference between range count and distinct-prefix count is only **14 rows
(0.0047%)**. Almost every range represents a different packet identity, rather
than avoidable fragmentation of a shared prefix. Sorting/merging existing ranges
therefore cannot materially reduce this data without incorrectly merging distinct
packet hashes. Differences between packet prefixes must remain exact for source
ownership and idempotency.

Source identity strings alone occupy 30.54 MiB before SQLite record/page overhead.
The WITHOUT ROWID source table's long `(device,prefix,start)` key is also carried
by its `source_overlap` and `source_recording` secondary indexes. Identity and
index cost is consequently a plausible dominant contributor to the physical size;
this is an inference from measured payload/cardinality and the deployed schema,
not a per-table physical allocation measurement. Transcript/FTS payloads and old
manifest blobs are too small to explain the observed size.

D1 returned `SQLITE_AUTH` for `PRAGMA page_count` and `PRAGMA freelist_count`.
`page_size` returned 4,096 bytes. Allocation/free-page counts and free-page bytes
therefore remain **unknown**; neither reclaimable free space nor exact attribution
of the earlier size increase can be established from these counters. No source
identity compression, range rewrite, VACUUM or storage migration was performed
on the basis of this audit. A future lossless key representation change would
need separate migration, source-identity and overlap-query verification.

## Completed-import growth comparison

At the migration-complete snapshot, production reported 213 recordings and 212
primary audio copies, 542,568 source ranges for 542,549 distinct prefixes, and
2,405,385 frames. Physical D1 size was 223,580,160 bytes (213.22 MiB). Source device
strings occupied 11,393,958 bytes and prefixes 47,203,388 bytes, totaling
58,597,346 bytes (55.88 MiB) of identity payload before indexes/SQLite overhead.
Only 19 rows exceeded distinct prefixes (0.0035%), again ruling out useful range
merging as a material storage remedy.

Compared with the earlier 296,518-range snapshot above, the importer added
246,050 source ranges and 102,408,192 physical bytes (97.66 MiB): approximately
416.21 physical bytes per additional range. Total physical bytes per range stayed
near 409–412 across the two observations. This observed near-linear growth is
stronger evidence that live source-identity cardinality and its indexed long keys
explain the main growth, rather than recording count or transcript volume. It
still does not measure physical bytes by table or rule out some free-page
contribution: D1 continues to deny the allocation/free-page counters.

The final recording-ownership audit paginated all 213 unique rows using Sites'
returned continuation offsets and checked all eligibility fields. Exactly zero
rows matched `notion_edited IS NOT NULL AND revision=0 AND notion_import_version=0`.
All 179 rows with Notion import provenance had import version 1; primary rows
without that provenance are intentionally outside the historical-baseline marker.
No schema, source identity or range rewrite was performed for this investigation.

## Canonical-media coverage clarification

The final 213 metadata rows / 212 primary audio copies do **not** demonstrate a
lost original. The unfinished reservation
`401f60d4-5c99-8169-9aca-d9e3c4031db1` has an already migrated canonical copy,
`401f60d4-5c99-81ff-b01a-f7a939f2813e`. Both metadata rows retain duration 74,560 ms
and the same recorded-at value. The canonical D1 row binds the completed source
page, original audio SHA-256 and compressed R2 manifest.

An authenticated full read of the current canonical R2 audio returned 400,342
bytes with SHA-256
`2e73749a373e0bb08b013f95f4509a9db62d2b6c1e6cea3fddb1932a646f26c2`, matching
both D1 and the verified source manifest. The current API manifest contains 3,728
frame IDs, duration 74,560 ms, and stable Recording ID
`6281e9890e58909c53529abae76b420e66264a152aeb0d2c03b98e0127d84ccd`.
SHA-256 of JSON.stringify of its **complete** frame-ID list equals that stable ID;
this verifies exact frame identity rather than only timestamp or boundary similarity.
The [canonical original audio](https://uomi-transcript-search.nakasyou.chatgpt.site/api/recordings/401f60d4-5c99-81ff-b01a-f7a939f2813e/audio)
remains private and requires authenticated access.

The prior 404 applies to the unfinished reservation's own media route, not to a
missing unique original. Both metadata rows were preserved. No additional media
attachment, duplicate source claims, deletion or schema change was performed just
to make the metadata/audio counters equal. Exact live binding and source-read
proof is recorded in docs/verification.md.
