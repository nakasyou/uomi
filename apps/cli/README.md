# uomi CLI

Bun + TypeScript client for the private Uomi transcript API. It has no runtime
dependencies beyond Bun's standard APIs.

## Setup

```sh
bun install
bun run --cwd apps/cli start --help
```

Run the CLI from the repository with `bun apps/cli/src/main.ts`. After
`bun install`, the workspace also exposes the `uomi` binary.

Credentials are read from the environment:

| Variable           | Required | Purpose                                         |
| ------------------ | -------- | ----------------------------------------------- |
| `UOMI_API_KEY`     | yes      | Device API key sent as `X-Uomi-Secret`          |
| `UOMI_SITES_TOKEN` | no       | Private Sites token (`OAI-Sites-Authorization`) |
| `UOMI_BASE_URL`    | no       | API origin, default below                       |

`UOMI_BASE_URL` defaults to
`https://uomi-transcript-search.nakasyou.chatgpt.site`. Missing values fall back
to `~/.config/uomi/env` (`KEY=VALUE` lines, optional quotes). Secret values are
never printed.

```sh
# ~/.config/uomi/env
UOMI_API_KEY=...
UOMI_SITES_TOKEN=...
# UOMI_BASE_URL=https://uomi.example
```

## Commands

### Search and read

```sh
uomi search [TERM] [--limit N] [--cursor C] [--json]
uomi show ID [--json]
uomi audio ID [-o FILE|-]
```

`search` lists newest-first recordings or searches transcript text. The default
limit is 20 and the API maximum is 50. `show` prints metadata followed by lines
in the form `[MM:SS] speaker_N: text`, using detailed segments when standard
segments are absent. `show --json` returns the full recording response.

`audio` downloads the original Ogg audio. The default output is `<id>.ogg`; pass
`-o -` to write bytes to stdout.

```sh
uomi search meeting --limit 5
uomi show RECORDING_ID
uomi audio RECORDING_ID -o recording.ogg
```

### Transcription control and progress

```sh
uomi transcribe ID [--retry] [--json]       # standard job
uomi detailed ID [--retry] [--json]         # detailed (Codex) job
uomi detailed-result ID [--json]            # persisted detailed result
uomi status [ID] [--mode MODE] [--status STATUS] [--limit N] [--cursor C] [--json]
uomi jobs [ID] [--json]
```

`transcribe` calls `POST /api/recordings/:id/transcription`. `detailed` calls
`POST /api/recordings/:id/detailed-transcription`; repeated starts reuse an
existing job and `--retry` reruns a completed or failed job. `detailed-result`
uses the matching `GET` route without starting work.

`status` calls `GET /api/transcriptions`. `ID` limits results to one recording;
`--mode` accepts `standard`, `long` or `detailed`; `--status` accepts `queued`,
`processing`, `retry`, `completed` or `failed`. Follow `next_cursor` with
`--cursor` while keeping filters unchanged. `jobs ID` instead calls
`GET /api/recordings/:id/status` and shows all three job lanes; `jobs` without an
ID lists recent durable jobs from `GET /api/jobs`.

The API does not expose a cancel/stop endpoint, so the CLI does not advertise
one. Polling progress is read-only.

### MCP API alias

```sh
uomi mcp --list
uomi mcp TOOL [--args '{"key":"value"}'] [--json]
```

These commands post JSON-RPC to `POST /api/mcp`, the device-key alias for the MCP
tools. They support the same tools as the canonical endpoint, including
`search_transcripts`, `read_transcript`, `start_detailed_transcription` and
`transcription_status`.

```sh
uomi mcp --list
uomi mcp transcription_status --args '{"mode":"detailed","limit":20}'
uomi mcp start_detailed_transcription --args '{"id":"RECORDING_ID"}'
```

## Tests

```sh
bun test apps/cli/tests
bun run --cwd apps/cli typecheck
```

Tests mock `fetch`; no live API or credentials are needed.

## Nix

The root flake exposes a wrapper package and app:

```sh
nix run .#uomi-cli -- search
```

It runs the TypeScript sources with Bun from nixpkgs, so no separate dependency
vendoring is required.
