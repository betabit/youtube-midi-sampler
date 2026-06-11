# Exploration: turning the sampler into a VST / AudioUnit plugin

Status: exploration only — no commitment. Written 2026-06-11.

## Framing

A Chrome extension cannot "become" a plugin: extensions run inside Chrome against web APIs; VST3/AU plugins are native libraries loaded into a DAW process. The real question is **which architecture delivers the video-to-MIDI capability inside a DAW**, how much of the existing code survives the trip, and whether the payoff justifies the cost.

## What we already have (and what it can't do)

Today the extension sends MIDI through a virtual port (IAC on macOS, loopMIDI on Windows) and the DAW records it like any external controller. This already covers: live performance into a track, capturing takes, and the `.mid` export path for offline workflows.

What it fundamentally cannot do:

| Limitation | Why it matters |
|---|---|
| Timing jitter | Sampling runs on a browser `setInterval` (~10ms granularity, deprioritized in background tabs); events arrive at the DAW with millisecond slop rather than sample-accurate timestamps |
| No host tempo | Samplers poll in milliseconds, not musical divisions; you can't say "sample on every 16th note" |
| No project state | Sampler setups live in browser localStorage, not in the DAW project file |
| No automation | DAW automation can't reach sampler parameters (rate, thresholds, scale, etc.) |

Anything a plugin build does must be measured against this list — if a feature doesn't need one of these, the extension is the cheaper home for it.

## Architecture options

### Option A — JUCE 8 plugin with an embedded WebView (recommended if we go native)

JUCE 8's `WebBrowserComponent` wraps the platform webview (WKWebView on macOS, WebView2 on Windows) and provides a JS↔C++ bridge. The plugin window hosts a webview that loads youtube.com; a user script injects essentially our existing sampling core (overlay canvas, `sampleBoxArea`, region management); sampled values cross the bridge into C++, which emits MIDI events inside `processBlock` with host-synced, sample-accurate timing.

What survives from this repo:

- The sampling logic (canvas drawImage/getImageData works the same in WKWebView/WebView2 for non-DRM video — the constraint is identical to Chrome today)
- The Preact panel UI, nearly wholesale, rendered in the same webview
- The musical logic (quantization, linking, targets) — either kept in JS or ported to C++ depending on where timing decisions live

What gets replaced: Web MIDI (the host delivers MIDI), presets/recordings storage (plugin state chunk saved with the project), and the recorder's playback timing (host transport).

New capabilities unlocked: tempo-synced sampling (poll on musical divisions via the host's playhead), automatable parameters, per-instance state in the project file.

Risks and unknowns:

- YouTube inside a plugin webview: practically it's just a browser visiting youtube.com; functionally fine, but playback requires the plugin window to stay open and the machine online
- WebView2 must be present on Windows (ubiquitous on Win 11, installable on 10)
- Keyboard/mouse focus inside plugin webviews is historically fiddly in some hosts
- DRM-protected streams remain unsampleable (same as today)

### Option B — plugin that decodes local video files

A JUCE plugin using native decoding (AVFoundation / Media Foundation / ffmpeg) to play a dropped video file and sample pixels directly in C++. Clean, no webview, fully offline — but it **loses YouTube entirely**, which is the identity of this project. This is a different product ("video file modulator"), worth remembering as a fallback, not as the goal.

### Option C — thin receiver plugin + the existing extension

A small plugin that just receives values from the extension over a local WebSocket and re-emits MIDI in the host. Ruled out: the browser still generates the events, so the timing problem isn't solved; it adds an IPC layer and a native build while buying almost nothing over IAC.

### Option D — stay in the extension, add MIDI clock sync (the cheap win)

Web MIDI is bidirectional. The extension can listen to **MIDI clock** (24 PPQN) or MTC from the DAW via the same IAC bus and quantize sampling to tempo divisions ("sample every 8th note") instead of milliseconds. This captures the single biggest musical benefit of a plugin — tempo sync — for roughly an afternoon of work, entirely in JS, no toolchain change. Jitter improves too, since sends align to received clock edges rather than free-running timers.

This should probably happen *regardless* of the plugin decision, and what we learn from using it informs whether the remaining plugin benefits (project state, automation, sample accuracy) still feel worth a native build.

## Recommended path

1. **Now:** Option D — MIDI clock sync in the extension. Small, reversible, immediately musical.
2. **Proof of concept (about a half day, before any JUCE):** a bare macOS app with a WKWebView that loads YouTube, injects the sampling script, and logs values crossing the bridge. This de-risks the one real unknown of Option A — frame access and bridge throughput outside Chrome — with near-zero investment.
3. **If the PoC feels good and the itch persists:** JUCE 8 project, AU + VST3 targets, webview UI, bridge → `processBlock` MIDI with host-tempo quantization. Port the panel last; it already works in a webview.

## Effort and distribution realities

- PoC: hours-to-days. Polished plugin: a multi-week C++ side project (JUCE learning curve included).
- Toolchain: Xcode + JUCE (free for this scale under JUCE's license tiers); Node still not required.
- Validation: `auval` for AudioUnits, `pluginval` for both formats, plus manual testing per host (Live, Logic, Reaper behave differently around webviews).
- Distribution beyond this machine: code signing + notarization on macOS (Apple Developer Program, $99/yr); VST3 requires agreeing to Steinberg's license terms.
- Local-only use: none of the distribution overhead applies — unsigned local builds load fine in most hosts.

## Decision checklist

Go native when at least one of these is true and Option D didn't satisfy it:

- [ ] Tempo-synced sampling via MIDI clock proved valuable but too jittery in the browser
- [ ] Sampler setups need to live in DAW project files
- [ ] DAW-side automation of sampler parameters becomes a real workflow want
- [ ] The extension's background-tab throttling bites during real sessions
