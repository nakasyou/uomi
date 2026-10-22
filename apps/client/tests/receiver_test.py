import base64
import copy
import gzip
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
import zlib

spec = importlib.util.spec_from_file_location("receiver", "receiver/server.py")
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)

def segment(ids):
    digest = hashlib.sha256(json.dumps(ids, separators=(",", ":")).encode()).hexdigest()
    return {"schema": "uomi.audio.v1", "codec": "opus", "sampleRate": 16000, "channels": 1, "deviceId": "device", "durationMs": 20 * len(ids), "segmentId": digest, "frames": [{"id": i, "data": "mA==", "durationMs": 20, "capturedAt": None, "timing": "device-uptime", "offsetMs": 0} for i in ids]}

class ReceiverTests(unittest.TestCase):
    def test_cross_client_overlap_different_segmentation(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = receiver.Ledger(os.path.join(tmp, "ledger.sqlite"))
            a, b = segment(["device:a", "device:b"]), segment(["device:b", "device:c"])
            self.assertEqual(ledger.accept(a, a["segmentId"])["insertedFrames"], 2)
            self.assertEqual(ledger.accept(a, a["segmentId"])["insertedFrames"], 0)
            self.assertEqual(ledger.accept(b, b["segmentId"])["insertedFrames"], 1)
            with ledger.connect() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM frames").fetchone()[0], 3)
    def test_compressions(self):
        body = json.dumps(segment(["device:a"])).encode()
        for encoding, data in [("identity", body), ("gzip", gzip.compress(body)), ("deflate", zlib.compress(body))]:
            self.assertEqual(receiver.decode(data, encoding)["deviceId"], "device")
        with self.assertRaises(ValueError):
            receiver.decode(gzip.compress(body)[:-5], "gzip")
    def test_conflict_rolls_back_entire_segment(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = receiver.Ledger(os.path.join(tmp, "ledger.sqlite"))
            a = segment(["device:a"])
            ledger.accept(a, a["segmentId"])
            b = segment(["device:c", "device:a"])
            b["frames"][1]["data"] = "mQE="
            with self.assertRaises(ValueError):
                ledger.accept(b, b["segmentId"])
            with ledger.connect() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM frames").fetchone()[0], 1)

if __name__ == "__main__":
    unittest.main()
