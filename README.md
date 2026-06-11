# 🎹 YouTube MIDI Sampler

A Chrome extension that turns YouTube videos into MIDI controllers. Draw sampler boxes on any video; each box continuously averages the color underneath it and converts the brightness into a MIDI value (0–127), sent to any MIDI output — a synth, or your DAW via a virtual MIDI port.

Think of it as a video-driven modulation source: sunsets become filter sweeps, strobing concert footage becomes rhythmic note patterns, slow pans become evolving CC curves.

## Features

- **Multiple sampler regions** — draw boxes directly on the video; drag to move, drag the bottom-right corner to resize, click the name to rename
- **Message types** — Note, CC, or Program Change per sampler
- **Flexible targets** — the sampled value can drive velocity (fixed note), note number (fixed velocity), both at once (→Note+Vel), CC value, or CC number
- **Sampler linking** — combine two samplers into one message (one drives note, the other velocity), with flow-chart arrows on the overlay and badges in the panel
- **Scale quantization** — snap note output to one of 14 scales/modes, with a named root note and a selectable octave range
- **Timing control** — global polling rate with per-sampler overrides; Δ-only mode sends only when the value changes by a configurable threshold
- **Note-off handling** — automatic note-offs when the note changes, with optional delay; All Notes Off on stop
- **Presets** — save and recall full sampler/global configurations (browser localStorage)
- **MIDI logger** — live view of every message sent, in the panel or popped out into its own moveable window
- **Recorder** — record the MIDI output, edit it event by event, replay it, save named takes, and export standard `.mid` files (format 0) for any DAW
- **Friendly panel** — draggable, resizable, organized into sections, with built-in `?` help for every control

## Requirements

- Chrome (or any Chromium-based browser with Web MIDI support)
- Somewhere to send MIDI: a hardware synth, or a DAW reachable through a virtual MIDI port (setup below)

## Installation

1. Clone or download this repository:
   ```sh
   git clone https://github.com/betabit/youtube-midi-sampler.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the `code/` directory
5. Navigate to any YouTube video — a 🎹 button appears in the top right of the page
6. Click it to open the panel

After pulling updates, click the reload (↻) icon on the extension card in `chrome://extensions` and refresh the YouTube tab.

## Setting up a virtual MIDI port (to reach your DAW)

The extension sends MIDI to a system MIDI output. To route it into a DAW, create a virtual port:

**macOS** — built in:
1. Open **Audio MIDI Setup** (Applications → Utilities)
2. Window → **Show MIDI Studio**
3. Double-click **IAC Driver** and check **Device is online**
4. The IAC bus now appears as an output in the extension and as an input in your DAW

**Windows** — install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html), create a port, and select it in both the extension and your DAW.

**Linux** — use an ALSA virtual MIDI port (`sudo modprobe snd-virmidi`) or route with `aconnect`/JACK.

## Quick start

1. Open a YouTube video and click the 🎹 button
2. **Connect MIDI** — allow the browser's MIDI permission prompt
3. Pick a device in the **output dropdown** (nothing is sent or logged until you do)
4. **+ Add Sampler**, then click and drag a box over an interesting part of the video
5. Set the sampler's Type/Target (defaults: Note, →Note — brightness picks the pitch)
6. Press **▶ Start** — MIDI flows; check **Show MIDI Logger** to watch it
7. Tweak on the fly: every field is editable while sampling runs

### Recording and exporting

In the **Recorder** section: **● Record** captures everything sent to the output with timing; **▶ Play** replays it; **Edit Events** opens a per-event editor (times, values, deletes); **Save Recording** keeps named takes; **Export .mid** downloads a standard MIDI file you can drop into any DAW.

### Tips

- Enable **Δ Only** (globally or per sampler) so messages are sent only on change — less MIDI spam, smaller recordings
- **Quantize to Scale** plus a narrow octave range turns noisy video into melodic material
- Use **Send Note Off** with a delay for more natural note lengths
- Two samplers, linked: point sampler A's Link at B with A targeting →Note — A picks the pitch, B supplies the velocity, one combined message
- High-contrast, slowly changing footage gives the most controllable results; DRM-protected videos can't be sampled (the canvas reads black)

## Development

There is deliberately **no build step**. The extension is three hand-editable files plus two vendored libraries:

```
code/
├── manifest.json      # MV3 manifest
├── content.js         # all extension logic (sampling, MIDI, UI)
├── styles.css         # panel styling
└── vendor/
    ├── preact.min.js  # preact@10.26.9, pinned
    └── htm.js         # htm@3.1.1, pinned
```

The sampler list renders as a Preact component (via `htm` tagged templates — no JSX, no compiler); other panel sections are being migrated opportunistically. To hack on it: edit, reload the extension in `chrome://extensions`, refresh YouTube.

## Troubleshooting

- **"No MIDI devices" in the dropdown** — create the virtual port (IAC/loopMIDI) *before* clicking Connect MIDI, then reconnect
- **Logger stays empty** — make sure an output device is actually selected; sending is skipped without one
- **Sampler values stuck at 0/black** — the video may be DRM-protected, or the box may be outside the video area; try resizing the window (the overlay re-aligns on resize/scroll)
- **Notes hang in your synth** — press ⏸ Stop (sends All Notes Off on all 16 channels)
