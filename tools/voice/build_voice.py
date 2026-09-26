#!/usr/bin/env python3
"""
Code Execution Lab — voice asset builder.

Turns the narration script embedded in index.html into a *voice asset*: one
compressed clip per narration line plus metadata. The app lays out all of its
timing from whatever asset it is given, so a new voice never needs code changes.

  # 1. the voice embedded in index.html (reads + rewrites the file in place)
  python3 tools/voice/build_voice.py narration --preset temporary --embed

  # 2. comparison samples (two fixed lines) for presets A, B and C
  python3 tools/voice/build_voice.py samples --presets A B C

  # 3. bring your own recordings (human narrator or any TTS service):
  #    put <line-id>.wav|.mp3|.m4a|.flac files in a folder, e.g. intro.0.wav
  python3 tools/voice/build_voice.py narration --from-dir my_takes/ --label "Final voice" --embed
  python3 tools/voice/build_voice.py list-lines      # prints every line id + text

Requirements: numpy, soundfile, pyloudnorm, an ffmpeg binary (PATH or
imageio-ffmpeg) and, for the Kokoro engine, kokoro-onnx + the model files
(see tools/voice/README.md). No API keys are ever written to the asset.
"""
import argparse, base64, datetime, io, json, os, re, shutil, subprocess, sys, tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SR = 24000
TARGET_LUFS = -18.0          # voice-first mix; the in-app limiter keeps headroom
PEAK_CEILING_DB = -1.5
SAMPLE_LINES = [
    "You've written three lines of code. But what actually happens when you press Run?",
    "Now we're entering the processor, where those instructions start to drive actual hardware.",
]


# ---------------------------------------------------------------------------
# script + asset I/O
# ---------------------------------------------------------------------------
def block_re(block_id):
    return re.compile(r'(<script type="application/json" id="%s">)(.*?)(</script>)' % re.escape(block_id), re.S)


def read_script(html_path):
    html = open(html_path, encoding='utf-8').read()
    m = block_re('narration-script').search(html)
    if not m:
        sys.exit('narration-script block not found in %s' % html_path)
    script = json.loads(m.group(2))
    lines = []
    for cue in script['cues']:
        for i, line in enumerate(cue['lines']):
            lines.append({'id': '%s.%d' % (cue['id'], i), 'text': line['text']})
    return script, lines


def embed_asset(html_path, asset_json):
    html = open(html_path, encoding='utf-8').read()
    rx = block_re('voice-asset')
    if not rx.search(html):
        sys.exit('voice-asset block not found in %s' % html_path)
    html = rx.sub(lambda m: m.group(1) + '\n' + asset_json + '\n' + m.group(3), html, count=1)
    open(html_path, 'w', encoding='utf-8').write(html)


def asset_to_json(asset):
    """One clip per line of text so diffs stay readable."""
    head = {k: v for k, v in asset.items() if k != 'lines'}
    out = ['{', '"format": %s,' % json.dumps(head['format']), '"meta": %s,' % json.dumps(head['meta'], ensure_ascii=False), '"lines": {']
    items = list(asset['lines'].items())
    for n, (lid, clip) in enumerate(items):
        out.append('%s: %s%s' % (json.dumps(lid), json.dumps(clip, ensure_ascii=False, separators=(',', ':')), ',' if n < len(items) - 1 else ''))
    out.append('}}')
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# audio helpers
# ---------------------------------------------------------------------------
def ffmpeg_exe():
    exe = shutil.which('ffmpeg')
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        sys.exit('ffmpeg not found (install ffmpeg or `pip install imageio-ffmpeg`)')


