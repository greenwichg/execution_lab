# Narration voice tools

The narration voice is a **replaceable asset**. `index.html` contains two data blocks:

| Block | What it is | Who edits it |
|---|---|---|
| `<script id="narration-script">` | the narration text, one cue per story beat, each tied to a visual moment (`anchor`) | you, by hand |
| `<script id="voice-asset">` | one MP3 clip per narration line + metadata (label, provider, loudness) | this tool |

The app lays out the narrated cut from whatever clips it finds: each line's duration decides how much story time slows down around it. **No code changes when the voice changes.**

## Current voice

`TEMPORARY NARRATION VOICE` — Kokoro-82M, voice `af_heart` at speed 0.88, rendered locally (Apache-2.0, commercial use allowed). It is a placeholder until a final voice is chosen from the samples in `voice-samples/`.

## Setup (once)

```sh
pip install -r tools/voice/requirements.txt
# Kokoro model files (~330 MB) — only needed to synthesize, not for --from-dir
mkdir -p ~/.cache/kokoro && cd ~/.cache/kokoro
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

`espeak-ng` must be installed for Kokoro's phonemizer (`apt install espeak-ng` / `brew install espeak-ng`). Set `KOKORO_MODELS=/path` to keep the models elsewhere.

## Common tasks

```sh
# see every line id and its text
python3 tools/voice/build_voice.py list-lines

# re-render the embedded voice after editing the script (rewrites index.html in place)
python3 tools/voice/build_voice.py narration --preset temporary --embed

# try another Kokoro voice for the whole narration
python3 tools/voice/build_voice.py narration --voice am_michael --speed 0.9 --label "Voice B" --embed

# render the three comparison samples again
python3 tools/voice/build_voice.py samples --presets A B C
```

## Replacing the voice with a human narrator or another TTS service

1. Run `list-lines` and record (or generate) one file per line, named by line id: `intro.0.wav`, `intro.1.wav`, `source.0.wav`, … Any of `.wav .mp3 .m4a .flac .ogg` works. Leave a little air at both ends; the tool trims silence.
2. Build and embed the asset:

   ```sh
   python3 tools/voice/build_voice.py narration --from-dir path/to/takes --label "Final narration" --temporary false --embed
   ```

   Every clip is trimmed, gently compressed, and normalised as a set to −18 LUFS (peaks ≤ −1.5 dBFS). The clips are then encoded as 24 kHz mono MP3 and written into the `voice-asset` block.
3. Open `index.html`. The narrated cut re-times itself from the new clip lengths, and the "temporary" label disappears.

To audition a voice without touching `index.html`, write it to a file with `--out voice.json` and open `index.html?voice=voice.json` from a local web server. This option doesn't work from `file://`.

If you use a cloud TTS provider, keep its API key in your shell environment or a secrets manager. It must never appear in `index.html`, in the asset, or in this repository. The asset only ever contains audio and plain metadata.

## Editing the script

Change a line's `text` in the `narration-script` block, then re-run `narration --embed`. If you forget, the app still plays; the changed line shows as subtitles only, and the browser console notes the mismatch. Anchors (`"beat": "fetch", "offset": -0.3`) refer to keys of the `TL` story table in the code. `holds` keep a story beat waiting until a cue has finished speaking.
