"""Reference Uomi webhook receiver; standard library only. Put behind HTTPS."""
import argparse
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import ssl
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 16 * 1024 * 1024
MAX_DECODED = 32 * 1024 * 1024

def decode(body, encoding):
    if encoding == "identity":
        result = body
    elif encoding in ("gzip", "deflate"):
        stream = zlib.decompressobj(31 if encoding == "gzip" else 15)
        result = stream.decompress(body, MAX_DECODED + 1)
        if not stream.eof or stream.unused_data:
            raise ValueError("Incomplete, oversized or concatenated compressed body")
    else:
        raise ValueError("Unsupported Content-Encoding")
    if len(result) > MAX_DECODED:
        raise ValueError("Decoded body too large")
    return json.loads(result)

class Ledger:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.executescript("""PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS frames
                (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, opus BLOB NOT NULL, metadata TEXT NOT NULL);
            """)
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.execute("PRAGMA synchronous=FULL")
        return db
    def accept(self, segment, idempotency):
        if segment.get("schema") != "uomi.audio.v1" or segment.get("codec") != "opus":
            raise ValueError("Unsupported audio schema or codec")
        if segment.get("sampleRate") != 16000 or segment.get("channels") != 1:
            raise ValueError("Unsupported sample rate or channel count")
        frames = segment.get("frames")
        if not isinstance(frames, list) or not 1 <= len(frames) <= 100000:
            raise ValueError("Invalid frames")
        ids = [f["id"] for f in frames]
        expected = hashlib.sha256(json.dumps(ids, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if segment.get("segmentId") != expected or idempotency != expected:
            raise ValueError("Segment id does not match frame ids")
        device = segment.get("deviceId")
        if not isinstance(device, str) or not device:
            raise ValueError("Missing stable device ID")
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate frame IDs in request")
        decoded = []
        duration = 0
        for f in frames:
            if not isinstance(f["id"], str) or not f["id"].startswith(device + ":"):
                raise ValueError("Frame belongs to a different device")
            data = base64.b64decode(f["data"], validate=True)
            if not 1 <= len(data) <= 1275 or not 0 < f["durationMs"] <= 120:
                raise ValueError("Invalid Opus frame")
            duration += f["durationMs"]
            decoded.append((f["id"], device, data, json.dumps({k: v for k, v in f.items() if k != "data"})))
        if duration != segment.get("durationMs") or duration > 900000:
            raise ValueError("Invalid segment duration")
        inserted = 0
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM segments WHERE id=?", (expected,)).fetchone():
                return {"accepted": True, "segmentId": expected, "insertedFrames": 0}
            for row in decoded:
                existing = db.execute("SELECT device_id,opus FROM frames WHERE id=?", (row[0],)).fetchone()
                if existing and (existing[0] != row[1] or existing[1] != row[2]):
                    raise ValueError("Conflicting payload for a stable frame ID")
                inserted += db.execute("INSERT OR IGNORE INTO frames VALUES (?,?,?,?)", row).rowcount
            db.execute("INSERT INTO segments VALUES (?)", (expected,))
        return {"accepted": True, "segmentId": expected, "insertedFrames": inserted}

def make_handler(ledger, secret, header):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/audio":
                self.send_error(404)
                return
            if not hmac.compare_digest(self.headers.get(header, "").encode(), secret.encode()):
                self.send_error(401)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    raise ValueError("Invalid body length")
                self.connection.settimeout(30)
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("Incomplete body")
                segment = decode(body, self.headers.get("Content-Encoding", "identity"))
                result = ledger.accept(segment, self.headers.get("Idempotency-Key"))
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (ValueError, KeyError, TypeError, zlib.error):
                self.send_error(400, "Invalid audio segment")
            except sqlite3.Error:
                self.send_error(503, "Audio not committed; retry later")
        def log_message(self, fmt, *args):
            # Never log secrets, audio payloads or webhook query strings.
            print("Uomi webhook request handled", flush=True)
    return Handler

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--database", default="uomi.sqlite")
    parser.add_argument("--cert")
    parser.add_argument("--key")
    parser.add_argument("--secret-header", default="X-Uomi-Secret")
    args = parser.parse_args()
    secret = os.environ.get("UOMI_WEBHOOK_SECRET")
    if not secret:
        parser.error("Set UOMI_WEBHOOK_SECRET in the environment")
    server = ThreadingHTTPServer((args.bind, args.port), make_handler(Ledger(args.database), secret, args.secret_header))
    if args.cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(args.cert, args.key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    print(f"Listening on {args.bind}:{args.port}/audio")
    server.serve_forever()