def load_any(path):
    """Decode any audio file to mono float32 @ SR via ffmpeg."""
    cmd = [ffmpeg_exe(), '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-']
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def trim(x, head=0.03, tail=0.14, floor_db=-48.0):
    if len(x) == 0:
        return x
    env = np.abs(x)
    thr = env.max() * (10 ** (floor_db / 20))
    idx = np.where(env > thr)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(head * SR))
    b = min(len(x), idx[-1] + int(tail * SR))
    y = x[a:b].copy()
    f = min(len(y) // 4, int(0.012 * SR))
    if f > 0:
        y[:f] *= np.linspace(0, 1, f)
        y[-f:] *= np.linspace(1, 0, f)
    return y


def dynamics(clips):
    """Gentle broadcast-style compression (3:1) so speech sits evenly under a peak ceiling."""
    gap = int(0.3 * SR)
    joined = np.concatenate([np.concatenate([c, np.zeros(gap, np.float32)]) for c in clips]).astype(np.float32)
    cmd = [ffmpeg_exe(), '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-',
           '-af', 'acompressor=threshold=0.08:ratio=2.5:attack=6:release=160:knee=4,alimiter=limit=0.3:attack=2:release=40:latency=1:level=0', '-f', 'f32le', '-']
    y = np.frombuffer(subprocess.run(cmd, input=joined.tobytes(), check=True, capture_output=True).stdout, dtype=np.float32)
    out, pos = [], 0
    for c in clips:
        out.append(y[pos:pos + len(c)].copy()); pos += len(c) + gap
    return out


def normalize(clips):
    """Apply ONE gain to every clip so the whole performance sits at TARGET_LUFS."""
    import pyloudnorm as pyln
    joined = np.concatenate([np.concatenate([c, np.zeros(int(0.3 * SR), np.float32)]) for c in clips])
    meter = pyln.Meter(SR)
    lufs = meter.integrated_loudness(joined.astype(np.float64))
    gain = 10 ** ((TARGET_LUFS - lufs) / 20)
    peak = max(np.abs(c).max() for c in clips) * gain
    ceiling = 10 ** (PEAK_CEILING_DB / 20)
    if peak > ceiling:
        gain *= ceiling / peak
    return [np.clip(c * gain, -1, 1).astype(np.float32) for c in clips], lufs, 20 * np.log10(gain)


def encode_mp3(x, bitrate='64k'):
    cmd = [ffmpeg_exe(), '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-',
           '-c:a', 'libmp3lame', '-b:a', bitrate, '-ar', str(SR), '-f', 'mp3', '-']
    return subprocess.run(cmd, input=x.astype(np.float32).tobytes(), check=True, capture_output=True).stdout


# ---------------------------------------------------------------------------
# engines
# ---------------------------------------------------------------------------
class KokoroEngine:
    """Kokoro-82M (Apache-2.0) running locally through kokoro-onnx."""
    def __init__(self, models_dir):
        from kokoro_onnx import Kokoro
        onnx = os.path.join(models_dir, 'kokoro-v1.0.onnx')
        voices = os.path.join(models_dir, 'voices-v1.0.bin')
        if not (os.path.exists(onnx) and os.path.exists(voices)):
            sys.exit('Kokoro model files missing in %s (see tools/voice/README.md)' % models_dir)
        self.k = Kokoro(onnx, voices)

    def say(self, text, preset):
        audio, sr = self.k.create(text, voice=preset['voice'], speed=float(preset.get('speed', 1.0)), lang=preset.get('lang', 'en-us'))
        assert sr == SR, sr
        return np.asarray(audio, dtype=np.float32)


def synthesize_lines(lines, args, preset):
    if args.from_dir:
        clips = []
        for ln in lines:
            for ext in ('wav', 'mp3', 'm4a', 'flac', 'ogg'):
                p = os.path.join(args.from_dir, '%s.%s' % (ln['id'], ext))
                if os.path.exists(p):
                    clips.append(load_any(p)); break
            else:
                sys.exit('missing recording for line %s in %s' % (ln['id'], args.from_dir))
        return clips
    eng = KokoroEngine(args.models)
    return [eng.say(ln['text'], preset) for ln in lines]


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def load_presets():
    return json.load(open(os.path.join(HERE, 'voices.json'), encoding='utf-8'))


def cmd_narration(args):
    html = os.path.abspath(args.html)
    script, lines = read_script(html)
    presets = load_presets()
    preset = dict(presets.get(args.preset, {})) if args.preset else {}
    if args.voice: preset.update(engine='kokoro', voice=args.voice)
    if args.speed: preset['speed'] = args.speed
    if not args.from_dir and not preset:
        sys.exit('choose --preset, --voice or --from-dir')
    print('synthesizing %d lines…' % len(lines))
    clips = dynamics([trim(c) for c in synthesize_lines(lines, args, preset)])
    clips, lufs, gain_db = normalize(clips)
    total = sum(len(c) for c in clips) / SR
    label = args.label or preset.get('label', 'Narration voice')
    meta = {
        'label': label,
        'temporary': bool(args.temporary if args.temporary is not None else preset.get('label', '').upper().startswith('TEMPORARY')),
        'provider': 'external recordings' if args.from_dir else 'Kokoro-82M via kokoro-onnx (local, Apache-2.0)',
        'voice': os.path.basename(os.path.normpath(args.from_dir)) if args.from_dir else preset.get('voice'),
        'speed': None if args.from_dir else preset.get('speed', 1.0),
        'description': preset.get('description', ''),
        'loudness': '%.0f LUFS integrated' % TARGET_LUFS,
        'codec': 'mp3 %d Hz mono %s' % (SR, args.bitrate),
        'generated': datetime.date.today().isoformat(),
        'speechSeconds': round(total, 2),
    }
    asset = {'format': 'code-execution-lab/voice-asset@1', 'meta': meta, 'lines': {}}
    for ln, c in zip(lines, clips):
        asset['lines'][ln['id']] = {'text': ln['text'], 'duration': round(len(c) / SR, 3), 'mime': 'audio/mpeg',
                                    'data': base64.b64encode(encode_mp3(c, args.bitrate)).decode('ascii')}
    js = asset_to_json(asset)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        open(args.out, 'w', encoding='utf-8').write(js)
        print('wrote', args.out, '(%.0f KB)' % (len(js) / 1024))
    if args.embed:
        embed_asset(html, js)
        print('embedded into', html)
    import pyloudnorm as pyln
    final = pyln.Meter(SR).integrated_loudness(np.concatenate(clips).astype(np.float64))
    print('speech %.1fs · loudness %.1f → %.1f LUFS (gain %+.1f dB) · asset %.0f KB' % (total, lufs, final, gain_db, len(js) / 1024))


def cmd_samples(args):
    presets = load_presets()
    eng = KokoroEngine(args.models)
    os.makedirs(args.out, exist_ok=True)
    report = []
    for key in args.presets:
        p = presets[key]
        clips = dynamics([trim(eng.say(t, p)) for t in SAMPLE_LINES])
        clips, _, _ = normalize(clips)
        gap = np.zeros(int(0.75 * SR), np.float32)
        x = np.concatenate([np.zeros(int(0.25 * SR), np.float32), clips[0], gap, clips[1], np.zeros(int(0.4 * SR), np.float32)])
        name = 'voice-%s-%s' % (key.lower(), p['voice'])
        path = os.path.join(args.out, name + '.mp3')
        open(path, 'wb').write(encode_mp3(x, '96k'))
        report.append({'sample': p['label'], 'file': os.path.relpath(path, ROOT), 'voice': p['voice'], 'lang': p['lang'], 'speed': p['speed'],
                       'seconds': round(len(x) / SR, 2), 'lineSeconds': [round(len(c) / SR, 2) for c in clips], 'description': p['description']})
        print('%s → %s (%.1fs)' % (p['label'], path, len(x) / SR))
    json.dump(report, open(os.path.join(args.out, 'samples.json'), 'w'), indent=2)


def cmd_list(args):
    _, lines = read_script(os.path.abspath(args.html))
    for ln in lines:
        print('%-14s %s' % (ln['id'], ln['text']))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    default_models = os.environ.get('KOKORO_MODELS', os.path.expanduser('~/.cache/kokoro'))
    n = sub.add_parser('narration', help='build the narration voice asset')
    n.add_argument('--html', default=os.path.join(ROOT, 'index.html'))
    n.add_argument('--preset'); n.add_argument('--voice'); n.add_argument('--speed', type=float)
    n.add_argument('--from-dir', help='folder of pre-recorded clips named <line-id>.<ext>')
    n.add_argument('--label'); n.add_argument('--temporary', type=lambda s: s.lower() in ('1', 'true', 'yes'), default=None)
    n.add_argument('--bitrate', default='64k')
    n.add_argument('--out'); n.add_argument('--embed', action='store_true')
    n.add_argument('--models', default=default_models)
    n.set_defaults(fn=cmd_narration)
    s = sub.add_parser('samples', help='render the comparison samples')
    s.add_argument('--presets', nargs='+', default=['A', 'B', 'C'])
    s.add_argument('--out', default=os.path.join(ROOT, 'voice-samples'))
    s.add_argument('--models', default=default_models)
    s.set_defaults(fn=cmd_samples)
    l = sub.add_parser('list-lines', help='print every narration line id and its text')
    l.add_argument('--html', default=os.path.join(ROOT, 'index.html'))
    l.set_defaults(fn=cmd_list)
    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
