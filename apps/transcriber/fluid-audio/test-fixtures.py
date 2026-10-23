#!/usr/bin/env python3
"""Real local CoreML smoke tests. Uses only macOS-generated synthetic voices."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

helper = str(Path(sys.argv[1]).resolve())
models = str(Path(sys.argv[2]).resolve()) if len(sys.argv) > 2 else None
ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    raise SystemExit('ffmpeg must be on PATH')

with tempfile.TemporaryDirectory(prefix='uomi-fluid-fixtures-') as folder:
    base = Path(folder)
    def run(*args):
        subprocess.run(list(map(str, args)), check=True, stdout=subprocess.DEVNULL)
    for voice, filename, text in [
        ('Samantha', 'a.aiff', 'This is a public synthetic test sentence. The microphone is quiet between sentences. We preserve the original recording timeline and identify changes of speaker.'),
        ('Daniel', 'b.aiff', 'A second voice speaks in this test. This fixture contains no private recordings. Speaker identification is probabilistic and must preserve overlapping intervals.')
    ]:
        run('/usr/bin/say', '-v', voice, '-o', base / filename, text)
    def synth(name, delay, pad):
        run(ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', base/'a.aiff', '-i', base/'b.aiff', '-filter_complex',
            f'[0:a]adelay=2000,aresample=16000[a];[1:a]adelay={delay},aresample=16000[b];[a][b]amix=inputs=2:duration=longest:normalize=0'+(',apad=pad_dur=2' if pad else '')+'[out]',
            '-map', '[out]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', base/(name+'.wav'))
    synth('sequential', 14000, True)
    synth('overlap', 5000, False)
    run(ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', base/'silence.wav')
    plans = {}
    for name in ['sequential', 'overlap', 'silence']:
        args = [helper, '--input', base/(name+'.wav'), '--output', base/(name+'.json')]
        if models:
            args += ['--models', models]
        run(*args)
        plan = json.loads((base/(name+'.json')).read_text())
        assert plan['schema'] == 'uomi.speech-plan.v1'
        assert plan['engine'].startswith('uomi-fluid-v1/')
        segments = plan['segments']
        assert all(0 <= s['start_ms'] < s['end_ms'] <= plan['duration_ms'] for s in segments)
        assert segments == sorted(segments, key=lambda s: (s['start_ms'], s['end_ms'], s['speaker'] or ''))
        plans[name] = plan
        print(name, 'duration_ms', plan['duration_ms'], 'intervals', len(segments), 'vad_speech_ms', plan['vad_speech_ms'], 'unattributed_speech_ms', plan['unattributed_speech_ms'])
    assert plans['silence']['segments'] == []
    sequential = plans['sequential']
    assert len({s['speaker'] for s in sequential['segments'] if s['speaker']}) >= 2
    assert sequential['segments'][0]['start_ms'] > 1000
    assert sequential['segments'][-1]['end_ms'] < sequential['duration_ms'] - 1000
    overlap = plans['overlap']['segments']
    assert any(a['speaker'] and b['speaker'] and a['speaker'] != b['speaker'] and min(a['end_ms'], b['end_ms']) > max(a['start_ms'], b['start_ms']) for i, a in enumerate(overlap) for b in overlap[i+1:])
    # No trailing silence: finalization must retain the last partial inference window.
    assert max(s['end_ms'] for s in overlap if s['speaker']) >= plans['overlap']['duration_ms'] - 300
    missing = subprocess.run([helper, '--input', str(base/'silence.wav'), '--output', str(base/'bad.json'), '--models', str(base/'missing-models')], capture_output=True)
    assert missing.returncode != 0 and not (base/'bad.json').exists()
    print('Real CoreML fixtures passed: two voices, overlap, original silence/timestamps, EOF finalization, explicit missing-model failure')
