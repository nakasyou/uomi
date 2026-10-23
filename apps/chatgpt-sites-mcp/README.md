# Uomi ChatGPT Sites MCP

Optional, owner-private Cloudflare Worker hosted by ChatGPT Sites. The existing
client and transcriber remain local-first and need no hosted server.

## Setup

In this Site's runtime secrets set `NOTION_TOKEN` (a dedicated read-only Notion
integration shared with the Uomi database) and `NOTION_DATA_SOURCE_ID` (the actual
data source UUID, not a database URL). Never commit credentials. Sites provisions
D1 as `DB`, applies `drizzle/` migrations and authenticates the private MCP route.
This is a **single-owner, single-source** deployment; do not share the Site with
other users or change the source without rebuilding the derived database.

After deployment install the canonical uomi plugin created by Sites. Call
`sync_index` repeatedly until `has_more` is false, then `index_status` to inspect
coverage. Re-run sync before freshness-sensitive queries. There is no background
cron or automatic import. Unconfigured deployment remains available but cannot
read Notion. Notion is never modified.

## Tools

- `search_transcripts`: literal case-insensitive substring search, minimum three
  Unicode characters; optional `from`/`to`, page size 1–50 and continuation cursor.
- `recordings_in_range`: recordings overlapping `[from,to)`. ISO-8601 timezone
  required. Unknown recording clocks are excluded from range filters.
- `read_transcript`: bounded full-text slices (UTF-16 offsets, max 16,000 units).
- `index_status`: configuration, watermark and coverage state.
- `sync_index`: at most ten changed pages per call, with a five-minute D1 lease.

Result previews contain the first 1,200 characters, not a relevance snippet.
Ranges operate on recordings, because `uomi.transcript.v1` has no word timestamps.
A result does not imply every word was spoken inside the requested time window.
Keep the same query/range while using a cursor. Concurrent index updates can change
pagination; this is not a snapshot API.

## Index design and limits

D1 stores a derived full-text copy, indexed by recording start/end. FTS5 trigram
MATCH supports Japanese without a whitespace tokenizer or a full-corpus LIKE
scan. Parameters are bound and FTS phrases escaped. Keyset pagination avoids deep
OFFSET scans. The Worker is stateless; D1 serializes sync admission. Each changed
recording replaces its text and FTS row in one transaction. Unchanged edit times
skip attachment downloads. Page checkpoints advance only after successful writes;
retries safely repeat completed upserts. A one-minute watermark overlap avoids
boundary misses. Notion rate limits fail visibly and do not advance the cursor.

Full transcript attachments are streamed with a 512 KiB cap, fetched with a timeout
and without credentials/redirects. A failed or oversized document stops that page
rather than claiming complete indexing. D1 capacity and Notion rate/query limits
still apply: this is bounded incremental indexing, not unlimited ingest. A very
large initial import may require creation-time partitioning around Notion's
10,000-query-result ceiling; the current importer does not silently declare
coverage past that ceiling. No semantic/vector ranking is provided.

Notion query does not return archived/deleted pages. **Those cached records remain
searchable** until the owner rebuilds the derived DB. The index is not an authority
for source deletion or permission revocation. Rebuild/clear it when changing
integration scope, source, access policies or removing sensitive source data.
Use a dedicated owner-private deployment and read-only integration.

## Development and deployment

No dependencies; Node 24 is sufficient:

```sh
node --test tests/*.test.js
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

Build output is `dist/server/index.js`. Publish this directory as the Site source
root using the Sites source workflow (not the monorepo root); it packages migrations
from `drizzle/` alongside the Worker. The tracked `.openai/hosting.json` retains the
Site identity. GitHub PRs do not automatically deploy. The Sites source mirror is a
separate repository and must receive the same app files before publication.
