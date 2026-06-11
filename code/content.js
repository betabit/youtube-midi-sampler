(function() {
    'use strict';

    // Preact + htm are vendored in code/vendor/ and loaded by the manifest
    // before this file - declarative rendering with no build step
    const { h, render } = self.preact;
    const html = self.htm.bind(h);

    let midiAccess = null;
    let selectedOutput = null;
    let samplers = [];
    let nextSamplerId = 1;
    let isActive = false;
    let isDrawing = false;
    let currentSampler = null;
    let dragTarget = null;
    let dragOffset = { x: 0, y: 0 };
    let overlayCanvas = null;
    let overlayCtx = null;
    let panel = null;
    let toggleBtn = null;
    let videoElement = null;
    let sampleInterval = null;
    let midiLogger = [];
    let maxLogEntries = 20;
    let loggerVisible = false;
    let loggerWindow = null; // Floating window when the logger is popped out
    let isRecording = false;
    let recordStartTime = 0;
    let recordedEvents = []; // {t: ms since record start, bytes: [status, d1, d2?]}
    let isPlaying = false;
    let playbackInterval = null;
    let playbackStartTime = 0;
    let playbackIndex = 0;
    let recordings = {}; // Saved named recordings
    let timerInterval = null;
    let globalPollingInterval = 50; // Global default polling rate
    let globalDeltaThreshold = 1; // Global delta threshold for "send on change"
    let globalSendOnChangeOnly = false; // Global delta checkbox
    let globalMidiChannel = 1; // Global MIDI channel
    let presets = {}; // Store presets
    let tempCanvas = null; // Reused across sampleColors ticks
    let tempCtx = null;

    // Note names for display
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Selectable octaves for quantization range (C-1 = note 0, B9 = note 131 clamped to 127)
    const octaveChoices = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    
    function getNoteNameWithOctave(midiNote) {
        const octave = Math.floor(midiNote / 12) - 1;
        const noteName = noteNames[midiNote % 12];
        return `${noteName}${octave}`;
    }
    
    function midiNoteFromName(noteName, octave) {
        const noteIndex = noteNames.indexOf(noteName);
        return (octave + 1) * 12 + noteIndex;
    }

    function makeDraggable(el, handle) {
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        handle.style.cursor = 'move';
        handle.addEventListener('mousedown', (e) => {
            // Buttons and inputs in the handle keep their normal behavior
            if (e.target.closest('button, input, select')) return;
            dragging = true;
            const rect = el.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            // Switch from right-anchored to left-anchored positioning
            el.style.left = rect.left + 'px';
            el.style.top = rect.top + 'px';
            el.style.right = 'auto';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const x = Math.min(Math.max(e.clientX - offsetX, 0), window.innerWidth - 80);
            const y = Math.min(Math.max(e.clientY - offsetY, 0), window.innerHeight - 40);
            el.style.left = x + 'px';
            el.style.top = y + 'px';
        });
        document.addEventListener('mouseup', () => {
            dragging = false;
        });
    }

    // Musical scales (semitones from root)
    const scales = {
        'chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        'major': [0, 2, 4, 5, 7, 9, 11],
        'minor': [0, 2, 3, 5, 7, 8, 10],
        'dorian': [0, 2, 3, 5, 7, 9, 10],
        'phrygian': [0, 1, 3, 5, 7, 8, 10],
        'lydian': [0, 2, 4, 6, 7, 9, 11],
        'mixolydian': [0, 2, 4, 5, 7, 9, 10],
        'locrian': [0, 1, 3, 5, 6, 8, 10],
        'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
        'melodic-minor': [0, 2, 3, 5, 7, 9, 11],
        'pentatonic-major': [0, 2, 4, 7, 9],
        'pentatonic-minor': [0, 3, 5, 7, 10],
        'blues': [0, 3, 5, 6, 7, 10],
        'whole-tone': [0, 2, 4, 6, 8, 10]
    };

    function init() {
        console.log('YouTube MIDI Sampler initializing...');
        const checkVideo = setInterval(() => {
            videoElement = document.querySelector('video');
            if (videoElement) {
                console.log('Video element found!');
                clearInterval(checkVideo);
                createUI();
            }
        }, 1000);
    }

    function createUI() {
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'midi-sampler-toggle';
        toggleBtn.innerHTML = '🎹';
        toggleBtn.title = 'Toggle MIDI Sampler';
        document.body.appendChild(toggleBtn);

        panel = document.createElement('div');
        panel.id = 'midi-sampler-panel';
        panel.innerHTML = `
            <div class="midi-panel-header">
                <h3>🎹 MIDI Sampler</h3>
                <button id="midi-toggle-btn">▶ Start</button>
                <button id="midi-help-btn" title="How sampler linking works">?</button>
                <button id="midi-close-btn">×</button>
            </div>
            <div class="midi-panel-content">
                <div id="midi-help" style="display: none;">
                    <strong>How linking works</strong>
                    <p>Linking combines two samplers into a single MIDI message. Set a sampler's <em>Link</em> dropdown to point at another sampler with the same Type and Channel.</p>
                    <ul>
                        <li>The linking sampler's <em>Target</em> picks what its color controls (e.g. →Note); the linked sampler supplies the other half (e.g. velocity).</li>
                        <li>The combined message is sent by the linking sampler, at its polling rate.</li>
                        <li>Badges show direction: blue ← means another sampler links to this one, orange → means this one links out. On the video overlay, a dashed arrow points from the linking sampler to its partner.</li>
                        <li>Only need one box? The <em>→Note+Vel</em> target makes a single sampler drive both note and velocity without linking.</li>
                    </ul>
                </div>
                <div class="midi-section">
                    <div class="midi-section-title">
                        <span>MIDI Connection</span>
                        <button class="midi-section-help-btn" data-help="connection" title="About these controls">?</button>
                    </div>
                    <div class="midi-help-box" id="midi-help-connection" style="display: none;">
                        <ul>
                            <li><em>Connect MIDI</em> – asks the browser for MIDI access (allow the prompt).</li>
                            <li><em>Output</em> – the device or virtual port that receives the messages, e.g. an IAC bus into your DAW. Nothing is sent or logged until an output is selected.</li>
                        </ul>
                    </div>
                    <div class="midi-control-group">
                        <button id="midi-connect-btn">Connect MIDI</button>
                        <select id="midi-output-select">
                            <option value="">No MIDI devices</option>
                        </select>
                    </div>
                </div>
                <div class="midi-section">
                    <div class="midi-section-title">
                        <span>Global Parameters</span>
                        <button class="midi-section-help-btn" data-help="globals" title="About these controls">?</button>
                    </div>
                    <div class="midi-help-box" id="midi-help-globals" style="display: none;">
                        Defaults applied to newly created samplers:
                        <ul>
                            <li><em>Channel</em> – MIDI channel (1–16) new samplers start on.</li>
                            <li><em>Rate</em> – how often samplers read the video color, in milliseconds. Samplers without a custom rate follow changes to this.</li>
                            <li><em>Delta Threshold</em> – with Δ Only on, the minimum change in MIDI value (0–127) before another message is sent.</li>
                            <li><em>Δ Only</em> – new samplers only send when their value changes by at least the threshold, instead of on every poll.</li>
                        </ul>
                    </div>
                    <div class="midi-control-group">
                        <label style="display: flex; align-items: center; gap: 5px; font-size: 12px;">
                            <span>Channel:</span>
                            <input type="number" id="global-midi-channel" min="1" max="16" value="1" title="Global MIDI Channel" style="width: 50px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; background: rgba(255, 255, 255, 0.1); color: #fff; font-size: 11px;">
                        </label>
                        <label style="display: flex; align-items: center; gap: 5px; font-size: 12px;">
                            <span>Rate:</span>
                            <input type="number" id="global-polling-interval" min="10" max="5000" step="10" value="50" placeholder="ms" title="Global Polling Interval (ms)" style="width: 70px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; background: rgba(255, 255, 255, 0.1); color: #fff; font-size: 11px;">
                            <span style="font-size: 10px; color: #888;">ms</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 5px; font-size: 12px;">
                            <span>Delta Threshold:</span>
                            <input type="number" id="global-delta-threshold" min="0" max="127" step="1" value="1" placeholder="Δ" title="Global Delta Threshold (MIDI value change required)" style="width: 50px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; background: rgba(255, 255, 255, 0.1); color: #fff; font-size: 11px;">
                        </label>
                        <label style="display: flex; align-items: center; gap: 3px; font-size: 12px;">
                            <input type="checkbox" id="global-send-on-change">
                            <span>Δ Only</span>
                        </label>
                    </div>
                </div>
                <div class="midi-section">
                    <div class="midi-section-title">
                        <span>Presets</span>
                        <button class="midi-section-help-btn" data-help="presets" title="About these controls">?</button>
                    </div>
                    <div class="midi-help-box" id="midi-help-presets" style="display: none;">
                        <ul>
                            <li><em>Save Preset</em> – stores all samplers and the global parameters under a name (kept in this browser's local storage).</li>
                            <li><em>Select Preset</em> – loads a saved preset, replacing the current samplers.</li>
                            <li><em>Delete</em> – removes the preset chosen in the dropdown.</li>
                        </ul>
                    </div>
                    <div class="midi-control-group">
                        <button id="save-preset-btn" title="Save current state as preset">Save Preset</button>
                        <select id="preset-select" title="Load preset">
                            <option value="">Select Preset...</option>
                        </select>
                        <button id="delete-preset-btn" title="Delete selected preset">Delete</button>
                    </div>
                </div>
                <div class="midi-section">
                    <div class="midi-section-title">
                        <span>Samplers</span>
                        <button class="midi-section-help-btn" data-help="samplers" title="About these controls">?</button>
                    </div>
                    <div class="midi-help-box" id="midi-help-samplers" style="display: none;">
                        <em>+ Add Sampler</em> then drag a box on the video; the box's average color becomes a MIDI value (0–127, by brightness). Drag a box to move it, drag its bottom-right corner to resize, click its name to rename. Per-sampler fields:
                        <ul>
                            <li><em>Type</em> – the MIDI message kind: Note, CC, or Program Change.</li>
                            <li><em>Target</em> – what the sampled value drives: →Note (fixed velocity), →Velocity (fixed note), →Note+Vel (both), →Value or →CC# for CC samplers.</li>
                            <li><em>Link</em> – combine two samplers into one message (see the ? in the title bar).</li>
                            <li><em>Δ Only</em> – send only when the value changes by the global delta threshold.</li>
                            <li><em>Channel / Note / CC#</em> – the channel, and the fixed note or controller number when the Target doesn't control it.</li>
                            <li><em>Rate (ms)</em> – this sampler's polling interval, overriding the global rate.</li>
                            <li><em>Next / Color / Value</em> – countdown to the next sample, the current color, and the resulting MIDI value.</li>
                            <li><em>Quantize to Scale</em> – snap →Note values to a key: pick Scale, Root, Octave, and the Min/Max octave range.</li>
                            <li><em>Send Note Off</em> – send a note-off when the note changes, optionally delayed.</li>
                        </ul>
                    </div>
                    <div class="midi-control-group">
                        <button id="midi-add-sampler-btn">+ Add Sampler</button>
                        <label>
                            <input type="checkbox" id="midi-show-overlay"> Show Overlay
                        </label>
                    </div>
                    <div id="midi-samplers-list"></div>
                </div>
                <div class="midi-section">
                    <div class="midi-section-title">
                        <span>Recorder</span>
                        <button class="midi-section-help-btn" data-help="recorder" title="About these controls">?</button>
                    </div>
                    <div class="midi-help-box" id="midi-help-recorder" style="display: none;">
                        <ul>
                            <li><em>● Record</em> – captures every MIDI message sent to the output (notes, note-offs, CCs) with timing, until stopped. Starting a new recording replaces the unsaved one.</li>
                            <li><em>▶ Play</em> – replays the current recording to the selected output with original timing. Stopping mid-take sends All Notes Off. Playback is not shown in the logger.</li>
                            <li><em>Save Recording</em> – stores the current take under a name (kept in this browser's local storage). <em>Select Recording</em> loads one; <em>Delete</em> removes it.</li>
                            <li><em>Edit Events</em> – shows the take as an editable list: change times (ms) and data values, or delete events. Time edits take effect (and re-order) on play.</li>
                            <li><em>Export .mid</em> – downloads the current recording as a standard MIDI file (format 0, 120 BPM) for any DAW.</li>
                        </ul>
                        Tip: enable Δ Only on samplers to keep recordings compact.
                    </div>
                    <div class="midi-control-group">
                        <button id="midi-record-btn">● Record</button>
                        <button id="midi-play-btn">▶ Play</button>
                        <span id="midi-record-status">no recording</span>
                    </div>
                    <div class="midi-control-group">
                        <button id="save-recording-btn" title="Save the current recording">Save Recording</button>
                        <select id="recording-select" title="Load recording">
                            <option value="">Select Recording...</option>
                        </select>
                        <button id="delete-recording-btn" title="Delete selected recording">Delete</button>
                        <button id="export-recording-btn" title="Download the current recording as a standard MIDI file">Export .mid</button>
                    </div>
                    <div class="midi-control-group">
                        <label>
                            <input type="checkbox" id="midi-show-events"> Edit Events
                        </label>
                    </div>
                    <div id="midi-event-list" style="display: none;"></div>
                </div>
                <div class="midi-section">
                    <div class="midi-section-title">
                        <span>Logging</span>
                        <button class="midi-section-help-btn" data-help="logging" title="About these controls">?</button>
                    </div>
                    <div class="midi-help-box" id="midi-help-logging" style="display: none;">
                        <ul>
                            <li><em>Show MIDI Logger</em> – displays the last 20 messages sent (newest first), including note-offs and system events. Requires a selected MIDI output.</li>
                            <li><em>Pop Out</em> – moves the log into its own moveable, resizable window; pop it back in from either button.</li>
                        </ul>
                    </div>
                    <div class="midi-control-group">
                        <label>
                            <input type="checkbox" id="midi-show-logger"> Show MIDI Logger
                        </label>
                        <button id="midi-logger-popout-btn" title="Open the log in its own moveable window">⇱ Pop Out</button>
                    </div>
                    <div id="midi-logger-home">
                        <div id="midi-logger" style="display: none;"></div>
                    </div>
                </div>
                <div class="midi-status" id="midi-status">
                    Click "Connect MIDI" to begin
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        makeDraggable(panel, panel.querySelector('.midi-panel-header'));

        overlayCanvas = document.createElement('canvas');
        overlayCanvas.id = 'midi-sampler-overlay';
        overlayCanvas.style.display = 'none';
        document.body.appendChild(overlayCanvas);
        overlayCtx = overlayCanvas.getContext('2d');

        setupEventListeners();
        updateCanvasSize();
        
        window.addEventListener('resize', updateCanvasSize);
        window.addEventListener('scroll', updateCanvasSize);
        
        const observer = new MutationObserver(() => {
            updateCanvasSize();
        });
        observer.observe(document.body, { 
            attributes: true, 
            childList: true, 
            subtree: true,
            attributeFilter: ['class', 'style']
        });

        console.log('UI created successfully!');
    }

    function updateCanvasSize() {
        if (!videoElement || !overlayCanvas) return;
        
        const rect = videoElement.getBoundingClientRect();
        overlayCanvas.style.left = (rect.left + window.scrollX) + 'px';
        overlayCanvas.style.top = (rect.top + window.scrollY) + 'px';
        overlayCanvas.width = rect.width;
        overlayCanvas.height = rect.height;
        overlayCanvas.style.width = rect.width + 'px';
        overlayCanvas.style.height = rect.height + 'px';
        
        if (samplers.length > 0) {
            drawSamplers();
        }
    }

    function setupEventListeners() {
        toggleBtn.addEventListener('click', () => {
            const isVisible = panel.style.display !== 'none';
            // 'flex' keeps the header/content column layout that resizing relies on
            panel.style.display = isVisible ? 'none' : 'flex';
            if (!isVisible) {
                updateCanvasSize();
            }
        });

        document.getElementById('midi-toggle-btn').addEventListener('click', () => {
            isActive = !isActive;
            const btn = document.getElementById('midi-toggle-btn');
            if (isActive) {
                btn.textContent = '⏸ Stop';
                startSampling();
            } else {
                btn.textContent = '▶ Start';
                stopSampling();
            }
        });

        document.getElementById('midi-help-btn').addEventListener('click', () => {
            const helpEl = document.getElementById('midi-help');
            helpEl.style.display = helpEl.style.display === 'none' ? 'block' : 'none';
        });

        panel.querySelectorAll('.midi-section-help-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const helpEl = document.getElementById('midi-help-' + btn.dataset.help);
                if (helpEl) {
                    helpEl.style.display = helpEl.style.display === 'none' ? 'block' : 'none';
                }
            });
        });

        document.getElementById('midi-close-btn').addEventListener('click', () => {
            panel.style.display = 'none';
            overlayCanvas.style.display = 'none';
            stopSampling();
        });

        document.getElementById('midi-connect-btn').addEventListener('click', async () => {
            try {
                midiAccess = await navigator.requestMIDIAccess();
                updateMidiOutputs();
                setupMIDIInputLogging();
                updateStatus('MIDI access granted!');
                console.log('MIDI access granted and listening for messages.');
            } catch (err) {
                updateStatus('MIDI access failed: ' + err.message);
                console.warn('Could not access MIDI devices:', err);
            }
        });

        document.getElementById('midi-output-select').addEventListener('change', (e) => {
            if (midiAccess && e.target.value) {
                selectedOutput = midiAccess.outputs.get(e.target.value);
                updateStatus('MIDI output: ' + selectedOutput.name);
            }
        });

        document.getElementById('midi-add-sampler-btn').addEventListener('click', () => {
            updateCanvasSize();
            overlayCanvas.style.display = 'block';
            document.getElementById('midi-show-overlay').checked = true;
            updateStatus('Click and drag on the video to create a sampler region');
        });

        document.getElementById('midi-show-overlay').addEventListener('change', (e) => {
            if (e.target.checked) {
                updateCanvasSize();
                overlayCanvas.style.display = 'block';
                drawSamplers();
            } else {
                overlayCanvas.style.display = 'none';
            }
        });

        document.getElementById('midi-show-logger').addEventListener('change', (e) => {
            loggerVisible = e.target.checked;
            const loggerEl = document.getElementById('midi-logger');
            if (loggerWindow) {
                // Popped out: the checkbox shows/hides the whole window
                loggerWindow.style.display = loggerVisible ? 'flex' : 'none';
            } else if (loggerEl) {
                loggerEl.style.display = loggerVisible ? 'block' : 'none';
            }
            if (loggerVisible) {
                updateLogger();
            }
        });

        document.getElementById('midi-logger-popout-btn').addEventListener('click', () => {
            if (loggerWindow) {
                popInLogger();
            } else {
                popOutLogger();
            }
        });

        document.getElementById('midi-record-btn').addEventListener('click', () => {
            if (isRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });

        document.getElementById('midi-play-btn').addEventListener('click', () => {
            if (isPlaying) {
                stopPlayback();
            } else {
                startPlayback();
            }
        });

        document.getElementById('global-polling-interval').addEventListener('change', (e) => {
            globalPollingInterval = parseInt(e.target.value) || 50;
            // Update all samplers that don't have custom rates
            samplers.forEach(s => {
                if (!s.hasCustomPollingInterval) {
                    s.pollingInterval = globalPollingInterval;
                }
            });
            updateStatus(`Global polling rate set to ${globalPollingInterval}ms`);
        });

        document.getElementById('global-delta-threshold').addEventListener('change', (e) => {
            globalDeltaThreshold = parseInt(e.target.value) || 1;
            updateStatus(`Global delta threshold set to ${globalDeltaThreshold}`);
        });

        document.getElementById('global-midi-channel').addEventListener('change', (e) => {
            globalMidiChannel = parseInt(e.target.value) || 1;
            updateStatus(`Global MIDI channel set to ${globalMidiChannel}`);
        });

        document.getElementById('global-send-on-change').addEventListener('change', (e) => {
            globalSendOnChangeOnly = e.target.checked;
            updateStatus(`Global Δ Only: ${globalSendOnChangeOnly ? 'enabled' : 'disabled'}`);
        });

        document.getElementById('save-preset-btn').addEventListener('click', savePreset);
        document.getElementById('preset-select').addEventListener('change', loadPreset);
        document.getElementById('delete-preset-btn').addEventListener('click', deletePreset);

        document.getElementById('midi-show-events').addEventListener('change', (e) => {
            const listEl = document.getElementById('midi-event-list');
            listEl.style.display = e.target.checked ? 'block' : 'none';
            if (e.target.checked) {
                updateEventList();
            }
        });

        document.getElementById('save-recording-btn').addEventListener('click', saveRecording);
        document.getElementById('recording-select').addEventListener('change', loadRecording);
        document.getElementById('delete-recording-btn').addEventListener('click', deleteRecording);
        document.getElementById('export-recording-btn').addEventListener('click', exportRecording);

        loadPresetsFromStorage();
        loadRecordingsFromStorage();

        overlayCanvas.addEventListener('mousedown', handleMouseDown);
        overlayCanvas.addEventListener('mousemove', handleMouseMove);
        overlayCanvas.addEventListener('mouseup', handleMouseUp);
    }

    function handleMouseDown(e) {
        const rect = overlayCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (overlayCanvas.width / rect.width);
        const y = (e.clientY - rect.top) * (overlayCanvas.height / rect.height);

        // Check if clicking on a resize handle
        const resizeTarget = findResizeHandle(x, y);
        if (resizeTarget) {
            dragTarget = resizeTarget;
            dragTarget.isResizing = true;
            return;
        }

        // Check if clicking on existing sampler
        dragTarget = findSamplerAt(x, y);
        if (dragTarget) {
            dragOffset = { x: x - dragTarget.x, y: y - dragTarget.y };
            dragTarget.isResizing = false;
        } else {
            isDrawing = true;
            const newId = nextSamplerId++;
            currentSampler = {
                id: newId,
                name: 'Sampler ' + newId,
                x: x,
                y: y,
                width: 0,
                height: 0,
                channel: globalMidiChannel,
                type: 'note',
                noteNumber: 60,
                ccNumber: 1,
                pollingInterval: globalPollingInterval,
                hasCustomPollingInterval: false, // Track if user customized this
                lastSampleTime: 0,
                color: { r: 0, g: 0, b: 0 },
                midiValue: 0,
                lastSentValue: null, // Track last sent value
                lastSentNote: null, // Track last sent note for note-off
                sendNoteOff: true, // Send note-off messages
                noteOffDelay: 0, // Delay before sending note-off (ms)
                sendOnChangeOnly: globalSendOnChangeOnly, // Only send when value changes
                controlTarget: 'note', // 'velocity', 'note', 'both', or 'value'
                linkedSamplerId: null, // ID of sampler to link with
                quantizeToScale: false,
                scaleRoot: 60, // C (middle C)
                scaleRootNote: 'C', // Note name
                scaleRootOctave: 4, // Octave number
                scaleType: 'major',
                noteRange: { min: 0, max: 127 },
                octaveMin: -1, // Octave range for quantization (C-1..C9 = full MIDI range)
                octaveMax: 9
            };
        }
    }

    function handleMouseMove(e) {
        const rect = overlayCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (overlayCanvas.width / rect.width);
        const y = (e.clientY - rect.top) * (overlayCanvas.height / rect.height);

        // Update cursor based on hover state
        const resizeHandle = findResizeHandle(x, y);
        if (resizeHandle) {
            overlayCanvas.style.cursor = 'nwse-resize';
        } else if (findSamplerAt(x, y)) {
            overlayCanvas.style.cursor = 'move';
        } else {
            overlayCanvas.style.cursor = 'crosshair';
        }

        if (isDrawing && currentSampler) {
            currentSampler.width = x - currentSampler.x;
            currentSampler.height = y - currentSampler.y;
            drawSamplers();
        } else if (dragTarget) {
            if (dragTarget.isResizing) {
                // Resize the sampler
                dragTarget.width = x - dragTarget.x;
                dragTarget.height = y - dragTarget.y;
            } else {
                // Move the sampler
                dragTarget.x = x - dragOffset.x;
                dragTarget.y = y - dragOffset.y;
            }
            drawSamplers();
        }
    }

    function handleMouseUp(e) {
        if (isDrawing && currentSampler) {
            if (Math.abs(currentSampler.width) > 10 && Math.abs(currentSampler.height) > 10) {
                if (currentSampler.width < 0) {
                    currentSampler.x += currentSampler.width;
                    currentSampler.width = Math.abs(currentSampler.width);
                }
                if (currentSampler.height < 0) {
                    currentSampler.y += currentSampler.height;
                    currentSampler.height = Math.abs(currentSampler.height);
                }
                samplers.push(currentSampler);
                updateSamplersList();
            }
            currentSampler = null;
            isDrawing = false;
        }
        dragTarget = null;
    }

    function findSamplerAt(x, y) {
        for (let i = samplers.length - 1; i >= 0; i--) {
            const s = samplers[i];
            if (x >= s.x && x <= s.x + s.width && y >= s.y && y <= s.y + s.height) {
                return s;
            }
        }
        return null;
    }

    function findResizeHandle(x, y) {
        const handleSize = 15; // Size of the resize handle area
        for (let i = samplers.length - 1; i >= 0; i--) {
            const s = samplers[i];
            const handleX = s.x + s.width;
            const handleY = s.y + s.height;
            
            // Check if clicking near the bottom-right corner
            if (Math.abs(x - handleX) < handleSize && Math.abs(y - handleY) < handleSize) {
                return s;
            }
        }
        return null;
    }

    function drawSamplers() {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        
        // First pass: draw link lines between samplers
        samplers.forEach(s => {
            if (s.linkedSamplerId) {
                const linkedSampler = samplers.find(other => other.id === s.linkedSamplerId);
                if (linkedSampler) {
                    // Draw connection line
                    const fromX = s.x + s.width / 2;
                    const fromY = s.y + s.height / 2;
                    const toX = linkedSampler.x + linkedSampler.width / 2;
                    const toY = linkedSampler.y + linkedSampler.height / 2;
                    
                    overlayCtx.strokeStyle = '#ffa94a';
                    overlayCtx.lineWidth = 2;
                    overlayCtx.setLineDash([5, 5]);
                    overlayCtx.beginPath();
                    overlayCtx.moveTo(fromX, fromY);
                    overlayCtx.lineTo(toX, toY);
                    overlayCtx.stroke();
                    overlayCtx.setLineDash([]);
                    
                    // Draw arrow at the end
                    const angle = Math.atan2(toY - fromY, toX - fromX);
                    const arrowSize = 10;
                    overlayCtx.fillStyle = '#ffa94a';
                    overlayCtx.beginPath();
                    overlayCtx.moveTo(toX, toY);
                    overlayCtx.lineTo(
                        toX - arrowSize * Math.cos(angle - Math.PI / 6),
                        toY - arrowSize * Math.sin(angle - Math.PI / 6)
                    );
                    overlayCtx.lineTo(
                        toX - arrowSize * Math.cos(angle + Math.PI / 6),
                        toY - arrowSize * Math.sin(angle + Math.PI / 6)
                    );
                    overlayCtx.closePath();
                    overlayCtx.fill();
                }
            }
        });
        
        // Second pass: draw sampler boxes
        samplers.forEach(s => {
            overlayCtx.strokeStyle = '#4a9eff';
            overlayCtx.lineWidth = 3;
            overlayCtx.strokeRect(s.x, s.y, s.width, s.height);
            
            overlayCtx.fillStyle = 'rgba(74, 158, 255, 0.15)';
            overlayCtx.fillRect(s.x, s.y, s.width, s.height);

            const label = s.name || `Sampler ${s.id}`;
            overlayCtx.font = '12px sans-serif';
            const labelWidth = overlayCtx.measureText(label).width + 10;
            overlayCtx.fillStyle = '#4a9eff';
            overlayCtx.fillRect(s.x, s.y - 20, labelWidth, 20);
            overlayCtx.fillStyle = '#fff';
            overlayCtx.fillText(label, s.x + 5, s.y - 6);
        });

        if (currentSampler && isDrawing) {
            overlayCtx.strokeStyle = '#4a9eff';
            overlayCtx.lineWidth = 3;
            overlayCtx.strokeRect(currentSampler.x, currentSampler.y, currentSampler.width, currentSampler.height);
        }
    }

    function startSampling() {
        if (sampleInterval) clearInterval(sampleInterval);
        if (timerInterval) clearInterval(timerInterval);
        
        sampleInterval = setInterval(() => {
            if (samplers.length > 0 && videoElement) {
                sampleColors();
            }
        }, 10);

        // Update timers at 10ms for smooth countdown
        timerInterval = setInterval(() => {
            updateTimers();
        }, 10);
    }

    function stopSampling() {
        if (sampleInterval) {
            clearInterval(sampleInterval);
            sampleInterval = null;
        }
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        sendAllNotesOff();
    }

    // All real-time MIDI output goes through here so the recorder
    // captures exactly what the output device receives
    function transmit(bytes) {
        if (!selectedOutput) return;
        selectedOutput.send(bytes);
        if (isRecording) {
            recordedEvents.push({ t: Date.now() - recordStartTime, bytes: Array.from(bytes) });
            updateRecordStatus();
        }
    }

    function sendAllNotesOff() {
        if (!selectedOutput) return;

        try {
            for (let channel = 0; channel < 16; channel++) {
                transmit([0xB0 | channel, 123, 0]);
            }
            logMidi('System', 'All Notes Off (All Channels)', 0);
            updateStatus('All notes off sent');
        } catch (err) {
            console.error('All notes off error:', err);
        }
    }

    function logMidi(samplerId, message, value) {
        const timestamp = new Date().toLocaleTimeString('en-US', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit',
            fractionalSecondDigits: 3
        });
        
        midiLogger.unshift({
            time: timestamp,
            samplerId: samplerId,
            message: message,
            value: value
        });

        if (midiLogger.length > maxLogEntries) {
            midiLogger = midiLogger.slice(0, maxLogEntries);
        }

        if (loggerVisible) {
            prependLogEntry(midiLogger[0]);
        }
    }

    function renderLogEntry(entry) {
        const logEntry = document.createElement('div');
        logEntry.className = 'midi-log-entry';
        logEntry.innerHTML = `
            <span class="midi-log-time">${entry.time}</span>
            <span class="midi-log-sampler">S${entry.samplerId}:</span>
            <span class="midi-log-message">${entry.message}</span>
        `;
        return logEntry;
    }

    function prependLogEntry(entry) {
        const loggerEl = document.getElementById('midi-logger');
        if (!loggerEl) return;

        const header = loggerEl.querySelector('.midi-logger-header');
        if (!header) {
            updateLogger();
            return;
        }
        header.textContent = 'MIDI Log (most recent first)';

        // Newest entry goes directly below the header
        header.insertAdjacentElement('afterend', renderLogEntry(entry));

        // Trim the DOM to maxLogEntries (+1 for the header)
        while (loggerEl.children.length > maxLogEntries + 1) {
            loggerEl.removeChild(loggerEl.lastElementChild);
        }
    }

    function updateLogger() {
        const loggerEl = document.getElementById('midi-logger');
        if (!loggerEl || !loggerVisible) return;

        if (midiLogger.length === 0) {
            loggerEl.innerHTML = '<div class="midi-logger-header">MIDI Log (waiting for messages...)</div>';
            return;
        }

        loggerEl.innerHTML = '<div class="midi-logger-header">MIDI Log (most recent first)</div>';

        // midiLogger is ordered newest-first, so append in array order
        midiLogger.forEach(entry => {
            loggerEl.appendChild(renderLogEntry(entry));
        });
    }

    function popOutLogger() {
        loggerWindow = document.createElement('div');
        loggerWindow.id = 'midi-logger-window';
        loggerWindow.innerHTML = `
            <div class="midi-logger-window-header">
                <span>🎹 MIDI Log</span>
                <button id="midi-logger-popin-btn" title="Return the log to the panel">⇲</button>
            </div>
        `;
        document.body.appendChild(loggerWindow);

        // Move the live logger element into the window; logging keeps
        // working because everything looks it up by id
        const loggerEl = document.getElementById('midi-logger');
        loggerWindow.appendChild(loggerEl);
        loggerEl.style.display = 'block';

        loggerVisible = true;
        document.getElementById('midi-show-logger').checked = true;
        document.getElementById('midi-logger-popout-btn').textContent = '⇲ Pop In';
        updateLogger();

        makeDraggable(loggerWindow, loggerWindow.querySelector('.midi-logger-window-header'));
        document.getElementById('midi-logger-popin-btn').addEventListener('click', popInLogger);
    }

    function popInLogger() {
        if (!loggerWindow) return;
        const loggerEl = document.getElementById('midi-logger');
        document.getElementById('midi-logger-home').appendChild(loggerEl);
        loggerEl.style.display = loggerVisible ? 'block' : 'none';
        loggerWindow.remove();
        loggerWindow = null;
        document.getElementById('midi-logger-popout-btn').textContent = '⇱ Pop Out';
    }

    function describeEvent(bytes) {
        const status = bytes[0] & 0xF0;
        const ch = (bytes[0] & 0x0F) + 1;
        switch (status) {
            case 0x90: return `Note On Ch${ch}`;
            case 0x80: return `Note Off Ch${ch}`;
            case 0xB0: return `CC Ch${ch}`;
            case 0xC0: return `Prog Ch${ch}`;
            default: return `0x${bytes[0].toString(16)} Ch${ch}`;
        }
    }

    function updateEventList() {
        const listEl = document.getElementById('midi-event-list');
        if (!listEl || listEl.style.display === 'none') return;

        if (recordedEvents.length === 0) {
            listEl.innerHTML = '<div class="midi-event-empty">No events recorded</div>';
            return;
        }

        const maxEventRows = 1000;
        listEl.innerHTML = '';
        const shown = Math.min(recordedEvents.length, maxEventRows);
        for (let i = 0; i < shown; i++) {
            const ev = recordedEvents[i];
            const row = document.createElement('div');
            row.className = 'midi-event-row';
            row.innerHTML = `
                <input type="number" min="0" step="10" value="${ev.t}" data-idx="${i}" data-field="t" title="Time (ms)">
                <span class="midi-event-desc">${describeEvent(ev.bytes)}</span>
                <input type="number" min="0" max="127" value="${ev.bytes[1]}" data-idx="${i}" data-field="d1" title="Data 1 (note/CC number)">
                ${ev.bytes.length > 2 ? `<input type="number" min="0" max="127" value="${ev.bytes[2]}" data-idx="${i}" data-field="d2" title="Data 2 (velocity/value)">` : ''}
                <button class="midi-event-delete" data-idx="${i}" title="Delete event">×</button>
            `;
            listEl.appendChild(row);
        }
        if (recordedEvents.length > maxEventRows) {
            const note = document.createElement('div');
            note.className = 'midi-event-empty';
            note.textContent = `Showing first ${maxEventRows} of ${recordedEvents.length} events`;
            listEl.appendChild(note);
        }

        listEl.querySelectorAll('input').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.idx);
                const field = e.target.dataset.field;
                const value = parseInt(e.target.value) || 0;
                const ev = recordedEvents[idx];
                if (!ev) return;
                if (field === 't') {
                    ev.t = Math.max(0, value);
                } else if (field === 'd1') {
                    ev.bytes[1] = Math.min(127, Math.max(0, value));
                } else if (field === 'd2') {
                    ev.bytes[2] = Math.min(127, Math.max(0, value));
                }
                updateRecordStatus();
            });
        });

        listEl.querySelectorAll('.midi-event-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.idx);
                recordedEvents.splice(idx, 1);
                updateRecordStatus();
                updateEventList();
            });
        });
    }

    function updateRecordStatus() {
        const el = document.getElementById('midi-record-status');
        if (!el) return;
        if (recordedEvents.length === 0) {
            el.textContent = isRecording ? 'recording...' : 'no recording';
            return;
        }
        const duration = recordedEvents[recordedEvents.length - 1].t;
        el.textContent = `${recordedEvents.length} events · ${(duration / 1000).toFixed(1)}s`;
    }

    function startRecording() {
        if (isPlaying) stopPlayback();
        isRecording = true;
        recordedEvents = [];
        recordStartTime = Date.now();
        const btn = document.getElementById('midi-record-btn');
        btn.textContent = '■ Stop Rec';
        btn.classList.add('recording');
        updateRecordStatus();
        updateStatus('Recording MIDI output...');
    }

    function stopRecording() {
        isRecording = false;
        const btn = document.getElementById('midi-record-btn');
        btn.textContent = '● Record';
        btn.classList.remove('recording');
        updateRecordStatus();
        updateEventList();
        updateStatus(`Recorded ${recordedEvents.length} events`);
    }

    function startPlayback() {
        if (!selectedOutput) {
            updateStatus('Select a MIDI output before playing back');
            return;
        }
        if (recordedEvents.length === 0) {
            updateStatus('Nothing recorded yet');
            return;
        }
        if (isRecording) stopRecording();

        recordedEvents.sort((a, b) => a.t - b.t);
        isPlaying = true;
        playbackIndex = 0;
        playbackStartTime = Date.now();
        document.getElementById('midi-play-btn').textContent = '■ Stop';
        updateStatus(`Playing back ${recordedEvents.length} events...`);

        playbackInterval = setInterval(() => {
            const elapsed = Date.now() - playbackStartTime;
            while (playbackIndex < recordedEvents.length && recordedEvents[playbackIndex].t <= elapsed) {
                try {
                    selectedOutput.send(recordedEvents[playbackIndex].bytes);
                } catch (err) {
                    console.error('Playback error:', err);
                }
                playbackIndex++;
            }
            if (playbackIndex >= recordedEvents.length) {
                stopPlayback(false);
                updateStatus('Playback finished');
            }
        }, 10);
    }

    function stopPlayback(cutOffNotes = true) {
        if (playbackInterval) {
            clearInterval(playbackInterval);
            playbackInterval = null;
        }
        isPlaying = false;
        document.getElementById('midi-play-btn').textContent = '▶ Play';
        if (cutOffNotes) {
            sendAllNotesOff(); // a mid-take stop can leave notes hanging
            updateStatus('Playback stopped');
        }
    }

    function saveRecording() {
        if (recordedEvents.length === 0) {
            updateStatus('Nothing recorded to save');
            return;
        }
        const name = prompt('Enter recording name:');
        if (!name) return;

        recordings[name] = {
            events: recordedEvents.map(ev => ({ t: ev.t, bytes: [...ev.bytes] })),
            savedAt: Date.now()
        };
        localStorage.setItem('midiSamplerRecordings', JSON.stringify(recordings));
        updateRecordingList();
        updateStatus(`Recording "${name}" saved`);
    }

    function loadRecording(e) {
        const name = e.target.value;
        if (!name || !recordings[name]) return;
        if (isPlaying) stopPlayback();
        if (isRecording) stopRecording();

        recordedEvents = recordings[name].events.map(ev => ({ t: ev.t, bytes: [...ev.bytes] }));
        updateRecordStatus();
        updateEventList();
        updateStatus(`Recording "${name}" loaded`);
    }

    function deleteRecording() {
        const name = document.getElementById('recording-select').value;
        if (!name || !recordings[name]) {
            updateStatus('Select a recording to delete');
            return;
        }

        if (confirm(`Delete recording "${name}"?`)) {
            delete recordings[name];
            localStorage.setItem('midiSamplerRecordings', JSON.stringify(recordings));
            updateRecordingList();
            updateStatus(`Recording "${name}" deleted`);
        }
    }

    function loadRecordingsFromStorage() {
        try {
            const stored = localStorage.getItem('midiSamplerRecordings');
            if (stored) {
                recordings = JSON.parse(stored);
                updateRecordingList();
            }
        } catch (e) {
            console.error('Error loading recordings:', e);
        }
    }

    function writeVarLen(value, out) {
        let buffer = value & 0x7F;
        while ((value >>= 7)) {
            buffer <<= 8;
            buffer |= ((value & 0x7F) | 0x80);
        }
        while (true) {
            out.push(buffer & 0xFF);
            if (buffer & 0x80) {
                buffer >>= 8;
            } else {
                break;
            }
        }
    }

    function buildMidiFile(events) {
        const TPQ = 480; // ticks per quarter note
        const MS_PER_BEAT = 500; // 120 BPM, so 1 tick ≈ 1.04ms

        const track = [];
        // Tempo meta event: 500000 µs per beat
        track.push(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);

        const sorted = [...events].sort((a, b) => a.t - b.t);
        let lastTick = 0;
        sorted.forEach(ev => {
            const tick = Math.round(ev.t * TPQ / MS_PER_BEAT);
            writeVarLen(tick - lastTick, track);
            lastTick = tick;
            track.push(...ev.bytes);
        });

        track.push(0x00, 0xFF, 0x2F, 0x00); // end of track

        const bytes = [
            0x4D, 0x54, 0x68, 0x64, // MThd
            0, 0, 0, 6, // header length
            0, 0, // format 0
            0, 1, // one track
            (TPQ >> 8) & 0xFF, TPQ & 0xFF,
            0x4D, 0x54, 0x72, 0x6B, // MTrk
            (track.length >>> 24) & 0xFF,
            (track.length >>> 16) & 0xFF,
            (track.length >>> 8) & 0xFF,
            track.length & 0xFF
        ];
        return new Uint8Array(bytes.concat(track));
    }

    function exportRecording() {
        if (recordedEvents.length === 0) {
            updateStatus('Nothing recorded to export');
            return;
        }

        const data = buildMidiFile(recordedEvents);
        const blob = new Blob([data], { type: 'audio/midi' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const selectedName = document.getElementById('recording-select').value;
        a.download = (selectedName || 'midi-sampler-recording') + '.mid';
        a.click();
        URL.revokeObjectURL(url);
        updateStatus(`Exported ${a.download}`);
    }

    function updateRecordingList() {
        const select = document.getElementById('recording-select');
        select.innerHTML = '<option value="">Select Recording...</option>';
        Object.keys(recordings).forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
    }

    function updateTimers() {
        const currentTime = Date.now();
        let hasChanges = false;
        
        samplers.forEach(s => {
            const elapsed = currentTime - s.lastSampleTime;
            const remaining = Math.max(0, s.pollingInterval - elapsed);
            const roundedRemaining = Math.floor(remaining / 10) * 10; // Round to nearest 10ms for smoother display
            
            // Only mark as changed if rounded value is different
            if (s.displayTimeRemaining !== roundedRemaining) {
                s.displayTimeRemaining = roundedRemaining;
                hasChanges = true;
            }
        });
        
        // Only refresh UI if values actually changed
        if (hasChanges) {
            updateSamplersDisplay();
        }
    }
    
    function updateSamplersDisplay() {
        // Update only the timer displays without rebuilding the entire list
        samplers.forEach(s => {
            const timerEl = document.querySelector(`[data-timer-id="${s.id}"]`);
            if (timerEl) {
                timerEl.textContent = s.displayTimeRemaining !== undefined ? s.displayTimeRemaining + 'ms' : '—';
            }
            const valueEl = document.querySelector(`[data-value-id="${s.id}"]`);
            if (valueEl) {
                valueEl.textContent = s.midiValue;
            }
            const colorEl = document.querySelector(`[data-color-id="${s.id}"]`);
            if (colorEl) {
                colorEl.style.background = `rgb(${s.color.r}, ${s.color.g}, ${s.color.b})`;
            }
        });
    }

    function sampleColors() {
        if (!videoElement) return;

        const currentTime = Date.now();

        // Skip the tick entirely if no sampler is due
        if (!samplers.some(s => currentTime - s.lastSampleTime >= s.pollingInterval)) {
            return;
        }

        if (!tempCanvas) {
            tempCanvas = document.createElement('canvas');
            tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (tempCanvas.width !== overlayCanvas.width || tempCanvas.height !== overlayCanvas.height) {
            tempCanvas.width = overlayCanvas.width;
            tempCanvas.height = overlayCanvas.height;
        }

        try {
            tempCtx.drawImage(videoElement, 0, 0, tempCanvas.width, tempCanvas.height);

            samplers.forEach(s => {
                if (currentTime - s.lastSampleTime >= s.pollingInterval) {
                    // Sample the entire box area, not just center
                    const avgColor = sampleBoxArea(tempCtx, s.x, s.y, s.width, s.height);
                    
                    s.color = avgColor;
                    s.midiValue = rgbToMidi(avgColor.r, avgColor.g, avgColor.b);
                    s.lastSampleTime = currentTime;
                    
                    sendMidi(s);
                }
            });
        } catch (err) {
            console.error('Sampling error:', err);
        }
    }

    function rgbToMidi(r, g, b) {
        const brightness = (r + g + b) / 3;
        return Math.floor((brightness / 255) * 127);
    }

    function sampleBoxArea(ctx, x, y, width, height) {
        // Clamp the box to the canvas bounds
        const left = Math.max(0, Math.floor(x));
        const top = Math.max(0, Math.floor(y));
        const right = Math.min(ctx.canvas.width, Math.ceil(x + width));
        const bottom = Math.min(ctx.canvas.height, Math.ceil(y + height));
        const w = right - left;
        const h = bottom - top;

        if (w <= 0 || h <= 0) {
            return { r: 0, g: 0, b: 0 };
        }

        const data = ctx.getImageData(left, top, w, h).data;
        let totalR = 0, totalG = 0, totalB = 0;
        const pixelCount = w * h;

        for (let i = 0; i < data.length; i += 4) {
            totalR += data[i];
            totalG += data[i + 1];
            totalB += data[i + 2];
        }

        return {
            r: Math.floor(totalR / pixelCount),
            g: Math.floor(totalG / pixelCount),
            b: Math.floor(totalB / pixelCount)
        };
    }

    function applyOctaveRange(sampler) {
        let minOct = sampler.octaveMin !== undefined ? sampler.octaveMin : -1;
        let maxOct = sampler.octaveMax !== undefined ? sampler.octaveMax : 9;
        if (minOct > maxOct) {
            [minOct, maxOct] = [maxOct, minOct];
        }
        sampler.noteRange.min = Math.max(0, (minOct + 1) * 12);
        sampler.noteRange.max = Math.min(127, (maxOct + 1) * 12 + 11);
    }

    function quantizeToScale(noteValue, rootNote, scaleType, minNote, maxNote) {
        // Constrain to range first
        noteValue = Math.max(minNote, Math.min(maxNote, noteValue));
        
        const scale = scales[scaleType] || scales['chromatic'];
        
        // Find which octave we're in relative to root
        const relativeNote = noteValue - rootNote;
        const octave = Math.floor(relativeNote / 12);
        const noteInOctave = ((relativeNote % 12) + 12) % 12; // Handle negative numbers
        
        // Find closest note in scale
        let closestScaleNote = scale[0];
        let minDistance = Math.abs(noteInOctave - scale[0]);
        
        for (let i = 1; i < scale.length; i++) {
            const distance = Math.abs(noteInOctave - scale[i]);
            if (distance < minDistance) {
                minDistance = distance;
                closestScaleNote = scale[i];
            }
        }
        
        // Calculate final quantized note
        let quantizedNote = rootNote + (octave * 12) + closestScaleNote;
        
        // Ensure we're still in range after quantization
        quantizedNote = Math.max(minNote, Math.min(maxNote, quantizedNote));
        
        return quantizedNote;
    }

    function sendMidi(sampler) {
        if (!selectedOutput) return;

        const channel = sampler.channel - 1;
        let sampledValue = sampler.midiValue;
        
        // Apply quantization if enabled and controlling note
        if (sampler.quantizeToScale && (sampler.controlTarget === 'note' || sampler.controlTarget === 'value' || sampler.controlTarget === 'both')) {
            sampledValue = quantizeToScale(
                sampledValue,
                sampler.scaleRoot,
                sampler.scaleType,
                sampler.noteRange.min,
                sampler.noteRange.max
            );
        }
        
        // Check if we should skip sending (only send on change)
        if (sampler.sendOnChangeOnly) {
            if (sampler.lastSentValue !== null && Math.abs(sampler.lastSentValue - sampledValue) < globalDeltaThreshold) {
                return; // Value hasn't changed enough, skip sending
            }
        }
        
        // Update last sent value
        sampler.lastSentValue = sampledValue;

        try {
            let statusByte, data1, data2;
            let messageName = '';

            if (sampler.type === 'note') {
                statusByte = 0x90 | channel;
                
                // Check if this sampler is linked to another
                const linkedSampler = sampler.linkedSamplerId ? samplers.find(s => s.id === sampler.linkedSamplerId) : null;
                
                if (sampler.controlTarget === 'both') {
                    // One sampler drives both: note from the (quantized) value, velocity from the raw value
                    data1 = sampledValue;
                    data2 = sampler.midiValue;
                } else if (linkedSampler) {
                    // Use linked sampler for the complementary value
                    if (sampler.controlTarget === 'note') {
                        data1 = sampledValue; // This sampler controls note (quantized if enabled)
                        data2 = linkedSampler.midiValue; // Linked sampler controls velocity
                    } else {
                        data1 = linkedSampler.midiValue; // Linked sampler controls note
                        data2 = sampledValue; // This sampler controls velocity
                    }
                } else if (sampler.controlTarget === 'note') {
                    // Sampled value controls note number
                    data1 = sampledValue;
                    data2 = 127; // Fixed velocity
                } else {
                    // Sampled value controls velocity (default)
                    data1 = sampler.noteNumber;
                    data2 = sampledValue;
                }
                
                // Send note-off for previous note if enabled and note changed
                if (sampler.sendNoteOff && sampler.lastSentNote !== null && sampler.lastSentNote !== data1) {
                    const noteOffMsg = [0x80 | channel, sampler.lastSentNote, 0];
                    const noteOffMessageName = `Note Off Ch${sampler.channel} Note${sampler.lastSentNote}`;
                    
                    if (sampler.noteOffDelay > 0) {
                        const samplerId = sampler.id; // Capture for closure
                        setTimeout(() => {
                            if (selectedOutput) {
                                transmit(noteOffMsg);
                                console.log(`[MIDI OUT] Sampler ${samplerId}: ${noteOffMessageName} (delayed ${sampler.noteOffDelay}ms)`);
                                logMidi(samplerId, noteOffMessageName + ` (delayed ${sampler.noteOffDelay}ms)`, 0);
                            }
                        }, sampler.noteOffDelay);
                    } else {
                        transmit(noteOffMsg);
                        console.log(`[MIDI OUT] Sampler ${sampler.id}: ${noteOffMessageName}`);
                        logMidi(sampler.id, noteOffMessageName, 0);
                    }
                }
                
                // Send note-on
                transmit([statusByte, data1, data2]);
                sampler.lastSentNote = data1; // Track this note for future note-off
                messageName = `Note On Ch${sampler.channel} Note${data1} Vel${data2}`;
                if (linkedSampler) {
                    console.log(`[MIDI OUT] Sampler ${sampler.id} (linked with ${linkedSampler.id}): ${messageName}`);
                } else {
                    console.log(`[MIDI OUT] Sampler ${sampler.id}: ${messageName} (RGB: ${sampler.color.r},${sampler.color.g},${sampler.color.b})`);
                }
            } else if (sampler.type === 'cc') {
                statusByte = 0xB0 | channel;
                
                // Check if this sampler is linked to another
                const linkedSampler = sampler.linkedSamplerId ? samplers.find(s => s.id === sampler.linkedSamplerId) : null;
                
                if (linkedSampler) {
                    // Use linked sampler for the complementary value
                    if (sampler.controlTarget === 'cc') {
                        data1 = sampledValue; // This sampler controls CC number
                        data2 = linkedSampler.midiValue; // Linked sampler controls value
                    } else {
                        data1 = linkedSampler.midiValue; // Linked sampler controls CC number
                        data2 = sampledValue; // This sampler controls value
                    }
                } else if (sampler.controlTarget === 'cc') {
                    // Sampled value controls CC number
                    data1 = sampledValue;
                    data2 = 127; // Fixed value
                } else {
                    // Sampled value controls CC value (default)
                    data1 = sampler.ccNumber;
                    data2 = sampledValue;
                }
                
                transmit([statusByte, data1, data2]);
                messageName = `CC Ch${sampler.channel} CC${data1} Val${data2}`;
                if (linkedSampler) {
                    console.log(`[MIDI OUT] Sampler ${sampler.id} (linked with ${linkedSampler.id}): ${messageName}`);
                } else {
                    console.log(`[MIDI OUT] Sampler ${sampler.id}: ${messageName} (RGB: ${sampler.color.r},${sampler.color.g},${sampler.color.b})`);
                }
            } else if (sampler.type === 'program') {
                statusByte = 0xC0 | channel;
                data1 = sampledValue;
                transmit([statusByte, data1]);
                messageName = `Prog Ch${sampler.channel} Prog${data1}`;
                console.log(`[MIDI OUT] Sampler ${sampler.id}: ${messageName} (RGB: ${sampler.color.r},${sampler.color.g},${sampler.color.b})`);
            }

            logMidi(sampler.id, messageName, sampledValue);
        } catch (err) {
            console.error('MIDI send error:', err);
        }
    }

    function setupMIDIInputLogging() {
        if (!midiAccess) return;
        
        for (const input of midiAccess.inputs.values()) {
            input.onmidimessage = onMIDIMessage;
            console.log('Listening to MIDI input:', input.name);
        }
    }

    function onMIDIMessage(message) {
        const command = message.data[0];
        const data1 = message.data[1];
        const data2 = message.data[2];
        
        const channel = (command & 0x0F) + 1;
        const statusByte = command & 0xF0;
        
        switch (statusByte) {
            case 0x90: // note on
                if (data2 > 0) {
                    console.log(`[MIDI IN] Note On: Ch${channel}, Note=${data1}, Velocity=${data2}`);
                } else {
                    console.log(`[MIDI IN] Note Off: Ch${channel}, Note=${data1}`);
                }
                break;
            case 0x80: // note off
                console.log(`[MIDI IN] Note Off: Ch${channel}, Note=${data1}, Velocity=${data2}`);
                break;
            case 0xB0: // control change
                console.log(`[MIDI IN] Control Change: Ch${channel}, CC=${data1}, Value=${data2}`);
                break;
            case 0xC0: // program change
                console.log(`[MIDI IN] Program Change: Ch${channel}, Program=${data1}`);
                break;
            case 0xE0: // pitch bend
                const pitchValue = (data2 << 7) | data1;
                console.log(`[MIDI IN] Pitch Bend: Ch${channel}, Value=${pitchValue}`);
                break;
            default:
                console.log(`[MIDI IN] Unknown: Status=0x${statusByte.toString(16)}, Data1=${data1}, Data2=${data2}`);
        }
    }

    function updateMidiOutputs() {
        const select = document.getElementById('midi-output-select');
        select.innerHTML = '<option value="">Select MIDI Output...</option>';
        
        if (midiAccess) {
            for (const output of midiAccess.outputs.values()) {
                const option = document.createElement('option');
                option.value = output.id;
                option.textContent = output.name;
                select.appendChild(option);
            }
        }
    }

    // --- Preact sampler list (declarative; replaces the innerHTML rebuild) ---

    function updateSamplerProp(s, prop, e) {
        const target = e.target;
        if (prop === 'linkedSamplerId') {
            s.linkedSamplerId = target.value ? parseInt(target.value) : null;
        } else if (prop === 'quantizeToScale' || prop === 'sendOnChangeOnly' || prop === 'sendNoteOff') {
            s[prop] = target.checked;
        } else if (prop === 'octaveMin' || prop === 'octaveMax') {
            s[prop] = parseInt(target.value);
            applyOctaveRange(s);
        } else if (prop === 'scaleRootNote') {
            s.scaleRootNote = target.value;
            s.scaleRoot = midiNoteFromName(s.scaleRootNote, s.scaleRootOctave);
        } else if (prop === 'scaleRootOctave') {
            s.scaleRootOctave = parseInt(target.value);
            s.scaleRoot = midiNoteFromName(s.scaleRootNote, s.scaleRootOctave);
        } else if (prop === 'pollingInterval') {
            s.pollingInterval = parseInt(target.value);
            s.hasCustomPollingInterval = true; // Mark as custom
        } else {
            s[prop] = target.type === 'number' ? parseInt(target.value) : target.value;
        }
        if (prop === 'name') {
            drawSamplers(); // refresh the canvas label
        }
        updateSamplersList(); // cheap: Preact diffs the DOM and keeps focus
    }

    function deleteSampler(id) {
        samplers = samplers.filter(s => s.id !== id);
        updateSamplersList();
        drawSamplers();
    }

    function Field({ label, title, children }) {
        return html`
            <label class="midi-field" title=${title}>
                <span class="midi-field-label">${label}</span>
                ${children}
            </label>
        `;
    }

    function SamplerItem({ s }) {
        const linkedFrom = samplers.filter(other => other.linkedSamplerId === s.id);
        const linkChoices = samplers.filter(other => other.id !== s.id && other.type === s.type && other.channel === s.channel);
        const showScale = s.controlTarget === 'note' || s.controlTarget === 'both' || s.type === 'program';
        const set = prop => e => updateSamplerProp(s, prop, e);

        return html`
            <div class="midi-sampler-item">
                <div class="midi-sampler-header">
                    <input type="text" class="midi-sampler-name" name="sampler-${s.id}-name" value=${s.name || 'Sampler ' + s.id} onChange=${set('name')} title="Click to rename this sampler" />
                    ${linkedFrom.length > 0 && html`<span class="midi-link-badge" title=${'Linked from: ' + linkedFrom.map(l => 'S' + l.id).join(', ')}>← ${linkedFrom.map(l => 'S' + l.id).join(', ')}</span>`}
                    ${s.linkedSamplerId !== null && html`<span class="midi-link-badge midi-link-badge-out" title=${'Linked to Sampler ' + s.linkedSamplerId}>→ S${s.linkedSamplerId}</span>`}
                    <button class="midi-delete-btn" onClick=${() => deleteSampler(s.id)}>×</button>
                </div>
                <div class="midi-sampler-controls">
                    <${Field} label="Type" title="MIDI message type">
                        <select name="sampler-${s.id}-type" value=${s.type} onChange=${set('type')}>
                            <option value="note">Note</option>
                            <option value="cc">CC</option>
                            <option value="program">Program</option>
                        </select>
                    <//>
                    <${Field} label="Target" title="What does the sampled value control?">
                        <select name="sampler-${s.id}-controlTarget" value=${s.controlTarget} onChange=${set('controlTarget')}>
                            ${s.type === 'note' && html`
                                <option value="velocity">→Velocity</option>
                                <option value="note">→Note</option>
                                <option value="both">→Note+Vel</option>
                            `}
                            ${s.type === 'cc' && html`
                                <option value="value">→Value</option>
                                <option value="cc">→CC#</option>
                            `}
                        </select>
                    <//>
                    <${Field} label="Link" title="Link to another sampler">
                        <select name="sampler-${s.id}-linkedSamplerId" value=${s.linkedSamplerId || ''} onChange=${set('linkedSamplerId')}>
                            <option value="">No Link</option>
                            ${linkChoices.map(other => html`<option key=${other.id} value=${other.id}>Link→S${other.id}</option>`)}
                        </select>
                    <//>
                    <${Field} label="Δ Only" title="Only send MIDI when value changes">
                        <input type="checkbox" name="sampler-${s.id}-sendOnChangeOnly" checked=${s.sendOnChangeOnly} onChange=${set('sendOnChangeOnly')} />
                    <//>
                    <${Field} label="Channel" title="MIDI channel (1-16)">
                        <input type="number" name="sampler-${s.id}-channel" min="1" max="16" value=${s.channel} onChange=${set('channel')} />
                    <//>
                    ${s.type === 'note' && html`
                        <${Field} label="Note" title="Note number (0-127)">
                            <input type="number" name="sampler-${s.id}-noteNumber" min="0" max="127" value=${s.noteNumber} onChange=${set('noteNumber')} />
                        <//>
                    `}
                    ${s.type === 'cc' && html`
                        <${Field} label="CC#" title="CC number (0-127)">
                            <input type="number" name="sampler-${s.id}-ccNumber" min="0" max="127" value=${s.ccNumber} onChange=${set('ccNumber')} />
                        <//>
                    `}
                    <${Field} label="Rate (ms)" title="Polling interval (ms)">
                        <input type="number" name="sampler-${s.id}-pollingInterval" min="10" max="5000" step="10" value=${s.pollingInterval} onChange=${set('pollingInterval')} style="width: 70px;" />
                    <//>
                    <div class="midi-field" title="Time until next sample">
                        <span class="midi-field-label">Next</span>
                        <span class="midi-timer" data-timer-id=${s.id}>${s.displayTimeRemaining !== undefined ? s.displayTimeRemaining + 'ms' : '—'}</span>
                    </div>
                    <div class="midi-field" title="Current color">
                        <span class="midi-field-label">Color</span>
                        <div class="midi-color-preview" data-color-id=${s.id} style="background: rgb(${s.color.r}, ${s.color.g}, ${s.color.b})"></div>
                    </div>
                    <div class="midi-field" title="MIDI value">
                        <span class="midi-field-label">Value</span>
                        <span class="midi-value" data-value-id=${s.id}>${s.midiValue}</span>
                    </div>
                </div>
                ${showScale && html`
                <div class="midi-scale-controls">
                    <label style="display: flex; align-items: center; gap: 5px; margin-bottom: 5px;">
                        <input type="checkbox" checked=${s.quantizeToScale} onChange=${set('quantizeToScale')} />
                        <span style="font-size: 11px;">Quantize to Scale</span>
                    </label>
                    ${s.quantizeToScale && html`
                    <div style="display: flex; gap: 5px; flex-wrap: wrap; margin-top: 5px; align-items: flex-end;">
                        <label class="midi-field" title="Scale/Mode" style="flex: 1; min-width: 100px;">
                            <span class="midi-field-label">Scale</span>
                            <select name="sampler-${s.id}-scaleType" value=${s.scaleType} onChange=${set('scaleType')} style="width: 100%;">
                                <option value="major">Major</option>
                                <option value="minor">Minor</option>
                                <option value="dorian">Dorian</option>
                                <option value="phrygian">Phrygian</option>
                                <option value="lydian">Lydian</option>
                                <option value="mixolydian">Mixolydian</option>
                                <option value="locrian">Locrian</option>
                                <option value="harmonic-minor">Harmonic Minor</option>
                                <option value="melodic-minor">Melodic Minor</option>
                                <option value="pentatonic-major">Pentatonic Major</option>
                                <option value="pentatonic-minor">Pentatonic Minor</option>
                                <option value="blues">Blues</option>
                                <option value="whole-tone">Whole Tone</option>
                                <option value="chromatic">Chromatic</option>
                            </select>
                        </label>
                        <${Field} label="Root" title="Root note">
                            <select name="sampler-${s.id}-scaleRootNote" value=${s.scaleRootNote} onChange=${set('scaleRootNote')} style="width: 55px;">
                                ${noteNames.map(note => html`<option key=${note} value=${note}>${note}</option>`)}
                            </select>
                        <//>
                        <${Field} label="Octave" title="Root octave">
                            <select name="sampler-${s.id}-scaleRootOctave" value=${s.scaleRootOctave} onChange=${set('scaleRootOctave')} style="width: 50px;">
                                ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(oct => html`<option key=${oct} value=${oct}>${oct}</option>`)}
                            </select>
                        <//>
                        <${Field} label="Min Oct" title="Lowest octave for quantized notes">
                            <select name="sampler-${s.id}-octaveMin" value=${s.octaveMin !== undefined ? s.octaveMin : -1} onChange=${set('octaveMin')} style="width: 55px;">
                                ${octaveChoices.map(oct => html`<option key=${oct} value=${oct}>C${oct}</option>`)}
                            </select>
                        <//>
                        <${Field} label="Max Oct" title="Highest octave for quantized notes">
                            <select name="sampler-${s.id}-octaveMax" value=${s.octaveMax !== undefined ? s.octaveMax : 9} onChange=${set('octaveMax')} style="width: 55px;">
                                ${octaveChoices.map(oct => html`<option key=${oct} value=${oct}>B${oct}</option>`)}
                            </select>
                        <//>
                    </div>
                    `}
                </div>
                `}
                ${s.type === 'note' && html`
                <div class="midi-scale-controls" style="margin-top: 8px;">
                    <label style="display: flex; align-items: center; gap: 5px; margin-bottom: 5px;">
                        <input type="checkbox" checked=${s.sendNoteOff} onChange=${set('sendNoteOff')} />
                        <span style="font-size: 11px;">Send Note Off</span>
                    </label>
                    ${s.sendNoteOff && html`
                    <div style="display: flex; gap: 5px; align-items: flex-end; margin-top: 5px;">
                        <${Field} label="Note-Off Delay (ms)" title="Delay before note-off (ms)">
                            <input type="number" name="sampler-${s.id}-noteOffDelay" min="0" max="5000" step="10" value=${s.noteOffDelay} onChange=${set('noteOffDelay')} style="width: 70px;" />
                        <//>
                    </div>
                    `}
                </div>
                `}
            </div>
        `;
    }

    function updateSamplersList() {
        const list = document.getElementById('midi-samplers-list');
        if (!list) return;
        render(html`${samplers.map(s => html`<${SamplerItem} key=${s.id} s=${s} />`)}`, list);
    }

    // --- end Preact sampler list ---

    function updateStatus(msg) {
        const statusEl = document.getElementById('midi-status');
        if (statusEl) {
            statusEl.textContent = msg;
        }
    }

    function savePreset() {
        const presetName = prompt('Enter preset name:');
        if (!presetName) return;
        
        const preset = {
            samplers: samplers.map(s => ({...s, lastSampleTime: 0, displayTimeRemaining: 0, lastSentValue: null, lastSentNote: null})),
            globalPollingInterval,
            globalDeltaThreshold,
            globalSendOnChangeOnly,
            globalMidiChannel
        };
        
        presets[presetName] = preset;
        localStorage.setItem('midiSamplerPresets', JSON.stringify(presets));
        updatePresetList();
        updateStatus(`Preset "${presetName}" saved`);
    }

    function loadPreset(e) {
        const presetName = e.target.value;
        if (!presetName || !presets[presetName]) return;
        
        const preset = presets[presetName];
        samplers = preset.samplers.map(s => ({...s, lastSampleTime: 0, displayTimeRemaining: 0, lastSentValue: null, lastSentNote: null}));
        nextSamplerId = Math.max(...samplers.map(s => s.id), 0) + 1;
        
        globalPollingInterval = preset.globalPollingInterval || 50;
        globalDeltaThreshold = preset.globalDeltaThreshold || 1;
        globalSendOnChangeOnly = preset.globalSendOnChangeOnly || false;
        globalMidiChannel = preset.globalMidiChannel || 1;
        
        document.getElementById('global-polling-interval').value = globalPollingInterval;
        document.getElementById('global-delta-threshold').value = globalDeltaThreshold;
        document.getElementById('global-send-on-change').checked = globalSendOnChangeOnly;
        document.getElementById('global-midi-channel').value = globalMidiChannel;
        
        updateSamplersList();
        drawSamplers();
        updateStatus(`Preset "${presetName}" loaded`);
    }

    function deletePreset() {
        const presetName = document.getElementById('preset-select').value;
        if (!presetName || !presets[presetName]) {
            updateStatus('Select a preset to delete');
            return;
        }
        
        if (confirm(`Delete preset "${presetName}"?`)) {
            delete presets[presetName];
            localStorage.setItem('midiSamplerPresets', JSON.stringify(presets));
            updatePresetList();
            updateStatus(`Preset "${presetName}" deleted`);
        }
    }

    function loadPresetsFromStorage() {
        try {
            const stored = localStorage.getItem('midiSamplerPresets');
            if (stored) {
                presets = JSON.parse(stored);
                updatePresetList();
            }
        } catch (e) {
            console.error('Error loading presets:', e);
        }
    }

    function updatePresetList() {
        const select = document.getElementById('preset-select');
        select.innerHTML = '<option value="">Select Preset...</option>';
        Object.keys(presets).forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
