// ==UserScript==
// @name         Seed Talent Auto-Advancer & OpenRouter Solver
// @namespace    http://tampermonkey.net/
// @version       9.41
// @description  Added network sniffer (SNIFF/DUMP) + hardened SCORM nuke: correct progress_measure, full frame-tree API walk, and cmi.objectives.N completion for per-section status. Detects unsupported adapters and auto-pauses. Terminal-navigation guard: never clicks Exit/Finish and pauses on course-exit/Bye pages. SCORM nuke uses current-frame discovery with retry. Sanitized incident capture on stalls. OpenRouter key stored locally via KEY button. Rise flashcard-grid support and bounded locked scroll. Current Rise process-carousel navigation: intra-block steppers routed to the interactive handler with single-fire clicks so no step is skipped. Quiz resilience: AI-solve failures now release the question for bounded retry (max 3) instead of stranding it in `attempted`; missing key pauses with a recoverable RESUME path. Passed-quiz results screens report completion and pause. SCORM-verified retries: cmi.interactions correct_responses are reused as ground-truth answers before asking the AI. Single/multi-select classification now reads real input types so single-choice can never multi-check.
// @match        *://*.seedtalent.com/*
// @match        *://*.coassemble.com/*
// @match        *://d1b20t6ufgwz51.cloudfront.net/*
// @match        *://*.articulate.com/*
// @run-at       document-start
// @allFrames    true
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
    'use strict';

    const OPENROUTER_KEY_STORAGE = 'seed_openrouter_key';

    function getOpenRouterApiKey() {
        return String(GM_getValue(OPENROUTER_KEY_STORAGE, '') || '').trim();
    }
    const AUTO_SUBMIT_QUIZ = true;
    const MODELS = [
        { id: "nvidia/nemotron-3-super-120b-a12b:free", maxTok: 800 },
        { id: "nvidia/nemotron-3-ultra-550b-a55b:free", maxTok: 800 },
        { id: "openrouter/free",                        maxTok: 800 },
    ];

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // At document-start, <body> may not exist yet — defer DOM work until it does.
    function whenBodyReady(fn) {
        if (document.body) return fn();
        const t = setInterval(() => { if (document.body) { clearInterval(t); fn(); } }, 50);
    }

    // SCORM 2004 + 1.2 completion payload, injected into page context.
    // v9 fixes: progress_measure is 0..1 in SCORM 2004 (old "100" was rejected by
    // the data model), the API lookup walks the whole frame tree instead of just
    // window/parent/top, and every declared objective (cmi.objectives.N) is marked
    // complete — objectives are what per-section/lesson status usually reads from.
    const SCORM_COMPLETE_PAYLOAD = `(function () {
        try {
            function findApi(root) {
                const seen = new Set(), stack = [root];
                while (stack.length) {
                    const w = stack.pop();
                    if (!w || seen.has(w)) continue;
                    seen.add(w);
                    try {
                        if (w.API_1484_11 || w.API) return w;
                        if (w.parent && w.parent !== w) stack.push(w.parent);
                        for (let i = 0; i < w.frames.length; i++) stack.push(w.frames[i]);
                    } catch(e) {}
                }
                return null;
            }
            function applyCompletion() {
                const w = findApi(window);
                if (!w) return false;
                let applied = false;

                const api2004 = w.API_1484_11;
                if (api2004 && typeof api2004.SetValue === 'function') {
                    api2004.SetValue("cmi.completion_status", "completed");
                    api2004.SetValue("cmi.success_status", "passed");
                    api2004.SetValue("cmi.progress_measure", "1");
                    api2004.SetValue("cmi.score.scaled", "1");
                    api2004.SetValue("cmi.score.raw", "100");
                    api2004.SetValue("cmi.score.min", "0");
                    api2004.SetValue("cmi.score.max", "100");
                    try {
                        const n = parseInt(api2004.GetValue("cmi.objectives._count"), 10) || 0;
                        for (let i = 0; i < n; i++) {
                            api2004.SetValue("cmi.objectives." + i + ".completion_status", "completed");
                            api2004.SetValue("cmi.objectives." + i + ".success_status", "passed");
                            api2004.SetValue("cmi.objectives." + i + ".score.scaled", "1");
                        }
                    } catch(e) {}
                    api2004.SetValue("cmi.exit", "normal");
                    api2004.Commit("");
                    applied = true;
                }

                const api12 = w.API;
                if (api12 && typeof api12.LMSSetValue === 'function') {
                    api12.LMSSetValue("cmi.core.lesson_status", "completed");
                    api12.LMSSetValue("cmi.core.score.raw", "100");
                    api12.LMSSetValue("cmi.core.score.min", "0");
                    api12.LMSSetValue("cmi.core.score.max", "100");
                    api12.LMSCommit("");
                    applied = true;
                }
                return applied;
            }

            let attempts = 0;
            (function retryUntilReady() {
                if (applyCompletion()) return;
                attempts++;
                if (attempts < 40) setTimeout(retryUntilReady, 250);
            })();
        } catch(e) {}
    })();`;

    // =========================================================
    // 1. PANEL — top window only
    //    States: STOPPED (default) → RUNNING → PAUSED → RUNNING
    //                                         └→ STOPPED (stop btn)
    // =========================================================
    // 'stopped' | 'running' | 'paused'
    let state = 'stopped';
    // Sniffer state lives here (section 13 uses it) so it initializes before the panel can.
    let sniffOn = GM_getValue('seed_sniff', false);
    const sniffEntries = [];
    // Bounded per-frame runtime error log for sanitized incident reports.
    const runtimeErrors = [];
    const idleIncidents = new Set();

    function pushBounded(list, item, max = 40) {
        list.push(item);
        if (list.length > max) list.splice(0, list.length - max);
    }

    // ── Cross-frame persisted journal + diag keys ────────────────
    // Each frame owns one GM key (origin+pathname) holding its own entries —
    // no read-modify-write races between frames. Merged at DUMP/DIAG time.
    const frameKey = (location.origin + location.pathname).slice(0, 120);
    const journalKey = 'seed_journal::' + frameKey;
    const diagKey    = 'seed_diag::' + frameKey;
    const frameJournal = (() => {
        try { const a = JSON.parse(GM_getValue(journalKey, '[]')); return Array.isArray(a) ? a.slice(-150) : []; }
        catch(e) { return []; }
    })();
    let lastDiagWrite = 0;

    // Expire journal/diag keys whose newest entry is >7d old, once per load.
    try {
        for (const k of GM_listValues()) {
            if (!/^seed_(journal|diag)::/.test(k)) continue;
            try {
                const v = JSON.parse(GM_getValue(k, 'null'));
                const last = Array.isArray(v) ? v[v.length - 1] : v;
                const at = last && Date.parse(last.at || '');
                if (!at || (Date.now() - at) > 7 * 24 * 3600 * 1000) GM_deleteValue(k);
            } catch(e) { try { GM_deleteValue(k); } catch(_) {} }
        }
    } catch(e) {}

    if (window === window.top) whenBodyReady(() => {
        const wrap = document.createElement('div');
        let courseTextAccumulator = new Set();
        let latestIncident = null;
        const dbgLines = [];   // rolling last-N debug lines for the panel
        wrap.innerHTML = `
        <div id="seed-panel" style="position:fixed;bottom:20px;right:20px;z-index:999999;
             background:#1e1e2e;color:#cdd6f4;padding:14px 18px;border-radius:12px;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
             box-shadow:0 4px 20px rgba(0,0,0,0.5);border:1px solid #45475a;width:320px;
             max-height:80vh;overflow-y:auto;">

          <div id="seed-panel-header" style="font-weight:bold;margin-bottom:10px;font-size:14px;color:#89b4fa;
               display:flex;align-items:center;justify-content:space-between;cursor:grab;user-select:none;">
            <span>🤖 Seed Helper v9.41</span>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
                <button id="st-nuke" style="background:#313244;color:#f38ba8;border:1px solid #f38ba8;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;" title="Instantly complete the entire course">🚀 NUKE</button>
                <button id="st-summary" style="background:#313244;color:#f9e2af;border:1px solid #f9e2af;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;">📝 SUMMARY</button>
                <button id="st-key" style="background:#313244;color:#cba6f7;border:1px solid #cba6f7;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;" title="Set or remove the local OpenRouter API key">KEY</button>
                <button id="st-logs" style="background:#313244;color:#a6e3a1;border:1px solid #a6e3a1;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;">📊 LOGS</button>
                <button id="st-sniff" style="background:#313244;color:#89dceb;border:1px solid #89dceb;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;" title="Record network traffic (find the completion API)">📡 SNIFF</button>
                <button id="st-dump" style="background:#313244;color:#94e2d5;border:1px solid #94e2d5;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;" title="Download captured requests as JSON">⬇ DUMP</button>
                <button id="st-diag" style="background:#313244;color:#f5c2e7;border:1px solid #f5c2e7;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;" title="Download cross-frame state snapshot + action journal (no sniff needed)">⬇ DIAG</button>
                <button id="st-incident" style="display:none;background:#313244;color:#fab387;border:1px solid #fab387;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:bold;cursor:pointer;" title="Download the latest sanitized stall report">⬇ INCIDENT</button>
                <span id="st-dot" style="height:10px;width:10px;background:#f38ba8;border-radius:50%;display:inline-block;" title="Stopped"></span>
            </div>
          </div>

          <!-- Button row — changes based on state -->
          <div id="st-btn-row" style="display:flex;gap:8px;margin-bottom:10px;">
            <!-- START state: one big green button -->
            <button id="st-start" style="
                flex:1;padding:8px 0;background:#40a02b;border:none;border-radius:8px;
                color:#fff;font-size:13px;font-weight:bold;cursor:pointer;">
              ▶ START
            </button>
            <!-- RUNNING state: pause + stop -->
            <button id="st-pause" style="
                flex:1;padding:8px 0;background:#313244;border:1px solid #585b70;border-radius:8px;
                color:#cdd6f4;font-size:12px;font-weight:bold;cursor:pointer;display:none;">
              ⏸ PAUSE
            </button>
            <button id="st-stop" style="
                flex:1;padding:8px 0;background:#313244;border:1px solid #585b70;border-radius:8px;
                color:#f38ba8;font-size:12px;font-weight:bold;cursor:pointer;display:none;">
              ⏹ STOP
            </button>
            <!-- PAUSED state: resume + stop -->
            <button id="st-resume" style="
                flex:1;padding:8px 0;background:#313244;border:1px solid #585b70;border-radius:8px;
                color:#a6e3a1;font-size:12px;font-weight:bold;cursor:pointer;display:none;">
              ▶ RESUME
            </button>
            <button id="st-stop2" style="
                flex:1;padding:8px 0;background:#313244;border:1px solid #585b70;border-radius:8px;
                color:#f38ba8;font-size:12px;font-weight:bold;cursor:pointer;display:none;">
              ⏹ STOP
            </button>
          </div>

          <div id="st-status" style="font-size:13px;color:#bac2de;line-height:1.4;">Stopped. Navigate to your course then click START.</div>
          <div id="st-debug"  style="font-size:11px;color:#9399b2;margin-top:8px;word-break:break-word;max-height:60px;overflow-y:auto;white-space:pre-line;"></div>

          <div id="st-matches" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid #45475a;">
            <div style="font-size:11px;font-weight:bold;color:#f9e2af;margin-bottom:6px;">💡 MATCHING ANSWERS:</div>
            <pre id="st-matches-text" style="font-size:11px;color:#a6e3a1;font-family:monospace;white-space:pre-wrap;margin:0;line-height:1.6;"></pre>
          </div>
        </div>`;
        document.body.appendChild(wrap);

        const dot     = document.getElementById('st-dot');
        const startBtn  = document.getElementById('st-start');
        const pauseBtn  = document.getElementById('st-pause');
        const stopBtn   = document.getElementById('st-stop');
        const resumeBtn = document.getElementById('st-resume');
        const stop2Btn  = document.getElementById('st-stop2');
        const incidentBtn = document.getElementById('st-incident');

        function applyState(newState) {
            state = newState;
            // Reset all buttons hidden
            [startBtn, pauseBtn, stopBtn, resumeBtn, stop2Btn].forEach(b => b.style.display = 'none');

            if (state === 'stopped') {
                startBtn.style.display = 'flex';
                dot.style.background = '#f38ba8';
                dot.title = 'Stopped';
                updateStatus('Stopped. Navigate to your course then click START.', '#bac2de');
            } else if (state === 'running') {
                pauseBtn.style.display = 'flex';
                stopBtn.style.display = 'flex';
                dot.style.background = '#a6e3a1';
                dot.title = 'Running';
            } else if (state === 'paused') {
                resumeBtn.style.display = 'flex';
                stop2Btn.style.display = 'flex';
                dot.style.background = '#f9e2af';
                dot.title = 'Paused';
                updateStatus('Paused. Click RESUME to continue.', '#f9e2af');
            }
            broadcastState();
        }

        startBtn.addEventListener('click',  () => { try { GM_setValue('seed_runid', String(Date.now())); } catch(e) {} applyState('running'); updateStatus('Running...', '#a6e3a1'); });
        pauseBtn.addEventListener('click',  () => applyState('paused'));
        resumeBtn.addEventListener('click', () => { applyState('running'); updateStatus('Resumed.', '#a6e3a1'); });
        stopBtn.addEventListener('click',   () => { applyState('stopped'); broadcastReset(); });
        stop2Btn.addEventListener('click',  () => { applyState('stopped'); broadcastReset(); });

        // Draggable panel logic
        const panel = document.getElementById('seed-panel');
        const header = document.getElementById('seed-panel-header');
        let isDragging = false, startX, startY, initialX, initialY;
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            header.style.cursor = 'grabbing';
            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            initialX = rect.left;
            initialY = rect.top;

            // Switch from bottom/right to left/top to avoid resize jumping
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.style.left = initialX + 'px';
            panel.style.top = initialY + 'px';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.left = (initialX + dx) + 'px';
            panel.style.top = (initialY + dy) + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'grab';
            }
        });

        document.getElementById('st-key').addEventListener('click', () => {
            const input = prompt('Enter your replacement OpenRouter API key. Leave blank to remove the saved key.', '');
            if (input === null) return;
            const value = input.trim();
            if (!value) {
                GM_setValue(OPENROUTER_KEY_STORAGE, '');
                updateStatus('OpenRouter key removed.', '#f38ba8');
            } else {
                GM_setValue(OPENROUTER_KEY_STORAGE, value);
                updateStatus('OpenRouter key saved locally.', '#a6e3a1');
            }
        });

        document.getElementById('st-summary').addEventListener('click', () => {
            const fullText = Array.from(courseTextAccumulator).join('\\n\\n');
            if (fullText.length < 200) {
                alert('Not enough course text collected yet. Let the script run through a few lessons first.');
                return;
            }

            updateStatus('Generating summary...', '#f9e2af');
            const sys = 'You are an expert summarizer. Provide a detailed, well-structured summary of the following course content. Include key takeaways, main concepts, and important facts. Format your output in clean Markdown. Start directly with the summary.';
            const user = 'Here is the scraped text from the course:\\n\\n' + fullText.substring(0, 40000);

            const apiKey = getOpenRouterApiKey();
            if (!apiKey) { updateStatus('Set an OpenRouter key with KEY first.', '#f38ba8'); return; }
            fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ model: MODELS[0].id, messages: [{role:"system",content:sys}, {role:"user",content:user}], max_tokens: 1500, temperature: 0.2 })
            }).then(r => r.json()).then(data => {
                updateStatus('Summary ready!', '#a6e3a1');
                const aiText = data.choices && data.choices[0] && data.choices[0].message.content ? data.choices[0].message.content.trim() : "Failed to generate summary.";

                const htmlText = aiText
                    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
                    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                    .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
                    .replace(/\\*(.*?)\\*/g, '<em>$1</em>')
                    .replace(/^\\- (.*$)/gim, '<ul><li>$1</li></ul>')
                    .replace(/<\/ul>\\n<ul>/g, '')
                    .replace(/\\n/g, '<br/>');

                const win = window.open('', 'SeedSummaryWindow', 'width=800,height=800');
                if (win) {
                    win.document.write(`<html><head><title>Course Summary</title>
                    <style>
                        body { font-family: sans-serif; line-height: 1.6; padding: 30px; max-width: 800px; margin: auto; background: #1e1e2e; color: #cdd6f4; }
                        h1, h2, h3 { color: #89b4fa; }
                        strong { color: #a6e3a1; }
                    </style>
                    </head><body>
                    <h1>Course Summary</h1>
                    <div>${htmlText}</div>
                    </body></html>`);
                    win.document.close();
                }
            }).catch(e => {
                updateStatus('Summary failed.', '#f38ba8');
            });
        });

        document.getElementById('st-logs').addEventListener('click', () => {
            if (!logsWindow || logsWindow.closed) {
                logsWindow = window.open('', 'SeedLogsWindow');
                if (logsWindow) {
                    logsWindow.document.write(renderStatsHTML());
                    logsWindow.document.close();
                }
            } else {
                logsWindow.focus();
                logsWindow.historyData = loadHistory();
                logsWindow.document.getElementById('logs-body').innerHTML = renderStatsBody(logsWindow.historyData);
            }
        });
        document.getElementById('st-nuke').addEventListener('click', () => {
            if (confirm('WARNING: This will instantly mark the entire course (including quizzes) as 100% complete and passed in the database. Are you sure?')) {
                window.postMessage({ type: 'SEED_NUKE' }, '*');
                const iframes = document.querySelectorAll('iframe');
                for (const frame of iframes) {
                    try {
                        frame.contentWindow.postMessage({ type: 'SEED_NUKE' }, '*');
                    } catch(e) {}
                }
                alert('Nuke payload delivered! The course is marked 100% complete. Please refresh the page or return to the dashboard.');
            }
        });

        // ── Sniffer controls (section 13 does the actual capture) ──
        const sniffBtn = document.getElementById('st-sniff');
        const dumpBtn  = document.getElementById('st-dump');
        if (sniffOn) { sniffBtn.style.background = '#89dceb'; sniffBtn.style.color = '#1e1e2e'; }
        sniffBtn.addEventListener('click', () => {
            sniffOn = !sniffOn;
            GM_setValue('seed_sniff', sniffOn);
            sniffBtn.style.background = sniffOn ? '#89dceb' : '#313244';
            sniffBtn.style.color = sniffOn ? '#1e1e2e' : '#89dceb';
            // Relay to this window's own listener (forwards deeper) + direct iframes
            window.postMessage({ type: 'SEED_SNIFF_SET', on: sniffOn }, '*');
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'SEED_SNIFF_SET', on: sniffOn }, '*'); } catch(e2) {}
            });
            updateStatus(sniffOn ? 'Sniffing network traffic…' : 'Sniffer off.', '#89dceb');
        });
        const downloadJson = (name, obj) => {
            const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            a.click();
        };
        // Ask every frame to snapshot its state into GM, wait briefly, then
        // bundle network events + merged cross-frame journal + per-frame diags.
        const collectAndDownload = (withEvents) => {
            window.postMessage({ type: 'SEED_DIAG_REQ' }, '*');
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'SEED_DIAG_REQ' }, '*'); } catch(e2) {}
            });
            updateStatus('Collecting diagnostics…', '#94e2d5');
            setTimeout(() => {
                const journal = mergedJournal();
                const diags = collectDiags();
                const payload = {
                    meta: { helperVersion: '9.41', runId: GM_getValue('seed_runid', ''), dumpedAt: new Date().toISOString(), events: sniffEntries.length, journalEntries: journal.length, frames: Object.keys(diags).length },
                    events: withEvents ? sniffEntries : undefined,
                    journal,
                    diags
                };
                downloadJson('seed_' + (withEvents ? 'sniff' : 'diag') + '_' + Date.now() + '.json', payload);
                updateStatus((withEvents ? 'Dumped ' + sniffEntries.length + ' requests + ' : 'Diag: ') + journal.length + ' journal entries, ' + Object.keys(diags).length + ' frames.', '#94e2d5');
            }, 700);
        };
        dumpBtn.addEventListener('click', () => collectAndDownload(true));
        document.getElementById('st-diag').addEventListener('click', () => collectAndDownload(false));
        incidentBtn.addEventListener('click', () => {
            if (!latestIncident) return;
            const safeType = String(latestIncident.type || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown';
            downloadJson('seed_incident_' + safeType + '_' + Date.now() + '.json', latestIncident);
        });

        window.addEventListener('message', (e) => {
            if (!e.data) return;
            if (e.data.type === 'SEED_STATUS') {
                const el = document.getElementById('st-status');
                if (el) { el.innerText = e.data.text; if (e.data.color) el.style.color = e.data.color; }
                if (e.data.hideMatches) { const mp = document.getElementById('st-matches'); if (mp) mp.style.display = 'none'; }
            }
            if (e.data.type === 'SEED_DEBUG') {
                const el = document.getElementById('st-debug');
                if (el) {
                    dbgLines.push(String(e.data.text).slice(0, 200));
                    if (dbgLines.length > 5) dbgLines.shift();
                    el.innerText = dbgLines.join('\n');
                }
            }
            if (e.data.type === 'SEED_MATCHES') {
                const mp = document.getElementById('st-matches'), mt = document.getElementById('st-matches-text');
                if (mp && mt) { mt.innerText = e.data.text; mp.style.display = 'block'; }
            }
            if (e.data.type === 'SEED_STATE_QUERY') {
                try { e.source.postMessage({ type: 'SEED_STATE_RESP', state }, '*'); } catch(e2) {}
            }
            if (e.data.type === 'SEED_COURSE_TEXT') {
                const text = e.data.text.trim();
                if (text.length > 50) {
                    const snippet = text.substring(0, 1000);
                    courseTextAccumulator.add(snippet);
                }
            }
            if (e.data.type === 'SEED_UNHANDLED') {
                const allowed = { 'required-response': 1, 'unknown-quiz': 1, 'ordering': 1, 'hotspot': 1, 'simulation': 1, 'external-embed': 1, 'storyline': 1 };
                const d = e.data.detection || {};
                if (!allowed[d.kind]) return;
                storeIncident(e.data.incident, d.kind);
                const label = String(d.label || d.kind).slice(0, 120);
                const ev = d.evidence || {};
                const evText = [ev.frame, ev.tag, ev.text, ev.cls, ev.src]
                    .map(x => String(x || '')).filter(Boolean).join(' | ').slice(0, 200);
                applyState('paused');
                updateStatus(`Paused — ${label} needs an adapter. Capture a screenshot and SNIFF/DUMP.`, '#f38ba8');
                const dbg = document.getElementById('st-debug');
                if (dbg) dbg.innerText = `${d.kind}: ${evText}`;
            }
            if (e.data.type === 'SEED_TERMINAL_PAGE') {
                storeIncident(e.data.incident, 'terminal-page');
                const ev = (e.data.detection && e.data.detection.evidence) || {};
                const evText = [ev.frame, ev.title].map(x => String(x || '')).filter(Boolean).join(' | ').slice(0, 200);
                applyState('paused');
                updateStatus('Paused — course exit/Bye page detected. Reload the course before retrying START.', '#f38ba8');
                const dbg = document.getElementById('st-debug');
                if (dbg) dbg.innerText = `terminal: ${evText}`;
            }
            if (e.data.type === 'SEED_UNKNOWN_IDLE') {
                storeIncident(e.data.incident, 'unknown-idle');
                applyState('paused');
                updateStatus('Paused — no supported action found. Download INCIDENT before using NUKE or leaving the course.', '#f38ba8');
                const dbg = document.getElementById('st-debug');
                const fr = (e.data.incident && e.data.incident.frame) || '';
                if (dbg) dbg.innerText = `unknown-idle: ${String(fr).slice(0, 200)}`;
            }
            if (e.data.type === 'SEED_PAUSE_REQ') {
                applyState('paused');
                updateStatus('Paused — set an OpenRouter key with KEY, then press RESUME.', '#f38ba8');
            }
            if (e.data.type === 'SEED_QUIZ_PASSED') {
                applyState('paused');
                updateStatus(String(e.data.text || '✓ Quiz passed — course done, you can exit.').slice(0, 200), '#a6e3a1');
            }
        });

        // Rebuild a bounded incident object from an untrusted cross-frame payload.
        function storeIncident(raw, fallbackType) {
            try {
                const safe = {
                    helperVersion: String((raw && raw.helperVersion) || '9.33').slice(0, 20),
                    capturedAt: String((raw && raw.capturedAt) || new Date().toISOString()).slice(0, 40),
                    type: String((raw && raw.type) || fallbackType || 'unknown').slice(0, 60),
                    engine: String((raw && raw.engine) || 'Unknown').slice(0, 40),
                    frame: sanitizeIncidentUrl(raw && raw.frame),
                    title: scrubIncidentText(raw && raw.title, 100),
                    detection: {
                        kind: String((raw && raw.detection && raw.detection.kind) || '').slice(0, 60),
                        label: scrubIncidentText(raw && raw.detection && raw.detection.label, 120),
                        evidence: {}
                    },
                    blockerMessages: [],
                    controls: [],
                    lockedNavigation: [],
                    canvases: [],
                    embeds: [],
                    recentActions: [],
                    runtimeErrors: [],
                    recentNetwork: []
                };
                const srcEv = (raw && raw.detection && raw.detection.evidence) || {};
                for (const k of ['frame', 'src']) {
                    if (srcEv[k] != null) safe.detection.evidence[k] = sanitizeIncidentUrl(srcEv[k]);
                }
                for (const k of ['text', 'title']) {
                    if (srcEv[k] != null) safe.detection.evidence[k] = scrubIncidentText(srcEv[k], 200);
                }
                for (const k of ['tag', 'cls']) {
                    if (srcEv[k] != null) safe.detection.evidence[k] = clipStr(srcEv[k], 200);
                }
                safe.blockerMessages = (((raw && raw.blockerMessages) || []))
                    .slice(0, 10).map(x => scrubIncidentText(x, 180));
                const ctrl = o => ({
                    tag: String((o && o.tag) || '').slice(0, 40),
                    type: String((o && o.type) || '').slice(0, 40),
                    role: String((o && o.role) || '').slice(0, 60),
                    label: scrubIncidentText(o && o.label, 100),
                    disabled: !!(o && o.disabled),
                    checked: !!(o && o.checked),
                    cls: String((o && o.cls) || '').slice(0, 120)
                });
                safe.controls = (((raw && raw.controls) || [])).slice(0, 40).map(ctrl);
                safe.lockedNavigation = (((raw && raw.lockedNavigation) || [])).slice(0, 10).map(ctrl);
                safe.canvases = (((raw && raw.canvases) || [])).slice(0, 10).map(c => ({
                    width: Number(c && c.width) || 0,
                    height: Number(c && c.height) || 0,
                    label: scrubIncidentText(c && c.label, 100),
                    cls: String((c && c.cls) || '').slice(0, 120)
                }));
                safe.embeds = (((raw && raw.embeds) || [])).slice(0, 10)
                    .map(f => ({ src: sanitizeIncidentUrl(f && f.src) }));
                safe.recentActions = (((raw && raw.recentActions) || [])).slice(0, 30).map(a => ({
                    at: String((a && a.at) || '').slice(0, 40),
                    kind: String((a && a.kind) || '').slice(0, 20),
                    text: scrubIncidentText(a && a.text, 160)
                }));
                safe.runtimeErrors = (((raw && raw.runtimeErrors) || [])).slice(0, 20).map(er => ({
                    at: String((er && er.at) || '').slice(0, 40),
                    kind: String((er && er.kind) || '').slice(0, 30),
                    message: scrubIncidentText(er && er.message, 200),
                    source: sanitizeIncidentUrl(er && er.source),
                    line: Number(er && er.line) || 0,
                    column: Number(er && er.column) || 0
                }));
                // Top-frame only: attach bounded sniff data — never bodies.
                safe.recentNetwork = sniffEntries.slice(-30).map(en => ({
                    method: String((en && en.method) || '').slice(0, 20),
                    status: Number(en && en.status) || 0,
                    url: sanitizeIncidentUrl(en && en.url),
                    frame: sanitizeIncidentUrl(en && en.frame)
                }));
                latestIncident = safe;
                if (incidentBtn) incidentBtn.style.display = 'inline-block';
            } catch (e) {}
        }

        function updateStatus(t, c) {
            const el = document.getElementById('st-status');
            if (el) { el.innerText = t; if (c) el.style.color = c; }
        }
        function broadcastState() {
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'SEED_STATE_RESP', state }, '*'); } catch(e2) {}
            });
        }
        function broadcastReset() {
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'SEED_RESET' }, '*'); } catch(e2) {}
            });
        }
    });

    // Global listener for NUKE command (runs in ALL frames)
    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'SEED_NUKE') {
            try {
                const scormScript = document.createElement('script');
                scormScript.textContent = SCORM_COMPLETE_PAYLOAD;
                document.body.appendChild(scormScript);
                setTimeout(() => { try { scormScript.remove(); } catch(e){} }, 500);
            } catch (err) {}
        }
    });

    // =========================================================
    // 2. CROSS-FRAME STATE SYNC (iframes)
    // =========================================================
    let iframeState = 'stopped'; // iframes default stopped until told otherwise

    if (window !== window.top) {
        window.addEventListener('message', (e) => {
            if (!e.data) return;
            if (e.data.type === 'SEED_STATE_RESP') iframeState = e.data.state;
            if (e.data.type === 'SEED_RESET') {
                iframeState = 'stopped';
                resetMemory();
            }
        });
        // Poll parent for state
        setInterval(() => {
            try { window.top.postMessage({ type: 'SEED_STATE_QUERY' }, '*'); } catch(e) {}
        }, 1500);
    }

    function isRunning() {
        return (window === window.top ? state : iframeState) === 'running';
    }

    // =========================================================
    // 3. MESSAGING
    // =========================================================
    // Filtered write-through: high-frequency noise (countdowns, sniff lines,
    // repeated identical lines) stays out of both journals so real actions
    // aren't evicted by chatter.
    const JOURNAL_SKIP = /^(Delay \d|Waiting for AI|\[SNIFF\]|video \d)/;
    function journalPush(kind, t) {
        const text = scrubIncidentText(t, 160);
        if (JOURNAL_SKIP.test(text)) return;
        const last = frameJournal[frameJournal.length - 1];
        if (last && last.text === text && last.kind === kind) return;
        const entry = { at: new Date().toISOString(), kind, text };
        pushBounded(frameJournal, entry, 150);
        try { GM_setValue(journalKey, JSON.stringify(frameJournal)); } catch(e) {}
    }
    function sendStatus(t, c, hm) {
        journalPush('status', t);
        try { window.top.postMessage({ type: 'SEED_STATUS', text: t, color: c, hideMatches: !!hm }, '*'); } catch(e) {}
        try {
            GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8765/log", data: "[STATUS] " + t, headers: { "Content-Type": "text/plain" } });
        } catch(err) {}
    }
    function sendDebug(t) {
        journalPush('debug', t);
        try { window.top.postMessage({ type: 'SEED_DEBUG', text: String(t).slice(0, 200) }, '*'); } catch(e) {}
        console.log('[SH v9.0]', t);
        try {
            GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8765/log", data: "[DEBUG] " + t, headers: { "Content-Type": "text/plain" } });
        } catch(err) {}
    }
    function sendMatches(t) {
        try { window.top.postMessage({ type: 'SEED_MATCHES', text: t }, '*'); } catch(e) {}
    }

    // Per-frame runtime error capture for incident reports.
    // Only timestamp, kind, scrubbed message, sanitized source, line/column —
    // never stacks, Error/event objects, request bodies, or form values.
    window.addEventListener('error', (e) => {
        try {
            pushBounded(runtimeErrors, {
                at: new Date().toISOString(),
                kind: 'error',
                message: scrubIncidentText(e && e.message, 200),
                source: sanitizeIncidentUrl(e && e.filename),
                line: e && e.lineno,
                column: e && e.colno
            });
        } catch (err) {}
    });
    window.addEventListener('unhandledrejection', (e) => {
        try {
            const r = e && e.reason;
            const msg = (r && r.message) ? r.message : (typeof r === 'object' ? 'unhandled rejection' : r);
            pushBounded(runtimeErrors, {
                at: new Date().toISOString(),
                kind: 'unhandledrejection',
                message: scrubIncidentText(msg, 200),
                source: sanitizeIncidentUrl(location.href),
                line: 0,
                column: 0
            });
        } catch (err) {}
    });

    function reportUnhandledAdapter(detection) {
        if (!detection || !detection.signature || unhandledSurfaces.has(detection.signature)) return false;
        unhandledSurfaces.add(detection.signature);
        const incident = buildIncident(detection.kind || 'unhandled', detection);
        try { window.top.postMessage({ type: 'SEED_UNHANDLED', detection, incident }, '*'); } catch(e) {}
        sendDebug(`Unhandled surface: ${detection.kind} @ ${String(detection.signature).slice(0, 120)}`);
        return true;
    }

    function reportTerminalPage(detection) {
        if (!detection || !detection.signature || terminalPages.has(detection.signature)) return false;
        terminalPages.add(detection.signature);
        try { window.top.postMessage({ type: 'SEED_TERMINAL_PAGE', detection, incident: buildIncident('terminal-page', detection) }, '*'); } catch(e) {}
        sendDebug(`Terminal page: ${String(detection.signature).slice(0, 140)}`);
        return true;
    }

    // Nearest ancestor that ACTUALLY scrolls. closest('.page-wrap,.lesson-main')
    // returns .lesson-main — nearer but never scrollable on Rise — so scrollTop
    // writes vanished (the sorting-block pin looped silently; DIAG 1790016189929).
    function scrollContainerFor(el) {
        for (let p = el && el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
            if (p.clientHeight > 0 && p.scrollHeight > p.clientHeight + 40) return p;
        }
        return document.documentElement;
    }

    function reportUnknownIdle() {
        if (!isLikelyCourseContentFrame()) return false;
        const frame = frameOriginPath();
        const title = clipStr(document.title, 80);
        let fp = '';
        try {
            fp = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="radio"], [role="checkbox"]'))
                .filter(isRenderedForIncident).slice(0, 10)
                .map(el => [el.tagName, el.getAttribute('role') || '', (el.getAttribute('class') || '').slice(0, 40)].join(':'))
                .join(';');
        } catch (e) {}
        const signature = clipStr('idle|' + frame + '|' + title + '|' + fp, 200);
        if (idleIncidents.has(signature)) return false;
        idleIncidents.add(signature);
        const incident = buildIncident('unknown-idle', null);
        try { window.top.postMessage({ type: 'SEED_UNKNOWN_IDLE', incident }, '*'); } catch(e) {}
        sendDebug(`Unknown idle: ${signature.slice(0, 140)}`);
        return true;
    }

    function simulateHumanClick(el) {
        if (!el) return;

        // Scroll into view safely without triggering horizontal carousel bugs
        try {
            const r = el.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight) {
                scrollContainerFor(el).scrollTop += (r.top - window.innerHeight / 2);
            }
        } catch (e) {}

        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        // Pre-events only — deliberately NO dispatched 'click': an untrusted
        // click event on a checkbox/radio IS an activation and toggles it, so
        // dispatching click AND calling .click() toggled controls twice
        // (select → deselect; DIAG 1790000963923). Radios masked the bug
        // (re-clicking a checked radio is a no-op); checkboxes flipped back.
        // pointerdown/mousedown stay — Radix-style triggers open on those.
        const events = [
            new PointerEvent('pointerover', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
            new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }),
            new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }),
            new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: 0 }),
            new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0 })
        ];

        for (const ev of events) {
            el.dispatchEvent(ev);
        }

        try {
            // Exactly ONE activation. For a wrapper holding a real control,
            // click the control itself — clicking the wrapper inside a <label>
            // would forward a second click to the input (double-toggle again).
            // el.click() reaches React's root-delegated listeners natively, so
            // no manual __reactProps$ invocation (that fired onClick/onChange a
            // third time with a stale target — same parity corruption).
            const inner = (el.tagName !== 'INPUT' && el.tagName !== 'LABEL')
                ? el.querySelector('input[type="checkbox"], input[type="radio"]')
                : null;
            (inner || el).click();
        } catch (e) {}
    }

    // =========================================================
    // 4. VISIBILITY — horizontal bounds check included
    // =========================================================
    function isVisible(el) {
        if (!el) return false;
        // Reject elements explicitly hidden from assistive tech (e.g. the NEXT btn before answer submitted)
        if (el.getAttribute('aria-hidden') === 'true') return false;
        const r = el.getBoundingClientRect();
        // Zero-size check
        if (r.width === 0 || r.height === 0) return false;
        // Tiny-element check: catches `visually-hidden-always` (1×1px clip trick)
        if (r.width <= 5 && r.height <= 5) return false;
        // Horizontal bounds: ignore elements pushed off-screen by Rise sliders
        const cx = r.left + r.width / 2;
        if (cx < -50 || cx > window.innerWidth + 50) return false;
        // Reject elements inside inert containers (Rise quiz carousel: --next, --done, --penultimate, --future cards)
        if (el.closest('[inert]')) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        if (s.pointerEvents === 'none') return false;
        return true;
    }

    // =========================================================
    // 4b. UNSUPPORTED-ADAPTER DETECTION
    // Pure classifier (fixture-testable) + bounded DOM signal probes.
    // =========================================================
    function classifyUnhandledAdapter(signals) {
        if (signals.requiredResponse) return { kind: 'required-response', label: 'unhandled required-response interaction' };
        if (signals.unknownQuiz) return { kind: 'unknown-quiz', label: 'unknown quiz interaction' };
        if (signals.ordering) return { kind: 'ordering', label: 'ordering/sorting interaction' };
        if (signals.hotspot) return { kind: 'hotspot', label: 'hotspot interaction' };
        if (signals.simulation) return { kind: 'simulation', label: 'simulation/canvas interaction' };
        if (signals.externalEmbed) return { kind: 'external-embed', label: 'cross-origin external embed' };
        if (signals.storyline) return { kind: 'storyline', label: 'unhandled Storyline surface' };
        return null;
    }

    function firstVisible(selector) {
        try {
            const els = document.querySelectorAll(selector);
            for (const el of els) if (isVisible(el)) return el;
        } catch (e) {}
        return null;
    }

    function clipStr(s, n) {
        return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
    }

    function scrubIncidentText(value, max = 200) {
        return clipStr(value, max)
            .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
            .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]')
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
    }

    function sanitizeIncidentUrl(value) {
        const raw = String(value || '');
        if (/^scorm:\/\//i.test(raw)) return raw.split('?')[0].slice(0, 220);
        try {
            const u = new URL(raw, location.href);
            if (!/^https?:$/.test(u.protocol)) return u.protocol + '//[redacted]';
            return (u.origin + u.pathname).slice(0, 220);
        } catch (e) { return ''; }
    }

    function frameOriginPath() {
        return sanitizeIncidentUrl(location.href) || 'unknown';
    }

    function elEvidence(el) {
        return {
            frame: clipStr(frameOriginPath(), 200),
            tag: el && el.tagName ? String(el.tagName).toLowerCase() : '',
            text: clipStr(el ? (el.getAttribute('aria-label') || el.innerText || el.textContent) : '', 80),
            cls: clipStr(el ? (el.getAttribute('class') || '') : '', 120)
        };
    }

    function sanitizeEmbedSrc(src) {
        return sanitizeIncidentUrl(src);
    }

    function isAllowedEmbedHost(hostname) {
        const host = String(hostname || '').toLowerCase();
        return ['seedtalent.com', 'cloudfront.net', 'coassemble.com', 'articulate.com']
            .some(d => host === d || host.endsWith('.' + d));
    }

    // Lighter than isVisible: validation surfaces may legitimately have
    // pointer-events:none while still being rendered on screen.
    function isRenderedForIncident(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        return true;
    }

    function detectCourseEngine() {
        try {
            if (/story(?:_html5)?\.html|storyline|story_content/i.test(location.pathname) ||
                document.querySelector('.slide-object, [data-acc-text], #slide')) return 'Storyline';
            if (document.querySelector('.lesson-main, .page-wrap, [data-block-id], [data-quiz]')) return 'Rise';
        } catch (e) {}
        try {
            if ((location.hostname || '').toLowerCase().endsWith('coassemble.com')) return 'Coassemble';
        } catch (e) {}
        return 'Unknown';
    }

    function isLikelyCourseContentFrame() {
        try {
            const host = (location.hostname || '').toLowerCase();
            const path = (location.pathname || '').toLowerCase();
            if (host.endsWith('coassemble.com') || host.endsWith('articulate.com')) return true;
            if (host.endsWith('cloudfront.net') &&
                (/\/scormcontent\//.test(path) || /story(?:_html5)?\.html|story_content/.test(path))) return true;
            return detectCourseEngine() !== 'Unknown';
        } catch (e) { return false; }
    }

    function controlEvidence(el) {
        return {
            tag: el && el.tagName ? String(el.tagName).toLowerCase() : '',
            type: clipStr(el && el.getAttribute ? el.getAttribute('type') : '', 40),
            role: clipStr(el && el.getAttribute ? el.getAttribute('role') : '', 60),
            label: scrubIncidentText(el ? (el.getAttribute('aria-label') || el.innerText || el.textContent) : '', 100),
            disabled: !!(el && (el.disabled || el.getAttribute('aria-disabled') === 'true')),
            checked: !!(el && el.checked),
            cls: clipStr(el ? (el.getAttribute('class') || '') : '', 120)
        };
    }

    // Explicit-schema sanitized incident payload. Never reads .value, outerHTML,
    // request/response bodies, headers, cookies, or stacks.
    function buildIncident(type, detection) {
        const incident = {
            helperVersion: '9.33',
            capturedAt: new Date().toISOString(),
            type: clipStr(type, 60),
            engine: detectCourseEngine(),
            frame: clipStr(frameOriginPath(), 200),
            title: scrubIncidentText(document.title, 100),
            detection: { kind: '', label: '', evidence: {} },
            blockerMessages: [],
            controls: [],
            lockedNavigation: [],
            canvases: [],
            embeds: [],
            recentActions: [],
            runtimeErrors: []
        };
        if (detection) {
            incident.detection.kind = clipStr(detection.kind, 60);
            incident.detection.label = clipStr(detection.label, 120);
            const srcEv = detection.evidence || {};
            for (const k of ['frame', 'tag', 'text', 'cls', 'src', 'title']) {
                if (srcEv[k] != null) incident.detection.evidence[k] = scrubIncidentText(srcEv[k], 200);
            }
        }
        try {
            const seen = new Set();
            for (const el of document.querySelectorAll(
                '[role="alert"], [aria-live="assertive"], [class*="validation"], [class*="error"], [class*="required"], [class*="hint"]')) {
                if (incident.blockerMessages.length >= 10) break;
                if (!isRenderedForIncident(el)) continue;
                const txt = scrubIncidentText(el.innerText || el.textContent || '', 180);
                if (!txt || seen.has(txt)) continue;
                seen.add(txt);
                incident.blockerMessages.push(txt);
            }
        } catch (e) {}
        try {
            for (const el of document.querySelectorAll(
                'button, a, input, select, textarea, [role="button"], [role="radio"], [role="checkbox"], [role="option"], [aria-disabled]')) {
                if (incident.controls.length >= 40) break;
                if (!isRenderedForIncident(el)) continue;
                incident.controls.push(controlEvidence(el));
            }
        } catch (e) {}
        try {
            for (const el of document.querySelectorAll('button, a, [role="button"], [aria-disabled]')) {
                if (incident.lockedNavigation.length >= 10) break;
                if (!isRenderedForIncident(el)) continue;
                const t = clipStr(el.getAttribute('aria-label') || el.innerText || el.textContent || '', 60);
                if (!/\b(next|continue|submit|check|done)\b/i.test(t)) continue;
                const locked = el.disabled || el.getAttribute('aria-disabled') === 'true' ||
                    !!el.closest('.is-disabled, [disabled], .locked, [class*="locked"], [aria-disabled="true"]');
                if (!locked) continue;
                incident.lockedNavigation.push(controlEvidence(el));
            }
        } catch (e) {}
        try {
            for (const c of document.querySelectorAll('canvas')) {
                if (incident.canvases.length >= 10) break;
                if (!isRenderedForIncident(c)) continue;
                const r = c.getBoundingClientRect();
                incident.canvases.push({
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                    label: scrubIncidentText(c.getAttribute('aria-label') || '', 100),
                    cls: clipStr(c.getAttribute('class') || '', 120)
                });
            }
        } catch (e) {}
        try {
            for (const f of document.querySelectorAll('iframe')) {
                if (incident.embeds.length >= 10) break;
                if (!isRenderedForIncident(f)) continue;
                const src = sanitizeIncidentUrl(f.getAttribute('src') || '');
                if (!src) continue;
                incident.embeds.push({ src });
            }
        } catch (e) {}
        incident.recentActions = frameJournal.slice(-30).map(a => ({
            at: clipStr(a && a.at, 40),
            kind: clipStr(a && a.kind, 20),
            text: scrubIncidentText(a && a.text, 160)
        }));
        incident.runtimeErrors = runtimeErrors.slice(-20).map(er => ({
            at: clipStr(er && er.at, 40),
            kind: clipStr(er && er.kind, 30),
            message: scrubIncidentText(er && er.message, 200),
            source: sanitizeIncidentUrl(er && er.source),
            line: er && er.line,
            column: er && er.column
        }));
        try { incident.diag = buildDiag(); } catch (e) {}
        return incident;
    }

    // Point-in-time state snapshot — answers the usual first questions at a
    // stall: which scroller is real, what's locked, what's still interactive,
    // and whether the course model was reachable. Sanitized (no user data).
    function buildDiag() {
        const d = {
            at: new Date().toISOString(),
            url: sanitizeIncidentUrl(location.href),
            title: clipStr(document.title, 80),
            engine: detectCourseEngine(),
            state: String(window === window.top ? state : iframeState),
            isSolving: !!isSolving,
            frame: clipStr(frameOriginPath(), 200)
        };
        try {
            d.scrollers = Array.from(document.querySelectorAll('.page-wrap, .page__wrapper, .lesson-main'))
                .map(s => ({ cls: clipStr(s.className, 60), h: s.scrollHeight, ch: s.clientHeight, top: Math.round(s.scrollTop) }))
                .filter(s => s.h > s.ch + 10).slice(0, 6);
        } catch (e) {}
        try {
            d.interactives = {
                checkboxChecked: document.querySelectorAll('.block-list [role="checkbox"][aria-checked="true"]').length,
                checkboxUnchecked: document.querySelectorAll('.block-list [role="checkbox"][aria-checked="false"]').length,
                accordionOpen: document.querySelectorAll('button.blocks-accordion__header[aria-expanded="true"]').length,
                accordionClosed: document.querySelectorAll('button.blocks-accordion__header[aria-expanded="false"]').length,
                videos: document.querySelectorAll('video').length
            };
        } catch (e) {}
        try {
            const cb = document.querySelector('button.continue-btn');
            d.continueBtn = cb ? { disabled: !!cb.disabled, text: clipStr(cb.innerText, 30) } : null;
            d.lockHint = /complete the content above/i.test(document.body ? document.body.innerText : '');
        } catch (e) {}
        try {
            const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
            d.courseModel = {
                courseData: !!win.courseData,
                fetchCourse: typeof win.__fetchCourse === 'function',
                quizDefs: (() => { try { return quizDefs().length; } catch (_) { return -1; } })()
            };
        } catch (e) {}
        try {
            d.sweep = { armed: sweepArmed.size, reswept: sweepReswept.size };
            // Timing fields distinguish the two silent-stall signatures:
            // nextActionIn>0 = the delay branch is eating every tick;
            // huge/zero with no journal = the tick throws before any status.
            d.nextActionIn = Math.max(0, nextActionTime - Date.now());
            d.stuckFor = stuckSince ? Date.now() - stuckSince : 0;
        } catch (e) {}
        // Surface captured runtime errors — an exception thrown inside the
        // tick fires window.onerror but otherwise leaves no trace (the silent-
        // stall signature of DIAG 1790014642688).
        try {
            if (runtimeErrors && runtimeErrors.length) {
                d.errors = runtimeErrors.slice(-4).map(er => clipStr(
                    (er && er.kind ? er.kind + ': ' : '') + ((er && er.message) || er) +
                    (er && er.source ? ' @ ' + sanitizeIncidentUrl(er.source) + ':' + (er.line || '?') : ''), 200));
            }
        } catch (e) {}
        return d;
    }

    // Merged timeline across all frames (each frame owns a GM key, tagged by
    // frame origin+path) — survives navigation and answers "what did the
    // script do" at any stall.
    function mergedJournal() {
        const out = [];
        try {
            for (const k of GM_listValues()) {
                if (!k.startsWith('seed_journal::')) continue;
                try {
                    const arr = JSON.parse(GM_getValue(k, '[]'));
                    const tag = k.slice(14).replace(/^https?:\/\//, '').slice(-70);
                    if (Array.isArray(arr)) for (const e of arr) out.push({ f: tag, at: e.at, kind: e.kind, text: e.text });
                } catch (e) {}
            }
        } catch (e) {}
        out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        return out.slice(-400);
    }

    function collectDiags() {
        const out = {};
        try {
            for (const k of GM_listValues()) {
                if (!k.startsWith('seed_diag::')) continue;
                try { out[k.slice(11).replace(/^https?:\/\//, '')] = JSON.parse(GM_getValue(k, '{}')); } catch (e) {}
            }
        } catch (e) {}
        return out;
    }

    function isTerminalNavLabel(cleanText) {
        return ['EXIT', 'EXIT COURSE', 'FINISH', 'COMPLETE'].includes(cleanText);
    }

    function isKnownForwardLabel(cleanText) {
        return [
            'CONTINUE', 'NEXT LESSON', 'NEXT', 'START COURSE', 'RESUME COURSE',
            'START QUIZ', 'START', 'BEGIN', 'ENTER', 'LETS GO', 'RESUME'
        ].includes(cleanText);
    }

    function detectCourseExitPage() {
        const frame = frameOriginPath();
        const title = clipStr(document.title, 80);
        const text = clipStr(document.body ? document.body.innerText : '', 400);
        const lowerTitle = title.toLowerCase();
        const path = location.pathname.toLowerCase();
        const shortBody = text.length <= 300;
        const matched = lowerTitle === 'bye' || /\/(?:bye|exit)(?:\.html?)?\/?$/.test(path) ||
            (shortBody && /\b(you may (?:now )?close this window|course has ended|session has ended)\b/i.test(text));
        if (!matched) return null;
        const signature = clipStr('terminal|' + frame + '|' + title, 200);
        return { signature, evidence: { frame: clipStr(frame, 200), title, text: clipStr(text, 120) } };
    }

    function detectUnhandledAdapter() {
        try {
            if (!isLikelyCourseContentFrame()) return null;
            const signals = {};
            const detail = {};

            // Required-response validation surfaces block forward nav and need a
            // dedicated adapter. Detect before generic quiz probing; the bare word
            // "required" alone is not sufficient — the text must match a directive.
            try {
                const reqEl = Array.from(document.querySelectorAll(
                    '[role="alert"], [aria-live="assertive"], [class*="validation"], [class*="error"], [class*="required"], [class*="hint"]'
                )).find(el => {
                    if (!isRenderedForIncident(el)) return false;
                    const txt = scrubIncidentText(el.innerText || el.textContent || '', 200);
                    return /please\s+(?:provide|select|choose|answer)|(?:response|answer|selection)\s+(?:is\s+)?required|complete\s+(?:this\s+)?(?:interaction|question)|correct\s+(?:answer|response)\s+required/i.test(txt);
                });
                if (reqEl) {
                    signals.requiredResponse = true;
                    detail['required-response'] = reqEl.closest('.quiz-card, [data-block-id], [class*="interaction"], form, section, article') || reqEl;
                }
            } catch (e) {}

            // Unknown quiz: a SUBMIT button is visible but detectActiveQuiz can't classify it.
            // Skip when a feedback/result card is already showing a verdict.
            try {
                const submit = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                    .find(b => (b.innerText || '').trim().toUpperCase() === 'SUBMIT' && isVisible(b));
                if (submit && !detectActiveQuiz(new Set())) {
                    const verdict = Array.from(document.querySelectorAll(
                        '.quiz-card__feedback, [class*="feedback--active"], .quiz-card__feedback-label, .quiz-feedback, [class*="result-card"]'
                    )).find(el => isVisible(el) && /\b(correct|incorrect|passed|failed)\b/i.test(el.innerText || ''));
                    if (!verdict) { signals.unknownQuiz = true; detail['unknown-quiz'] = submit; }
                }
            } catch (e) {}

            const ordEl = firstVisible('[data-ordering], [data-sorting], [class*="sorting-activity"], [class*="ordering-interaction"], [class*="sequence-interaction"], [aria-label*="reorder" i]');
            if (ordEl) { signals.ordering = true; detail.ordering = ordEl; }

            // .labeled-graphic-marker deliberately excluded — START already handles it.
            const hotEl = firstVisible('[data-hotspot], [class*="hotspot-question"], [class*="hotspot-interaction"], svg [aria-label*="hotspot" i]');
            if (hotEl) { signals.hotspot = true; detail.hotspot = hotEl; }

            let simEl = firstVisible('[data-simulation], [class*="simulation"], [aria-label*="simulation" i]');
            if (!simEl) {
                simEl = Array.from(document.querySelectorAll('canvas')).find(c => {
                    if (!isVisible(c)) return false;
                    const r = c.getBoundingClientRect();
                    if (r.width < 300 || r.height < 180) return false;
                    const host = c.closest('div, section, article, main') || c.parentElement;
                    const txt = host ? clipStr(
                        (host.getAttribute('class') || '') + ' ' + (host.getAttribute('aria-label') || '') + ' ' + (host.innerText || ''), 300) : '';
                    return /simulation|practice|try it|exercise/i.test(txt);
                });
            }
            if (simEl) { signals.simulation = true; detail.simulation = simEl; }

            const extFrame = Array.from(document.querySelectorAll('iframe')).find(f => {
                if (!isVisible(f)) return false;
                if (!f.closest('[data-block-id], .lesson-main, .page-wrap, .slide-object, [class*="embed"]')) return false;
                const src = (f.getAttribute('src') || '').trim();
                if (!src) return false;
                try {
                    const u = new URL(src, location.href);
                    return u.origin !== location.origin && !isAllowedEmbedHost(u.hostname);
                } catch (e) { return false; }
            });
            if (extFrame) { signals.externalEmbed = true; detail['external-embed'] = extFrame; }

            const storyEl = firstVisible('.slide-object, [data-acc-text], #slide');
            if (/story(?:_html5)?\.html|storyline|story_content/i.test(location.pathname) || storyEl) {
                signals.storyline = true;
                detail.storyline = storyEl || document.body;
            }

            const kindInfo = classifyUnhandledAdapter(signals);
            if (!kindInfo) return null;

            const el = detail[kindInfo.kind];
            const evidence = elEvidence(el);
            if (kindInfo.kind === 'external-embed' && el) {
                evidence.src = sanitizeEmbedSrc(el.getAttribute('src') || '');
            }
            const signature = clipStr(
                kindInfo.kind + '|' + evidence.frame + '|' + evidence.tag + '|' + (evidence.src || evidence.cls), 200);
            return { kind: kindInfo.kind, label: kindInfo.label, signature, evidence };
        } catch (e) { return null; }
    }

    // =========================================================
    // 5. MEMORY
    // =========================================================
    let isSolving = false;
    let nextActionTime = 0;

    const attempted     = new Set();
    const sessionAttempts = new Set();
    const recordedAttempts = new Set();
    const clickedNavs   = new Set();
    const fwdClickLog   = new Map();
    const interactedBlocks = {};
    const sweepArmed    = new Set();
    const sweepTopDone  = new Set();
    const sweepReswept  = new Set();
    const answerSrc     = {};   // questionId -> 'courseData'|'history'|'scorm'|'ai'
    const watchedMedia  = new Set();
    const mediaRetries  = {};
    const sortRetries   = {};   // card-id -> drag attempts (bounded)
    const takeAgainRetries = {};
    const lastAttempt   = {};
    const unhandledSurfaces = new Set();
    const terminalPages = new Set();
    let stuckSince = 0;
    let activeSolveQId = null;   // question currently being solved by the AI
    const quizSolveFails = {};   // per-question AI-failure count (max 3 retries)
    const errorReleased = new Set(); // qids released via submission error — re-click selections, DOM state is untrusted
    let passedQuizMsg = '';      // set when a results screen shows a passing score
    let quizPassedReported = false;

    function loadPastFailures() {
        try {
            const data = JSON.parse(GM_getValue('seed_past_failures', '{}'));
            const fails = {};
            for (const key in data) fails[key] = new Set(data[key]);
            return fails;
        } catch(e) { return {}; }
    }
    function savePastFailures(fails) {
        try {
            const data = {};
            for (const key in fails) data[key] = Array.from(fails[key]);
            GM_setValue('seed_past_failures', JSON.stringify(data));
        } catch(e) {}
    }

    // Persistent History Logs
    function loadHistory() {
        try { return JSON.parse(GM_getValue('seed_history', '{}')); } catch(e) { return {}; }
    }
    let logsWindow = null;

    function saveHistory(data) {
        try {
            GM_setValue('seed_history', JSON.stringify(data));
            if (logsWindow && !logsWindow.closed) {
                logsWindow.historyData = data;
                logsWindow.document.getElementById('logs-body').innerHTML = renderStatsBody(data);
            }
        } catch(e) {}
    }

    // Generate HTML for Logs Viewer
    function getCourseName() {
        const titleEl = document.querySelector('.nav-sidebar-header__title, .course-title, [class*="course-title"], header h1');
        if (titleEl) return (titleEl.innerText || titleEl.textContent || '').trim();
        return document.title && document.title !== 'Seed Talent' ? document.title : 'Unknown Course';
    }



    function renderStatsBody(history) {
        let correctCount = 0; let wrongCount = 0;
        let totalQs = Object.keys(history).length;

        let headerHtml = `<div style="display:flex; justify-content:space-between; align-items:center;">
            <h1>📊 Performance Logs</h1>
            <div>
                <span style="color:#a6adc8; margin-right: 15px; font-size: 14px; opacity: 0.8;">(Live Updating)</span>
                <button onclick="downloadCSV()">⬇ Download CSV</button>
            </div>
        </div>`;

        let questionsHtml = '';
        for (const qId in history) {
            const q = history[qId];
            let qStatus = 'Unanswered / Unknown';
            let statusClass = '';

            if (q.attempts && q.attempts.length > 0) {
                const lastResult = q.attempts[q.attempts.length - 1].result;
                if (lastResult === 'Correct') { correctCount++; qStatus = 'Solved Correctly'; statusClass = 'correct'; }
                else if (lastResult === 'Incorrect') { wrongCount++; qStatus = 'Failed (Retrying...)'; statusClass = 'incorrect'; }
            }

            let courseBadge = q.course && q.course !== 'Unknown Course' ?
                `<span style="background:#b4befe; color:#1e1e2e; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 10px; font-weight: bold;">${q.course}</span>` : '';

            let card = `<div class="q-card">
                <h3 style="margin-top:0; color:#89b4fa;">Q: ${qId}</h3>
                <p style="margin:5px 0;">Type: <b>${q.type}</b> | Status: <span class="${statusClass}">${qStatus}</span> ${courseBadge}</p>`;

            if (q.knownCorrect) {
                card += `<div style="background: rgba(166, 227, 161, 0.1); border-left: 4px solid #a6e3a1; padding: 10px; margin: 10px 0; border-radius: 4px;">
                    <b style="color: #a6e3a1;">✅ Revealed Correct Answer:</b><br>
                    <span style="font-family: monospace;">${JSON.stringify(q.knownCorrect)}</span>
                </div>`;
            }

            card += `<div style="display:flex; gap: 20px;">
                    <div style="flex:1;">
                        <h4 style="margin-bottom:5px;">Options/Items:</h4>
                        <ul style="margin-top:0; padding-left:20px;">`;

            if (q.type === 'matching') {
                card += `<li><b>Left:</b></li>`;
                if(q.left) q.left.forEach(l => card += `<li>${l}</li>`);
                card += `<li><b>Right:</b></li>`;
                if(q.right) q.right.forEach(r => card += `<li>${r}</li>`);
            } else {
                if(q.options) q.options.forEach(o => card += `<li>${o}</li>`);
            }

            card += `</ul></div><div style="flex:1;"><h4 style="margin-bottom:5px;">Attempt History:</h4>`;

            if (!q.attempts || q.attempts.length === 0) {
                card += `<p style="color:#a6adc8; font-style:italic;">No attempts recorded with feedback yet.</p>`;
            } else {
                q.attempts.forEach((a, i) => {
                    const resClass = a.result === 'Correct' ? 'correct' : 'incorrect';
                    const srcBadge = a.src ? ` <span style="color:#b4befe;font-size:11px;font-weight:bold;">[${a.src}]</span>` : '';
                    card += `<div class="guess">
                        <b>Attempt ${i+1}</b> - <span class="${resClass}">${a.result}</span>${srcBadge} <span style="color:#a6adc8;font-size:12px;">(${new Date(a.time).toLocaleTimeString()})</span><br>
                        ${a.guess}
                    </div>`;
                });
            }
            card += `</div></div></div>`;
            questionsHtml += card;
        }

        const acc = (correctCount + wrongCount) > 0 ? Math.round((correctCount / (correctCount + wrongCount)) * 100) : 0;

        let statsHtml = `<div style="background:#45475a; padding:15px; border-radius:8px; margin-bottom:20px;">
            <h2 style="margin-top:0;">Overall Accuracy: <span style="color:${acc > 70 ? '#a6e3a1' : '#f9e2af'}">${acc}%</span></h2>
            <p style="margin-bottom:0;">Questions Encountered: <b>${totalQs}</b> | Solved: <b>${correctCount}</b> | Currently Failing: <b>${wrongCount}</b></p>
        </div><hr style="border-color:#45475a; margin: 20px 0;">`;

        return headerHtml + statsHtml + questionsHtml;
    }

    function renderStatsHTML() {
        const history = loadHistory();
        let html = `<html><head><title>Seed Helper Logs</title>
        <style>
            body { font-family: sans-serif; background: #1e1e2e; color: #cdd6f4; padding: 20px; line-height: 1.5; }
            .q-card { background: #313244; margin-bottom: 20px; padding: 15px; border-radius: 8px; border: 1px solid #45475a; }
            .correct { color: #a6e3a1; font-weight: bold; }
            .incorrect { color: #f38ba8; font-weight: bold; }
            .guess { background: #45475a; padding: 8px; border-radius: 4px; margin-top: 8px; font-family: monospace; }
            button { background: #89b4fa; color: #1e1e2e; border: none; padding: 8px 16px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 14px; }
            button:hover { opacity: 0.9; }
        </style>
        <script>
            var historyData = ${JSON.stringify(history)};
            function downloadCSV() {
                let csv = "Course,Question,Type,Result,Guess,Time\\n";
                for (let q in historyData) {
                    const attempts = historyData[q].attempts || [];
                    const c = (historyData[q].course || 'Unknown').replace(/"/g, '""');
                    if (!attempts.length) {
                        csv += '"' + c + '","' + q.replace(/"/g, '""') + '","' + historyData[q].type + '","Unanswered","",""\\n';
                    } else {
                        for (let a of attempts) {
                            csv += '"' + c + '","' + q.replace(/"/g, '""') + '","' + historyData[q].type + '","' + a.result + '","' + (a.guess||'').replace(/"/g, '""') + '","' + a.time + '"\\n';
                        }
                    }
                }
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'seed_talent_logs.csv';
                a.click();
            }
        </script>
        </head><body id="logs-body">
        ${renderStatsBody(history)}
        </body></html>`;
        return html;
    }

    const pastFailures = loadPastFailures();
    let lastSolvedQuestion = '';

    function resetMemory() {
        attempted.clear();
        clickedNavs.clear();
        fwdClickLog.clear();
        Object.keys(interactedBlocks).forEach(k => delete interactedBlocks[k]);
        sweepArmed.clear();
        sweepTopDone.clear();
        sweepReswept.clear();
        watchedMedia.clear();
        isSolving = false;
        nextActionTime = 0;
        Object.keys(mediaRetries).forEach(k => delete mediaRetries[k]);
        Object.keys(sortRetries).forEach(k => delete sortRetries[k]);
        Object.keys(takeAgainRetries).forEach(k => delete takeAgainRetries[k]);
        unhandledSurfaces.clear();
        terminalPages.clear();
        idleIncidents.clear();
        Object.keys(quizSolveFails).forEach(k => delete quizSolveFails[k]);
        activeSolveQId = null;
        passedQuizMsg = '';
        quizPassedReported = false;
        stuckSince = 0;
    }

    // =========================================================
    // 6. QUIZ DETECTION
    //
    // ✅ PROVEN: document-wide label search (NOT card-scoped).
    //
    // Rise does not reliably share a common ancestor between the
    // SUBMIT button and the answer labels. Card-scoped search
    // returns 0 labels and falls through to Priority B (NEXT btn),
    // causing the script to skip every question unanswered.
    //
    // See dev_notes.md for full explanation.
    // =========================================================
    function detectActiveQuiz(attemptedSet) {
        const submitBtns = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(b => {
            const t = (b.innerText || '').trim().toUpperCase();
            if (t !== 'SUBMIT') return false;
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const s = window.getComputedStyle(b);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
            return true;
        });

        for (const submitBtn of submitBtns) {
            // Rise keeps submitted cards mounted alongside the active one, and
            // the submit bar can sit outside the card — so a container found
            // via closest() can mix one card's title with another's options.
            // Bind to the single active card instead; skip stale submits.
            const activeCard = document.querySelector('.quiz-card--active:not([inert])');
            const ownCard = submitBtn.closest('.quiz-card, .block-knowledge, .quiz-item__card, .quiz-question, .question-container, .quiz-lesson-content, [class*="quiz-question"]');
            let container;
            if (activeCard) {
                if (ownCard && ownCard !== activeCard
                    && ownCard.matches('.quiz-card, [class*="quiz-card"], .quiz-item__card, .quiz-question')) continue;
                container = activeCard;
            } else {
                container = ownCard
                         || submitBtn.closest('.lesson-main, .page-wrap')
                         || document;
            }

        // Helper to check if an option is actually visually on screen (ignoring pointer-events)
        const isOptionVisible = el => {
            if (!el || el.getAttribute('aria-hidden') === 'true' || el.closest('[inert]')) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 5 && r.height <= 5) return false;
            const cx = r.left + r.width / 2;
            if (cx < -50 || cx > window.innerWidth + 50) return false; // Carousel off-screen check
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
            return true;
        };

        // Step 2: find MCQ labels/wrappers within the container
        let mcqLabels = Array.from(container.querySelectorAll(
            '.quiz-multiple-response-option-wrap, ' +
            '.quiz-single-response-option-wrap, ' +
            '.quiz-multiple-choice-option-wrap, ' +
            '.quiz-single-choice-option-wrap, ' +
            '[class*="-option-wrap"], ' +
            '.quiz-card__interactive li, ' +
            '.quiz-card__interactive label'
        )).filter(isOptionVisible);

        // Fallback for generic LMSs: labels that explicitly wrap an input
        if (mcqLabels.length === 0) {
            mcqLabels = Array.from(container.querySelectorAll('li label, label, .option')).filter(el => {
                if (!isOptionVisible(el)) return false;
                return el.querySelector('input[type="radio"], input[type="checkbox"]');
            });
        }

        // Remove inner descendants to avoid duplicates, keeping the outermost wrappers
        mcqLabels = mcqLabels.filter(el => !mcqLabels.some(other => other !== el && other.contains(el)));

        sendDebug(`detectActiveQuiz: Found submit button. Container=${container.tagName}. MCQ Options=${mcqLabels.length}`);

        // Step 3: find matching pieces using confirmed explicit column selectors
        const col1Btns = Array.from(container.querySelectorAll(
            'ul.matching-interaction-col-1 button.matching-interaction-piece, ' +
            'li.matching-interaction-item.draggable button.matching-interaction-piece'
        )).filter(el => isVisible(el));

        const col2Btns = Array.from(container.querySelectorAll(
            'ul.matching-interaction-col-2 button.matching-interaction-piece, ' +
            'li.matching-interaction-item.droppable button.matching-interaction-piece'
        )).filter(el => isVisible(el));

        // Dropdown-matching variant: li.matching-item rows each carrying a
        // <select> or a popup-listbox trigger instead of draggable pieces.
        // Without this check the LIs fall through to the generic MCQ path.
        const ddRows = Array.from(container.querySelectorAll('li.matching-item'))
            .filter(isOptionVisible)
            .filter(r => r.querySelector('select, [role="combobox"], button[aria-haspopup="listbox"], [aria-haspopup="true"]'));

        // quiz-match variant (C1256 knowledge-check): chevron term items drag
        // onto descriptor cards. Droppable LIs are aria-hidden hit targets —
        // isVisible would reject them. Rows off-viewport are still valid pair
        // members (courseData needs all of them), so size is the only filter.
        const qmRect = el => {
            const r = el.getBoundingClientRect();
            return r.width > 5 && r.height > 5;
        };
        const qmDrag = Array.from(container.querySelectorAll('li.quiz-match__item--draggable')).filter(qmRect);
        const qmDrop = Array.from(container.querySelectorAll('li.quiz-match__item--immobile.droppable')).filter(qmRect);

        if (mcqLabels.length === 0 && col1Btns.length < 2 && col2Btns.length < 2 && ddRows.length < 2 && qmDrag.length < 2) continue;

        // Step 4: generate a stable quiz ID
        let titleEl = container.querySelector('.quiz-card__title, [class*="quiz-card__title"], .quiz-question__title, [class*="question-title"]');
        if (!titleEl) titleEl = container.querySelector('h1, h2, h3, h4, legend');
        let qId = titleEl ? (titleEl.innerText || titleEl.textContent).trim() : '';
        if (qId.length > 150) qId = qId.substring(0, 150); // Sanity check length

        // Fallback: hash answer option text
        if (!qId) {
            const pieces = [...mcqLabels, ...col1Btns, ...col2Btns]
                .map(el => (el.innerText || el.textContent || '').trim())
                .filter(Boolean);
            if (pieces.length > 0) qId = 'hash_' + pieces.join('|').substring(0, 180);
        }
        if (!qId) qId = 'unknown_' + Date.now();

        if (attemptedSet && attemptedSet.has(qId)) {
            // `attempted` only proves the solver was scheduled — the submit may
            // never have landed, or a Take Again pass reset the card. If the
            // card still shows unanswered (no selection, no feedback label),
            // release it for a bounded re-solve instead of skipping forever.
            // quiz-match marks each landed pair with --matched — a partial match
            // is mid-solve, not committed. Only non-quiz-match containers treat
            // a "matched" class as proof of a committed answer.
            const committed = container.querySelector(
                'input:checked, [aria-checked="true"], [aria-pressed="true"], ' +
                '[class*="--selected"], [class*="is-selected"], [class*="dropped"], ' +
                '[data-select-item="current"]:not([data-value=""])' // filled matching-dd row
            ) || (!container.querySelector('li.quiz-match__item--draggable')
                  && container.querySelector('[class*="matched"]'))
            || Array.from(container.querySelectorAll(
                '.quiz-card__feedback-label, [class*="quiz-card__feedback"]'
            )).some(el => isVisible(el))
            || (() => { const ti = container.querySelector('input[type="text"], input.quiz-fill__input'); return ti && String(ti.value || '').trim().length > 0; })();
            if (committed || qId === activeSolveQId || (quizSolveFails[qId] || 0) >= 4) {
                sendDebug(`detectActiveQuiz: Found submit button but quiz ${qId.substring(0, 20)} already attempted. Skipping...`);
                continue;
            }
            quizSolveFails[qId] = (quizSolveFails[qId] || 0) + 1;
            attemptedSet.delete(qId);
            sendDebug(`detectActiveQuiz: ${qId.substring(0, 20)} was attempted but is still unanswered — releasing for re-solve (${quizSolveFails[qId]}/4)`);
        }

        // Step 5: classify
        if (col1Btns.length >= 2 && col2Btns.length >= 2) {
            return { type: 'matching', submitBtn, id: qId, col1: col1Btns, col2: col2Btns };
        }
        if (qmDrag.length >= 2 && qmDrop.length >= 2) {
            return { type: 'matching', submitBtn, id: qId, col1: qmDrag, col2: qmDrop };
        }
        if (ddRows.length >= 2) {
            return { type: 'matching-dd', submitBtn, id: qId, rows: ddRows };
        }
        if (mcqLabels.length >= 2) {
            // Classify by the actual control type, scanning ALL wrappers then the
            // container — a label whose input is a sibling (not a descendant) must
            // not fall through to className heuristics. 'quiz-multiple-choice' is
            // Rise's SINGLE-select class; only 'multiple-response' means multi.
            let isMulti;
            const wrapInputs = mcqLabels.map(el => el.querySelector('input[type="radio"], input[type="checkbox"]')).filter(Boolean);
            const inputs = wrapInputs.length ? wrapInputs
                : Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
            if (inputs.length) {
                isMulti = inputs[0].type === 'checkbox';
            } else {
                const cn = String(mcqLabels[0].className || '').toLowerCase();
                const roleRadio = mcqLabels[0].querySelector('[role="radio"]') || mcqLabels[0].getAttribute('role') === 'radio' || !!mcqLabels[0].closest('[role="radiogroup"]');
                const roleCb = mcqLabels[0].querySelector('[role="checkbox"]') || mcqLabels[0].getAttribute('role') === 'checkbox';
                if (cn.includes('multiple-choice') || cn.includes('single') || roleRadio) isMulti = false;
                else if (cn.includes('multiple-response') || cn.includes('multi') || roleCb) isMulti = true;
                else isMulti = false;
            }

            return { type: 'mcq', submitBtn, id: qId, labels: mcqLabels, isMulti };
        }

        const fillInput = container.querySelector('input.quiz-fill__input, [class*="quiz-fill"] input[type="text"]');
        if (fillInput) {
            return { type: 'fill_in_blank', submitBtn, id: qId, input: fillInput };
        }
        } // end of submitBtn loop

        return null;
    }

    // =========================================================
    // 7. MAIN LOOP
    // =========================================================
    // Warm the course-model fetch now so quiz answer defs are resolved before
    // the solver needs them (the __fetchCourse path is async).
    try { quizDefs(); } catch(e) {}

    // Tick-body is wrapped so an exception can't die silently once a second —
    // DIAG 1790014642688 ran "running" with zero journal output while diag
    // snapshots stayed live: consistent with the body throwing before any
    // sendStatus. reportTickError journals each unique failure once and lets
    // the 15s idle watchdog still fire.
    const tickErrSeen = new Set();
    function reportTickError(e) {
        const msg = String((e && e.message) || e || 'unknown');
        const frame2 = String((e && e.stack) || '').split('\n')[1] || '';
        const sig = msg + '|' + frame2;
        if (!tickErrSeen.has(sig)) {
            tickErrSeen.add(sig);
            sendDebug('tick error: ' + msg.slice(0, 120) + (frame2 ? ' @ ' + frame2.trim().slice(0, 80) : ''));
        }
        const n = Date.now();
        if (!stuckSince) stuckSince = n;
        if (n - stuckSince >= 15000) reportUnknownIdle();
    }

    function tickBody() {
        if (!isRunning()) return;
        const now = Date.now();
        // Refresh this frame's diag snapshot ~every 20s so a later DUMP/DIAG
        // always has near-current state even if frames die mid-broadcast.
        if (now - lastDiagWrite > 20000) {
            lastDiagWrite = now;
            try { GM_setValue(diagKey, JSON.stringify(buildDiag())); } catch(e) {}
        }
        if (now < nextActionTime) {
            // Delays are normal — but 'Delay Ns' is journal-filtered, so a
            // perpetually re-armed nextActionTime is indistinguishable from a
            // dead script (DIAG 1790014642688 signature). Watch it like any
            // other stall: >15s of continuous delay reports an incident.
            // isSolving is real work (AI round-trips exceed 15s) — exempt it
            // the same way the tick tail does.
            if (isSolving) stuckSince = 0;
            else if (!stuckSince) stuckSince = now;
            sendDebug(isSolving ? 'Waiting for AI...' : `Delay ${Math.round((nextActionTime - now) / 1000)}s`);
            if (!isSolving && now - stuckSince >= 15000) reportUnknownIdle();
            return;
        }

        // Terminal guard: never act on a course exit/Bye page.
        const terminalPage = detectCourseExitPage();
        if (terminalPage) {
            reportTerminalPage(terminalPage);
            return;
        }

        // ── TRACK FEEDBACK RESULTS ─────────────────────────────
        const fbContainers = Array.from(document.querySelectorAll('.quiz-card__feedback, [class*="feedback--active"], .quiz-card__feedback-label, .quiz-feedback'));
        for (const fbContainer of fbContainers) {
            if (!isVisible(fbContainer)) continue;

            const card = fbContainer.closest('.quiz-card, .quiz-item__card, .question-container, [class*="quiz-question"]');
            if (!card) continue;

            let titleEl = card.querySelector('.quiz-card__title, [class*="quiz-card__title"], .quiz-question__title, [class*="question-title"]');
            if (!titleEl) titleEl = card.querySelector('h1, h2, h3, h4, legend');
            const currentQId = titleEl ? (titleEl.innerText || titleEl.textContent).trim() : lastSolvedQuestion;

            if (currentQId && lastAttempt[currentQId]) {
                    const fbText = (fbContainer.innerText || fbContainer.textContent || '').trim().toLowerCase();

                    // Skip error banners that contain the word "correct" or "answer"
                    if (fbText.includes('please answer') || fbText.includes('requires a correct answer')) {
                        continue;
                    }

                    if (fbText.includes('correct')) {
                        const result = fbText.includes('incorrect') ? 'Incorrect' : 'Correct';
                        sendDebug(`Feedback Tracker: Found ${result} for Q: ${currentQId.substring(0,20)}`);

                        const guessStr = typeof lastAttempt[currentQId] === 'string'
                                       ? lastAttempt[currentQId]
                                       : JSON.stringify(lastAttempt[currentQId]);

                        // Try to scrape the revealed correct answer if the course shows it
                        let revealedCorrect = null;
                        if (result === 'Incorrect') {
                            let found = [];
                            // Try standard specific selectors first
                            const correctItems = card.querySelectorAll('.is-correct, .quiz-multiple-response-option--correct, .quiz-single-response-option--correct, [class*="--correct"]');
                            if (correctItems.length > 0) {
                                correctItems.forEach(item => {
                                    const textEl = item.querySelector('.quiz-multiple-response-option__text, .quiz-single-response-option__text, [class*="option__text"], p') || item;
                                    found.push((textEl.innerText || textEl.textContent || '').trim());
                                });
                            } else {
                                // Fallback to scraping checkmark icons explicitly on the card
                                const checkIcons = card.querySelectorAll('i.icon-Check, i[class*="icon-check"], svg[data-icon="check"]');
                                checkIcons.forEach(icon => {
                                    const parentLabel = icon.closest('label, li, [class*="response-option"]');
                                    if (parentLabel) found.push((parentLabel.innerText || parentLabel.textContent || '').trim());
                                });
                            }
                            if (found.length > 0) revealedCorrect = found.filter(Boolean);
                        }

                        // Use a timestamp-based key instead of just guess to allow identical retries to be logged
                        const attemptKey = currentQId + '|' + guessStr + '|' + result;

                        if (!recordedAttempts.has(attemptKey)) {
                            recordedAttempts.add(attemptKey);
                            const history = loadHistory();
                            if (!history[currentQId]) {
                                history[currentQId] = { type: 'unknown', course: getCourseName(), attempts: [] };
                            }
                            if (!history[currentQId].attempts) history[currentQId].attempts = [];

                            history[currentQId].attempts.push({
                                    guess: guessStr,
                                    result: result,
                                    src: answerSrc[currentQId] || undefined,
                                    revealedCorrect: revealedCorrect, // log if found
                                    time: new Date().toISOString()
                                });
                                // If we found the correct answer, permanently attach it to the question
                                if (revealedCorrect) history[currentQId].knownCorrect = revealedCorrect;

                                saveHistory(history);

                                // Also log to pastFailures so the AI knows not to repeat it
                                if (result === 'Incorrect') {
                                    if (!pastFailures[currentQId]) pastFailures[currentQId] = new Set();
                                    pastFailures[currentQId].add(guessStr);
                                    savePastFailures(pastFailures);
                                }
                        }
                    }
                }
            }

        // ── PRIORITY A: Unanswered quiz ────────────────────────
        if (!isSolving) {
            const quiz = detectActiveQuiz(attempted);
            if (quiz && !attempted.has(quiz.id)) {
                attempted.add(quiz.id);
                sessionAttempts.add(quiz.id);
                activeSolveQId = quiz.id;
                sendStatus('Reading question...', '#f9e2af');
                const delay = 500 + Math.random() * 500;
                nextActionTime = now + delay + 800;
                setTimeout(() => {
                    if (!isRunning()) {
                        attempted.delete(quiz.id);
                        sessionAttempts.delete(quiz.id);
                        if (activeSolveQId === quiz.id) activeSolveQId = null;
                        return;
                    }
                    if (quiz.type === 'mcq') solveQuiz(quiz.id, quiz.labels, quiz.submitBtn, quiz.isMulti);
                    else if (quiz.type === 'fill_in_blank') solveFillInTheBlank(quiz.id, quiz.input, quiz.submitBtn);
                    else if (quiz.type === 'matching-dd') solveMatchingDropdown(quiz.id, quiz.rows, quiz.submitBtn);
                    else solveMatchingQuestion(quiz.id, quiz.col1, quiz.col2, quiz.submitBtn);
                }, delay);
                return;
            }
        }

        // ── PRIORITY A1: Handle Submission Errors ──────────────
        // If the script clicks SUBMIT but the options weren't actually selected
        // (due to a DOM quirk), Rise shows an error. We must clear `attempted` to retry.
        if (!isSolving) {
            const activeCards = Array.from(document.querySelectorAll('.quiz-card--active:not([inert])'));
            for (const activeCard of activeCards) {
                const errText = activeCard.innerText.toLowerCase();
                if (errText.includes('please answer the question to continue') || errText.includes('requires a correct answer to continue')) {
                    let titleEl = activeCard.querySelector('.quiz-card__title, [class*="quiz-card__title"], .quiz-question__title, [class*="question-title"]');
                    if (!titleEl) titleEl = activeCard.querySelector('h1, h2, h3, h4, legend');
                    const errQId = titleEl ? (titleEl.innerText || titleEl.textContent).trim() : '';
                    if (errQId && attempted.has(errQId)) {
                        const n = (quizSolveFails[errQId] || 0) + 1;
                        quizSolveFails[errQId] = n;
                        if (n <= 4) {
                            // Mark for force-reclick: the error proves Rise never
                            // registered the selection, so DOM "checked" is a lie.
                            errorReleased.add(errQId);
                            attempted.delete(errQId);
                            sendDebug(`Submission error detected. Clearing attempted state for retry (${n}/4)...`);
                        } else if (n === 5) {
                            // Past the bound: leave it attempted so the card keeps
                            // skipping; the idle watchdog reports the stall.
                            sendDebug(`Submission error persists for ${errQId.substring(0, 20)} — not releasing again.`);
                            // Dump the option markup so the next DIAG shows the real
                            // structure instead of another blind guess.
                            const optEl = activeCard.querySelector('[class*="-option-wrap"], li.matching-item, [class*="quiz-card__interactive"] > *');
                            if (optEl) sendDebug('Card markup: ' + String(optEl.outerHTML).replace(/\s+/g, ' ').slice(0, 700));
                            sendDebug('Card classes: ' + String(activeCard.className) + ' | submit in card: ' + !!activeCard.querySelector('button, [role="button"]'));
                        }
                        nextActionTime = now + 3000;
                        return;
                    }
                }
            }
        }

        // ── PRIORITY A2: Advance past quiz feedback ────────────
        // After submitting a quiz card, Rise shows "Correct"/"Incorrect" feedback.
        // For matching questions, the NEXT button can stay aria-disabled even after
        // "Correct" feedback. Clicking SUBMIT again tells Rise to advance the card.
        // Only fires when: not solving, feedback label is visible, NEXT is still disabled.
        if (!isSolving) {
            const activeCards = Array.from(document.querySelectorAll('.quiz-card--active:not([inert])'));
            for (const activeCard of activeCards) {
                const feedbackLabel = activeCard.querySelector('.quiz-card__feedback-label');
                const fbContainer = feedbackLabel ? feedbackLabel.closest('.quiz-card__feedback') || feedbackLabel : null;

                if (!feedbackLabel || !isVisible(fbContainer)) continue;

                const fbText = (feedbackLabel.innerText || '').trim();

                if (fbText === 'Correct' || fbText === 'Incorrect') {
                    const nextBtn = activeCard.querySelector('.quiz-card__button--next');
                    const nextDisabled = !nextBtn || nextBtn.getAttribute('aria-disabled') === 'true' ||
                                        nextBtn.getAttribute('aria-hidden') === 'true' || !isVisible(nextBtn);

                    // For Incorrect feedback: only advance via SUBMIT if no Take Again is visible
                    // (otherwise Priority D handles the retry)
                    const hasTakeAgain = fbText === 'Incorrect' && Array.from(document.querySelectorAll('button, a, [role="button"]')).some(b => {
                        if (!isVisible(b)) return false;
                        const t = (b.innerText || b.textContent || '').trim().toUpperCase();
                        return t.includes('TAKE AGAIN') || t.includes('RETRY') || t === 'TRY AGAIN';
                    });

                    if (nextDisabled && !hasTakeAgain) {
                        // Find the SUBMIT button on the active card
                        const advBtn = Array.from(activeCard.querySelectorAll('button.quiz-card__button')).find(b => {
                            return isVisible(b) && (b.innerText || '').trim().toUpperCase() === 'SUBMIT';
                        });
                        if (advBtn) {
                            const qTitle = activeCard.querySelector('.quiz-card__title, [class*="quiz-card__title"]');
                            const titleText = qTitle ? (qTitle.querySelector('p') || qTitle).innerText.trim().substring(0, 50) : 'unknown';
                            const advKey = 'fb_advance_' + fbText + '_' + titleText;

                            if (!clickedNavs.has(advKey)) {
                                clickedNavs.add(advKey);
                                sendStatus(`Advancing past ${fbText} feedback...`, '#89b4fa', true);
                                if (fbText === 'Incorrect' && lastSolvedQuestion && lastAttempt[lastSolvedQuestion]) {
                                    if (!pastFailures[lastSolvedQuestion]) pastFailures[lastSolvedQuestion] = new Set();
                                    pastFailures[lastSolvedQuestion].add(lastAttempt[lastSolvedQuestion]);
                                    savePastFailures(pastFailures);
                                }
                                setTimeout(() => simulateHumanClick(advBtn), 400 + Math.random() * 300);
                                nextActionTime = now + 1500;
                                return;
                            }
                        }
                    }
                }
            }
        }

        // ── PRIORITY B: Next question (within multi-Q quiz) ───
        // ANTI-HIJACK: Never treat SUBMIT as a Next button
        const nextQBtn = Array.from(document.querySelectorAll(
            'button.quiz-card__button--next, button[class*="button--next"]'
        )).find(b => {
            if (!isVisible(b)) return false;
            const t = (b.innerText || '').trim().toUpperCase();
            return t !== 'SUBMIT';
        });

        if (nextQBtn) {
            sendStatus('Next question...', '#89b4fa', true);
            setTimeout(() => simulateHumanClick(nextQBtn), 350 + Math.random() * 350);
            nextActionTime = now + 1200;
            return;
        }

        // ── PRIORITY D: Retry failed quiz (Top Priority over Navigation) ───
        if (true) {
            const retryBtn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                if (!isVisible(b)) return false;
                const t = (b.innerText || b.textContent || '').trim().toUpperCase();
                if (!t.includes('TAKE AGAIN') && !t.includes('RETRY') && t !== 'TRY AGAIN') return false;

                // Don't retry if we passed
                const pageText = document.body.innerText.toUpperCase();
                let container = b.closest('[class*="result"], [class*="quiz-card"]') || b.parentElement?.parentElement?.parentElement;
                const cText = container ? container.innerText.toUpperCase() : '';

                // Driver state is authoritative: a committed fail vetoes any DOM
                // "pass" (score can render as "undefined%" and mislead regexes).
                let scormVeto = false;
                const psPre = pageText.match(/(?:PASSING|PASS MARK|PASSING SCORE|PASSING GRADE|TARGET)[^\d%]{0,30}(\d+)/);
                try {
                    const api = findScormApi();
                    if (api) {
                        const succ = String(scormGet(api, 'cmi.success_status') || '').toLowerCase();
                        const scaled = parseFloat(scormGet(api, 'cmi.score.scaled'));
                        if (succ === 'failed' || (Number.isFinite(scaled) && psPre && scaled * 100 < parseInt(psPre[1]) - 0.5)) {
                            scormVeto = true;
                        } else if (succ === 'passed') {
                            sendDebug('Quiz passed (cmi.success_status) - ignoring Take Again button.');
                            passedQuizMsg = 'Quiz passed';
                            return false;
                        }
                    }
                } catch (e) {}

                if (!scormVeto && (cText.includes('YOU PASSED') || cText.includes('CONGRATULATIONS') || cText.match(/\bPASSED\b/) || pageText.includes('YOU PASSED') || pageText.includes('CONGRATULATIONS'))) {
                    sendDebug('Quiz passed - ignoring Take Again button.');
                    passedQuizMsg = 'Quiz passed';
                    return false;
                }

                // Score digits must appear before the next '%' — otherwise a
                // "Your score undefined%" line makes the regex skip ahead and
                // capture the PASSING mark as the learner's score.
                if (!scormVeto && (cText.match(/(?:YOUR SCORE|YOU SCORED|SCORE:|SCORE\s*-)[^\d%]{0,30}100\s*%/) || pageText.match(/(?:YOUR SCORE|YOU SCORED|SCORE:|SCORE\s*-)[^\d%]{0,30}100\s*%/))) {
                    sendDebug('Perfect score - ignoring Take Again button.');
                    passedQuizMsg = 'Quiz passed with 100%';
                    return false;
                }

                const ys = pageText.match(/(?:YOUR SCORE|YOU SCORED|SCORE:|SCORE\s*-)[^\d%]{0,30}(\d+)/);
                const ps = psPre;
                if (!scormVeto && ys && ps && parseInt(ys[1]) >= parseInt(ps[1])) {
                    sendDebug(`Score ${ys[1]} >= ${ps[1]} - ignoring Take Again button.`);
                    passedQuizMsg = `Quiz passed (score ${ys[1]} >= pass ${ps[1]})`;
                    return false;
                }

                const block = b.closest('[id^="block-"]');
                const docY  = window.scrollY + b.getBoundingClientRect().top;
                const id    = block ? block.id : 'retry_' + Math.round(docY / 500);
                if ((takeAgainRetries[id] || 0) >= 15) return false;
                return true;
            });

            if (retryBtn) {
                const block = retryBtn.closest('[id^="block-"]');
                const docY  = window.scrollY + retryBtn.getBoundingClientRect().top;
                const id    = block ? block.id : 'retry_' + Math.round(docY / 500);

                let addedAny = false;
                const history = loadHistory();

                // Add the absolute last solved question just in case
                if (lastSolvedQuestion && lastAttempt[lastSolvedQuestion]) {
                    sessionAttempts.add(lastSolvedQuestion);
                }

                for (const qId of sessionAttempts) {
                    if (lastAttempt[qId]) {
                        if (!pastFailures[qId]) pastFailures[qId] = new Set();
                        pastFailures[qId].add(lastAttempt[qId]);
                        addedAny = true;

                        // Also add it to history so it shows up in the Logs UI
                        if (!history[qId]) history[qId] = { type: 'unknown', course: getCourseName(), attempts: [] };
                        if (!history[qId].attempts) history[qId].attempts = [];

                        const guessStr = typeof lastAttempt[qId] === 'string' ? lastAttempt[qId] : JSON.stringify(lastAttempt[qId]);
                        history[qId].attempts.push({
                            guess: guessStr,
                            result: 'Incorrect (Blind Fail)',
                            src: answerSrc[qId] || undefined,
                            time: new Date().toISOString()
                        });
                    }
                }

                if (addedAny) {
                    savePastFailures(pastFailures);
                    saveHistory(history);
                }

                sendStatus('Retrying failed quiz...', '#f38ba8', true);
                setTimeout(() => {
                    simulateHumanClick(retryBtn);
                    takeAgainRetries[id] = (takeAgainRetries[id] || 0) + 1;
                    attempted.clear();
                    sessionAttempts.clear();
                    Object.keys(quizSolveFails).forEach(k => delete quizSolveFails[k]);
                    isSolving = false;
                }, 500);
                nextActionTime = now + 2000;
                return;
            }
        }

        // ── PRIORITY C: Forward navigation (Continue/Next Lesson)
        const fwdCandidates = [];
        const fwdSelectors = [
            'button', 'a', '[role="button"]',
            'div[data-direction="next"]',
            '[aria-label*="Next" i]',
            '[aria-label*="Continue" i]',
            '[aria-label*="Forward" i]',
            '.next-btn', '.nav-next', '.right-arrow', '.continue-btn',
            '[data-continue-btn]', '.overview__button', '.overview-list__link'
        ].join(', ');

        document.querySelectorAll(fwdSelectors).forEach(el => {
            if (!isVisible(el)) return;
            // Never treat our own panel controls as page navigation — the
            // START button's label matches isKnownForwardLabel('START').
            if (el.closest('#seed-panel, #seed-helper-root')) return;
            const t = (el.innerText || el.textContent || '').trim().toUpperCase();
            if (t === 'SUBMIT') return;
            // Intra-block carousel steppers belong to the interactive handler (C1).
            // Forward-nav would claim them once via data-block-id navId, dedupe every
            // later click, and keep hasUnlockedFwd true so C1 never runs.
            if (el.matches('button.carousel-controls-next, button.carousel-controls-prev, button.carousel-controls-item-btn, button.block-flashcards-slider__arrow, button.process-counter__btn, button.process-control--next, button.carousel-slider__control--next, button.block-carousel__control--next')) return;
            // Labeled-graphic bubble pagers (bubble__next carries aria-label="Next"):
            // they page between marker cards INSIDE the block — never page navigation.
            // They also stay rect-visible when their bubble is closed, so D would
            // claim and re-click them forever (DIAG 1790011519015).
            if (el.matches('button[class*="bubble__"], [class*="bubble"] button')) return;
            const cleanT = t.replace(/[^A-Z0-9\s]/g, '').trim();
            const isTerminal = isTerminalNavLabel(cleanT);
            const isFwd = !isTerminal && (
                isKnownForwardLabel(cleanT) ||
                el.matches('a.lesson-link--next, .next-lesson__link, [data-direction="next"], .overview__button, .continue-btn, [data-continue-btn], [aria-label*="Next" i], [aria-label*="Continue" i], [aria-label*="Start" i], [aria-label*="Resume" i], .overview-list__link, .next-btn, .nav-next, .right-arrow')
            );
            if (isFwd) fwdCandidates.push(el);
        });

        let hasUnlockedFwd = false;
        for (const el of fwdCandidates) {
            const locked = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('locked') || el.classList.contains('continue-hint') || !!el.closest('.is-disabled, [disabled], .locked, [class*="locked"], [aria-disabled="true"]');
            if (locked) continue;

            const t = (el.innerText || el.textContent || '').trim().toUpperCase();

            // Rise uses data-block-id for unique block identifiers
            const block = el.closest('[data-block-id]');
            const docY  = window.scrollY + el.getBoundingClientRect().top;

            // Generate a unique navId combining position, text, and current page title
            const heading = document.querySelector('h1, h2, h3, .title');
            const pageKey = heading ? heading.innerText.trim().substring(0, 20).replace(/\s+/g, '_') : 'page';

            const navId = block ? block.getAttribute('data-block-id') : (pageKey + '_' + t + '_' + Math.round(docY / 500));

            // A claimed control that was already clicked but never navigated
            // must not hold hasUnlockedFwd forever — retry after 8s, and after
            // 4 failed clicks release it so C1/interactives/incident can run.
            const rec = fwdClickLog.get(navId) || { n: 0, at: 0 };
            if (rec.n >= 4) continue;
            hasUnlockedFwd = true;
            if (now - rec.at < 8000) continue;
            fwdClickLog.set(navId, { n: rec.n + 1, at: now });
            if (rec.n > 0) sendDebug('Re-clicking forward control x' + (rec.n + 1) + ': ' + navId);

            // Grab page text right before we navigate away for the course summary feature
            try { window.top.postMessage({ type: 'SEED_COURSE_TEXT', text: document.body.innerText }, '*'); } catch(e) {}

            // Safe scroll to button if off-screen
            try {
                if (el.getBoundingClientRect().bottom > window.innerHeight) {
                    scrollContainerFor(el).scrollTop += 300;
                }
            } catch(e) {}

            sendStatus('Advancing...', '#a6e3a1', true);
            setTimeout(() => simulateHumanClick(el), 350 + Math.random() * 300);
            nextActionTime = now + 1500;
            return;
        }

        // ── PRIORITY E: Quiz passed → report completion, then stop ─────
        // Priority D proves a pass whenever it refuses a Take Again. A passed
        // results screen with no forward control (only EXIT COURSE / TAKE AGAIN)
        // would otherwise idle into unknown-idle. Runs after C so a results
        // screen that still offers an enabled Continue/Next keeps navigating.
        if (passedQuizMsg && !quizPassedReported && !hasUnlockedFwd) {
            quizPassedReported = true;
            const scorm = readScormSummary();
            const suffix = scorm ? ` | cmi: ${scorm.completion || '?'}/${scorm.success || '?'}/${scorm.score || '?'}` : '';
            const msg = `✓ ${passedQuizMsg}${suffix} — course done, you can exit.`;
            sendStatus(msg, '#a6e3a1');
            try { window.top.postMessage({ type: 'SEED_QUIZ_PASSED', text: msg }, '*'); } catch(e) {}
            return;
        }

        // ── PRIORITY C1: Interactive Blocks (Accordions, Tabs, Process, Carousel, Flashcards)
        // If forward path is locked or absent, click unread interactives to unlock it
        if (!hasUnlockedFwd) {
            let clickedInteractive = false;
            const interactives = document.querySelectorAll(
                'button.accordion__title-text, ' +
                'button.blocks-accordion__header, ' +
                'button.tab-nav__item, ' +
                'button.process-control--next, ' +
                'button.carousel-controls-next, ' +
                'button.carousel-slider__control--next, ' +
                'button.block-carousel__control--next, ' +
                'button.labeled-graphic-marker, ' +
                'button.flashcard__turn, ' +
                'button.flashcard-side-flip__btn[id$="-front-flip-btn"], ' +
                '.flashcard:not(.flashcard--flipped) .flashcard-side--front .flashcard-side-flip__btn, ' +
                'button.block-flashcards-slider__arrow--next, ' +
                'button.process-counter__btn, ' +
                'button.blocks-slide-indicator__button, ' +
                'button.blocks-gallery-grid__image, ' +
                'button.interactive-grid__item, ' +
                'label.block-list__option, ' +
                '.block-list [role="checkbox"]'
            );

            for (const el of interactives) {
                if (clickedInteractive || !isVisible(el)) continue;
                const locked = el.disabled || el.getAttribute('aria-disabled') === 'true';
                if (locked) continue;

                // Skip tabs/slides that are currently active
                if (el.classList.contains('tab-nav__item--active') ||
                    el.classList.contains('is-active') ||
                    el.classList.contains('blocks-slide-indicator__button--active') ||
                    el.getAttribute('aria-selected') === 'true' ||
                    el.getAttribute('aria-current') === 'page' ||
                    el.getAttribute('aria-current') === 'true') continue;

                // Skip accordions that are already open
                if (el.getAttribute('aria-expanded') === 'true') continue;
                // Skip labeled graphic markers that are visited. C1256 uses
                // --complete + aria-label "Viewed" (not is-visited), so without
                // this every viewed marker is re-clicked each tick.
                if (el.classList.contains('is-visited') || el.classList.contains('labeled-graphic-marker--complete')) continue;
                if (el.classList.contains('labeled-graphic-marker') && /,\s*Viewed\s*$/i.test(el.getAttribute('aria-label') || '')) continue;

                // Skip checkboxes that are already checked
                if (el.getAttribute('aria-checked') === 'true') continue;
                if (el.matches('label.block-list__option')) {
                    const cb = el.querySelector('input[type="checkbox"]');
                    if (cb && cb.checked) continue;
                    // Decorative label on a role=checkbox item — the role
                    // element handles the toggle; clicking both double-fires.
                    const item = el.closest('.block-list__item');
                    if (item && item.querySelector('[role="checkbox"]')) continue;
                }

                const block = el.closest('[data-block-id]');

                // For slide dots, strictly enforce forward-only navigation to avoid infinite loops
                if (el.classList.contains('blocks-slide-indicator__button')) {
                    const allDots = Array.from((block || document).querySelectorAll('.blocks-slide-indicator__button'));
                    const activeIdx = allDots.findIndex(d => d.classList.contains('blocks-slide-indicator__button--active') || d.getAttribute('aria-current') === 'page');
                    const myIdx = allDots.indexOf(el);
                    if (myIdx <= activeIdx) continue;
                }

                let t = (el.innerText || el.textContent || '').trim().substring(0, 30);
                if (!t) t = (el.getAttribute('aria-label') || '').trim().substring(0, 30);

                // Identifier uses block-id AND text so we can hit multiple tabs/accordions in same block
                let intId = el.id || ((block ? block.getAttribute('data-block-id') : 'int_' + Math.round(window.scrollY + el.getBoundingClientRect().top)) + '_' + t);
                // Checkbox controls share block + little text — index them so each
                // box gets its own retry budget instead of sharing one intId.
                if (el.matches('[role="checkbox"]')) {
                    intId += '_' + Array.from((block || document).querySelectorAll('[role="checkbox"]')).indexOf(el);
                }

                const tries = interactedBlocks[intId] || 0;
                if (tries >= 15) continue; // safety fallback for looping carousels/processes
                interactedBlocks[intId] = tries + 1;
                clickedInteractive = true;

                // Safe scroll
                try {
                    if (el.getBoundingClientRect().bottom > window.innerHeight) {
                        const scroller = el.closest('.page-wrap, .page__wrapper, .lesson-main, [style*="overflow: auto"], [style*="overflow-y: auto"]') || document.documentElement;
                        scroller.scrollTop += 300;
                    }
                } catch(e) {}

                const isFlashcardGrid = el.matches('button.flashcard-side-flip__btn');
                // Sequential steppers must fire exactly one click: the full synthetic
                // sequence + native click double-fires and can skip a step's onStep,
                // leaving the block permanently incomplete.
                const isStepperNext = el.matches('button.carousel-controls-next, button.process-control--next, button.carousel-slider__control--next, button.block-carousel__control--next, button.block-flashcards-slider__arrow--next, button.process-counter__btn');
                // Toggle controls must fire exactly once: simulateHumanClick
                // dispatches a click event AND calls el.click() — on a <label>,
                // role=checkbox hitarea, or aria-expanded accordion each fires the
                // toggle twice (check+uncheck / open+close = net nothing).
                const isListOption = el.matches('label.block-list__option');
                const isHitarea = el.matches('[role="checkbox"]');
                const isToggle = el.getAttribute('aria-expanded') !== null;
                sendStatus(isFlashcardGrid ? 'Flipping required card...' : isStepperNext ? 'Advancing process step...' : 'Completing interactive block...', '#f9e2af', true);
                setTimeout(() => {
                    if (isStepperNext || isHitarea || isToggle) el.click();
                    else if (isListOption) (el.querySelector('input[type="checkbox"], input[type="radio"]') || el).click();
                    else simulateHumanClick(el);
                }, 250 + Math.random() * 250);
                nextActionTime = now + 900;
                stuckSince = 0;   // a claimed interactive is progress — don't
                return;           // let its delay accumulate into a false idle
            }
        }

        // -- PRIORITY E: Video (only if navigation is blocked) ---
        if (!hasUnlockedFwd) {
            const medias = Array.from(document.querySelectorAll('video, audio'));
            const playBtns = Array.from(document.querySelectorAll('.vjs-big-play-button, button[aria-label="Play Video"], button[class*="play"], .plyr__control--overlaid, .ytp-large-play-button, [aria-label*="Play" i]')).filter(b => isVisible(b));

            // Normal <video> tag logic — runs first: it mutes, plays, and
            // scrubs the real element (synthetic clicks on the overlay alone
            // are rejected by autoplay policy), and it dismisses any
            // big-play overlay itself via the ancestor walk below.
            for (let i = 0; i < medias.length; i++) {
                    const m = medias[i];
                    const block   = m.closest('[id^="block-"]') || m.closest('[class*="block-"]') || m.parentElement;
                    const docY    = window.scrollY + m.getBoundingClientRect().top;
                    const mediaId = block ? (block.id || block.className || 'media_' + i) : ('media_' + Math.round(docY / 500));
                    if (m.currentTime > 0 && m.duration > 0 && m.currentTime >= m.duration - 1) {
                        watchedMedia.add(mediaId);
                    }
                    if (watchedMedia.has(mediaId)) continue;

                    // A live watchdog already owns this element — wait for it
                    // instead of burning retry budget on a parallel attempt.
                    if (m.__seedWd) {
                        sendStatus('Video playing...', '#f9e2af', true);
                        nextActionTime = now + 3000;
                        stuckSince = 0;
                        return;
                    }

                    const att = mediaRetries[mediaId] || 0;
                    if (att >= 3) { watchedMedia.add(mediaId); continue; }
                    mediaRetries[mediaId] = att + 1;

                    sendStatus(`Playing video (attempt ${att + 1})...`, '#f9e2af', true);
                    sendDebug(`video ${i}: paused=${m.paused} t=${Math.round(m.currentTime || 0)}/${Math.round(m.duration || 0)}`);

                    setTimeout(() => {
                        let p = m.parentElement, clicked = false;
                        while (p && p !== document.body && !clicked) {
                            const pb = p.querySelector('.vjs-big-play-button, button[aria-label="Play Video"], button[class*="play"], .plyr__control--overlaid, .ytp-large-play-button');
                            if (pb && isVisible(pb)) { simulateHumanClick(pb); clicked = true; }
                            p = p.parentElement;
                        }
                        m.muted = true;
                        m.playbackRate = 16;
                        m.play().catch(() => {});

                        // Watchdog: keep the video moving to the end. Rise video
                        // blocks can revert programmatic seeks and clamp
                        // playbackRate (~2x), so this survives a long real-time
                        // playthrough and stops fighting a seek-proof player.
                        let lastT = -1, stalled = 0, checks = 0, seekTarget = -1, noSeek = false;
                        const watchdog = setInterval(() => {
                            checks++;
                            if (!m.isConnected) { clearInterval(watchdog); m.__seedWd = false; return; }
                            const d = m.duration;
                            if (m.ended || (d > 0 && m.currentTime >= d - 1)) {
                                clearInterval(watchdog);
                                m.__seedWd = false;
                                ['timeupdate', 'ended'].forEach(ev => m.dispatchEvent(new Event(ev, { bubbles: true })));
                                watchedMedia.add(mediaId);
                                sendStatus('Video finished.', '#a6e3a1', true);
                                return;
                            }
                            // If the player undid our seek, stop seeking — it
                            // has anti-skip protection and we must play through.
                            if (seekTarget >= 0) {
                                if (m.currentTime < seekTarget - 2) { noSeek = true; sendDebug('video seek reverted — playing through'); }
                                seekTarget = -1;
                            }
                            if (!noSeek && d > 10 && m.currentTime < d - 6) {
                                sendStatus('Scrubbing video...', '#a6e3a1', true);
                                m.currentTime = d - 5;
                                seekTarget = d - 5;
                                ['seeking', 'seeked', 'timeupdate'].forEach(ev => m.dispatchEvent(new Event(ev, { bubbles: true })));
                            }
                            if (m.playbackRate !== 16) m.playbackRate = 16;
                            if (m.paused) { m.muted = true; m.play().catch(() => {}); }
                            else if (m.currentTime === lastT) {
                                stalled++;
                                if (stalled % 6 === 0) m.play().catch(() => {});
                                if (stalled >= 60) { clearInterval(watchdog); m.__seedWd = false; sendDebug('video stalled — attempt exhausted'); return; }
                            } else stalled = 0;
                            lastT = m.currentTime;
                            if (checks > 720) { clearInterval(watchdog); m.__seedWd = false; }
                        }, 500);
                        m.__seedWd = true;
                    }, 800);

                    nextActionTime = now + 7000;
                    stuckSince = 0;
                    return;
                }

            // Play button with no <video> in its block — iframe/embed only.
            for (const pb of playBtns) {
                const block = pb.closest('[id^="block-"]') || pb.parentElement;
                if (block && block.querySelector('video, audio')) continue;
                const docY  = window.scrollY + pb.getBoundingClientRect().top;
                const mediaId = block ? (block.id || 'pb_' + Math.round(docY / 500)) : ('pb_' + Math.round(docY / 500));

                if (watchedMedia.has(mediaId)) continue;

                const att = mediaRetries[mediaId] || 0;
                if (att >= 3) { watchedMedia.add(mediaId); continue; }
                mediaRetries[mediaId] = att + 1;

                sendStatus(`Clicking Play button (attempt ${att + 1})...`, '#f9e2af', true);
                setTimeout(() => simulateHumanClick(pb), 400);
                nextActionTime = now + 2000;
                stuckSince = 0;
                return;
            }
        }

        // -- PRIORITY E2: Card-sort deck (interactive-fullscreen/sorting) ---
        // Course model carries items[] {id,title,pileId} + piles[] {id,title};
        // DOM card element ids equal model item ids. One card is active at a
        // time (aria-hidden="false"); drag it onto the .pile whose title the
        // model assigns. Bounded per-card retries, then the idle incident
        // reports it like any other unsupported surface.
        // The block pins itself into view before each drag — the F sweep
        // scrolling mid-drag moved the target and the drop silently missed
        // (Ethanol→Classic Vape, live test).
        if (!hasUnlockedFwd) {
            const sortBlock = Array.from(document.querySelectorAll('.block-sorting-activity'))
                .find(b => b.querySelector('.playing-card, .deck__title'));
            if (sortBlock) {
                const deckT = ((sortBlock.querySelector('.deck__title') || {}).innerText || '').trim();
                const mDone = deckT.match(/(\d+)\s*\/\s*(\d+)/);
                const allCorrect = mDone && +mDone[1] >= +mDone[2] && +mDone[2] > 0;
                const card = sortBlock.querySelector('.playing-card[aria-hidden="false"]');
                if (!allCorrect && card && _sortingKey && _sortingKey[card.id]) {
                    const pile = Array.from(sortBlock.querySelectorAll('.pile')).find(p => {
                        const t = ((p.querySelector('.pile__title') || {}).innerText || '').trim();
                        return t === _sortingKey[card.id];
                    });
                    if (pile) {
                        const br = sortBlock.getBoundingClientRect();
                        if (br.top < 0 || br.bottom > window.innerHeight) {
                            scrollContainerFor(sortBlock).scrollTop += (br.top + br.height / 2) - window.innerHeight / 2;
                            sendStatus('Positioning sorting block...', '#f9e2af', true);
                            nextActionTime = now + 800;
                            stuckSince = 0;
                            return;
                        }
                        if (isVisible(card) && isVisible(pile)) {
                            const att = sortRetries[card.id] || 0;
                            if (att < 4) {
                                sortRetries[card.id] = att + 1;
                                sendStatus(`Sorting card: ${(card.innerText || '').trim().slice(0, 30)} → ${_sortingKey[card.id]}`, '#f9e2af', true);
                                setTimeout(() => { try { simulateDrag(card, pile); } catch(e) {} }, 400);
                                nextActionTime = now + 2500;
                                stuckSince = 0;
                                return;
                            }
                        }
                    }
                }
            }
        }

        // ── PRIORITY F: Locked Continue Button Scroll ───
        // Yields while a solve is in flight — scrolling mid-solve drags the
        // quiz card off-screen and invalidates drag-target rects.
        if (!hasUnlockedFwd && !isSolving) {
            const lockedBtn = fwdCandidates.find(el => {
                const locked = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('locked') || el.classList.contains('continue-hint') || !!el.closest('.is-disabled, [disabled], .locked, [class*="locked"], [aria-disabled="true"]');
                return locked && isVisible(el);
            });
            // Rise "completeAll" dividers render only a hint while locked — no
            // button — so they never reach fwdCandidates. Their gate is every
            // block above marked viewed by the scroller's IntersectionObserver,
            // and lazy blocks mount only while scrolling. Sweep the real
            // scroller top→bottom; reaching the bottom ends the pass, and a
            // page change (new signature / scrollTop reset) re-sweeps naturally.
            const scroller = (lockedBtn && lockedBtn.closest('.page-wrap, .page__wrapper, .lesson-main, [style*="overflow: auto"], [style*="overflow-y: auto"]'))
                || Array.from(document.querySelectorAll('.page-wrap, .page__wrapper, .lesson-main')).find(s => s.scrollHeight > s.clientHeight + 40)
                || document.documentElement;
            if (scroller && scroller.scrollHeight > scroller.clientHeight + 40) {
                const heading = document.querySelector('h1, h2');
                const sig = clipStr(frameOriginPath() + '|' + (location.hash || '') + '|' + scroller.scrollHeight + '|' + (heading ? heading.innerText.trim().slice(0, 40) : ''), 240);
                if (!sweepArmed.has(sig)) {
                    sweepArmed.add(sig);
                    // One top-reset per page (hash) — covers mid-page landings.
                    // Not per-sig: lazy mounts grow scrollHeight and re-arming
                    // must not keep yanking the viewport back to the top.
                    const hashKey = clipStr(frameOriginPath() + '|' + (location.hash || ''), 240);
                    if (!sweepTopDone.has(hashKey)) {
                        sweepTopDone.add(hashKey);
                        if (scroller.scrollTop > 60) scroller.scrollTop = 0;
                    }
                    sendStatus('Reviewing page to unlock Continue...', '#f9e2af', true);
                    nextActionTime = now + 1500;
                    stuckSince = 0; // a working sweep is progress, not idle
                    return;
                }
                if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 5) {
                    scroller.scrollTop += 250;
                    sendStatus('Reviewing page to unlock Continue...', '#f9e2af', true);
                    nextActionTime = now + 1500;
                    stuckSince = 0;
                    return;
                }
                // Bottom reached but a gate is still locked: blocks above were
                // likely skipped (mid-page landing). One resweep per signature.
                const stillLocked = !!lockedBtn || /complete the content above|before moving on/i.test(document.body ? document.body.innerText : '');
                if (stillLocked && !sweepReswept.has(sig)) {
                    sweepReswept.add(sig);
                    scroller.scrollTop = 0;
                    sendStatus('Re-reviewing page to unlock Continue...', '#f9e2af', true);
                    nextActionTime = now + 1500;
                    stuckSince = 0;
                    return;
                }
            }
        }

        if (hasUnlockedFwd) {
            stuckSince = 0;
            sendStatus('Forward path open — waiting for transition...', '#a6e3a1', true);
        } else {
            // An in-flight AI solve/retry can legitimately exceed the idle
            // thresholds — it is work in progress, not a stall.
            if (isSolving) stuckSince = 0;
            if (!stuckSince) stuckSince = now;
            // Only probe for unsupported surfaces after 5s idle, so normal
            // handlers and page transitions get first chance.
            if (now - stuckSince >= 5000) {
                const unhandled = detectUnhandledAdapter();
                if (unhandled && reportUnhandledAdapter(unhandled)) return;
            }
            // Recognized adapters win first; any other real stall pauses by 15s.
            if (now - stuckSince >= 15000) {
                if (reportUnknownIdle()) return;
            }
            sendStatus('Idle - nothing actionable found on this page.', '#bac2de', true);
        }
    }

    setInterval(() => {
        try { tickBody(); }
        catch (e) { try { reportTickError(e); } catch (_) {} }
    }, 1000);


    // =========================================================
    // 8. MCQ SOLVER
    // =========================================================
    function solveQuiz(questionId, optionLabels, submitBtn, isMulti = true) {
        isSolving = true;

        const hist = loadHistory();
        if (!hist[questionId]) {
            hist[questionId] = {
                type: isMulti ? 'multiple_choice' : 'single_choice',
                course: getCourseName(),
                attempts: []
            };
            saveHistory(hist);
        }

        // ✅ Confirmed clean text selector from live HTML
        const getText = el => {
            const textEl = el.querySelector(
                '.quiz-multiple-response-option__text p, .quiz-multiple-response-option__text, ' +
                '.quiz-single-response-option__text p, .quiz-single-response-option__text, ' +
                '[class*="option-text"] p, [class*="option-text"], [class*="__text"] p, [class*="__text"]'
            );
            return (textEl ? textEl.innerText || textEl.textContent : el.innerText || el.textContent || '').trim();
        };

        // Detect which options are pre-selected (could be a wrong prior attempt)
        const isChecked = el => {
            const input = el.querySelector('input');
            if (input) return input.checked;

            const innerCb = el.querySelector('[role="checkbox"], [role="radio"]');
            if (innerCb && innerCb.getAttribute('aria-checked') === 'true') return true;
            if (el.getAttribute('aria-checked') === 'true') return true;

            return el.classList.contains('--selected') || el.classList.contains('is-selected') ||
                   el.querySelector('[class*="--selected"], [class*="is-selected"]') !== null;
        };
        const preSelected = optionLabels.map((el, i) => isChecked(el) ? i + 1 : null).filter(Boolean);

        const optionTexts = optionLabels.map((el, i) => {
            const sel = preSelected.includes(i + 1) ? ' [currently selected]' : '';
            return `${i + 1}. ${getText(el)}${sel}`;
        });

        // Build prompt — explicitly state single vs multi, and warn about pre-selections
        const typeInstruction = isMulti
            ? 'This is a MULTIPLE ANSWER question (checkboxes). Select ALL correct answers. Output ALL correct numbers separated by commas, e.g. 1,3,5'
            : 'This is a SINGLE ANSWER question (radio button). Select EXACTLY ONE answer. Output only ONE number, e.g. 3';

        const sysMsg = isMulti
            ? 'You are an automated quiz solver. Output ONLY the correct option number(s) as digits separated by commas. NO WORDS. NO EXPLANATIONS. ANY TEXT OTHER THAN DIGITS AND COMMAS WILL CRASH THE SYSTEM.'
            : 'You are an automated quiz solver. Output ONLY ONE digit for the single correct answer. NO WORDS. NO EXPLANATIONS. ANY TEXT OTHER THAN A DIGIT WILL CRASH THE SYSTEM.';

        let userMsg = `Question: ${questionId}\n\n${optionTexts.join('\n')}\n\n${typeInstruction}`;

        let pageContext = "";
        try {
            const allText = document.body.innerText || '';
            const qIndex = allText.indexOf(questionId);
            if (qIndex > -1) {
                pageContext = allText.substring(0, qIndex).trim();
            } else {
                pageContext = allText.trim();
            }
            if (pageContext.length > 2500) pageContext = pageContext.substring(pageContext.length - 2500);
        } catch(e) {}

        if (pageContext && pageContext.length > 50) {
            userMsg += `\n\n--- BACKGROUND COURSE TEXT ---\n${pageContext}\n--- END BACKGROUND TEXT ---\n\nCRITICAL: Output ONLY a comma-separated list of digits for the answer. Nothing else. Do NOT include any explanations or chain of thought.`;
        }

        if (preSelected.length > 0) {
            userMsg += `\n\nNOTE: Options marked [currently selected] may be wrong pre-selections from a prior attempt. Your answer completely overrides them — include an option only if it is truly correct.`;
        }

        const fails = pastFailures[questionId];
        if (fails && fails.size > 0) {
            userMsg += `\n\nWARNING — these exact answer combinations were already tried and marked WRONG. Do NOT repeat them:\n`;
            for (const f of fails) { try { userMsg += `  - ${JSON.parse(f).join(', ')}\n`; } catch(e) {} }
            sendDebug(`Injecting ${fails.size} past failures into prompt for Q: ${questionId.substring(0,20)}`);
        } else {
            sendDebug(`No past failures found for Q: ${questionId.substring(0,20)}`);
        }

        sendStatus(`Solving ${isMulti ? 'multi' : 'single'}-select (${optionLabels.length} opts${preSelected.length ? ', ' + preSelected.length + ' pre-sel' : ''})...`, '#89b4fa');

                    const clickTargetFor = el => {
                        const target = el.querySelector('[role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"]') || el;
                        sendDebug(`Target identified for clicking: ${target.tagName} | class: ${target.className} | role: ${target.getAttribute('role')}`);
                        return target;
                    };

                    const applyNums = async (nums) => {
                        if (nums.length === 0) {
                            releaseFailedQuestion('Could not parse AI answer.', questionId);
                            return;
                        }
                        if (!isMulti && nums.length > 1) {
                            sendDebug(`Single-select received ${nums.length} answers — capping to first (${nums[0]})`);
                            nums = nums.slice(0, 1);
                        }

                        const plain = optionLabels.map(el => getText(el));
                        lastAttempt[questionId] = JSON.stringify(nums.map(n => plain[n - 1]));
                        lastSolvedQuestion = questionId;
                        sendStatus(`✓ Selecting: ${nums.join(', ')}`, '#a6e3a1');

                        (async () => {
                            try {
                                // One-shot flag from the A1 submission-error release: the error
                                // proves Rise never registered the click, so a "selected" DOM
                                // state is drifted and must be re-clicked, not trusted.
                                const forceReselect = errorReleased.has(questionId);
                                if (forceReselect) {
                                    errorReleased.delete(questionId);
                                    sendDebug('Re-solving after submission error — forcing re-click of picked options');
                                }

                                // Rise options are <label>-wrapped inputs: a click anywhere
                                // inside the label forwards to the input, so clicking input +
                                // label + text-div toggles checkboxes an even number of times
                                // (net unchanged) while React's state stays unsynced. Radios
                                // survived this because they can't un-toggle — checkboxes did
                                // not ("Please answer" loop, DIAG 1789998656870). Click ONCE,
                                // verify, escalate to the wrapper, then the setter fallback.
                                const setOptState = async (el, want, num) => {
                                    const cur = isChecked(el);
                                    sendDebug(`Option ${num}: shouldBeSelected=${want}, currentlySelected=${cur}`);
                                    if (cur === want && !(forceReselect && want)) return;
                                    el.style.outline = want ? '2px solid #a6e3a1' : '2px solid #f38ba8';
                                    if (cur && want) {
                                        // Drifted: DOM checked but Rise unaware — silent reset
                                        // so the click toggles ON and reports true to React.
                                        const drifted = el.querySelector('input');
                                        if (drifted && drifted.checked) drifted.checked = false;
                                        sendDebug(`Option ${num}: stale selected state — resetting before re-click`);
                                    }
                                    for (const t of [...new Set([clickTargetFor(el), el])]) {
                                        simulateHumanClick(t);
                                        await sleep(450 + Math.random() * 300);
                                        if (isChecked(el) === want) break;
                                    }
                                    if (isChecked(el) !== want) {
                                        const input = el.querySelector('input');
                                        if (input && input.checked !== want) {
                                            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
                                            if (setter) setter.call(input, want);
                                            input.dispatchEvent(new Event('input', { bubbles: true }));
                                            input.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    }
                                };

                                // Iterate ALL options: check ones AI picked, uncheck ones AI did not pick
                                for (let i = 0; i < optionLabels.length; i++) {
                                    const el = optionLabels[i];
                                    if (!el) continue;
                                    await setOptState(el, nums.includes(i + 1), i + 1);
                                    await sleep(250 + Math.random() * 250);
                                }

                                if (AUTO_SUBMIT_QUIZ) {
                                    await sleep(1200 + Math.random() * 800);
                                    if (submitBtn && isVisible(submitBtn)) simulateHumanClick(submitBtn);
                                }
                                isSolving = false;
                            } catch (err) {
                                sendDebug('ERROR in applyNums: ' + err.toString());
                                releaseFailedQuestion('Solver error.', questionId);
                            }
                        })();
                    };

        // Rise exposes the full course model client-side (window.courseData) —
        // correct answers included. Authoritative: check it before history,
        // SCORM readback, and the AI. Works on attempt 1.
        const cdNums = courseDataAnswerNums(questionId, optionLabels.map(el => getText(el)));
        if (cdNums) {
            sendDebug('Course-data answer hit: ' + cdNums.join(', '));
            sendStatus('Applying recorded correct answer...', '#a6e3a1');
            answerSrc[questionId] = 'courseData';
            applyNums(cdNums);
            return;
        }

        const history = loadHistory();
        const past = history[questionId];
        if (past) {
            let correctStrs = null;
            if (past.knownCorrect && past.knownCorrect.length > 0) correctStrs = past.knownCorrect;
            else {
                const correctAttempt = past.attempts.find(a => a.result === 'Correct');
                if (correctAttempt) {
                    try { correctStrs = JSON.parse(correctAttempt.guess); } catch(e) { correctStrs = [correctAttempt.guess]; }
                }
            }
            if (correctStrs && Array.isArray(correctStrs)) {
                const cachedNums = [];
                const plainOpts = optionLabels.map(el => getText(el));
                for (const str of correctStrs) {
                    const idx = plainOpts.findIndex(o => o.trim() === str.trim());
                    if (idx !== -1) cachedNums.push(idx + 1);
                }
                if (cachedNums.length > 0) {
                    sendDebug('CACHE HIT: ' + cachedNums.join(', '));
                    answerSrc[questionId] = 'history';
                    applyNums(cachedNums);
                    return;
                }
            }
        }

        // A prior submit already recorded the driver-verified correct answer.
        const scormNums = scormAnswerNums(questionId, optionLabels.map(el => getText(el)));
        if (scormNums) {
            sendDebug('SCORM correct-response hit: ' + scormNums.join(', '));
            sendStatus('Applying recorded correct answer...', '#a6e3a1');
            answerSrc[questionId] = 'scorm';
            applyNums(scormNums);
            return;
        }

        callOpenRouter(sysMsg, userMsg, 0, (aiText) => {
            sendDebug('AI: "' + aiText.slice(0, 80) + '"');
            answerSrc[questionId] = 'ai';
            let nums = parseNumbers(aiText, optionLabels.length);
            if (!isMulti && nums.length > 1) {
                sendDebug(`Single-select: AI gave ${nums.length}, capping to 1 (${nums[0]})`);
                nums = [nums[0]];
            }
            if (nums.length === 0 && !isMulti && optionLabels.length > 0) nums = [1];
            applyNums(nums);
        });
    }


    // =========================================================
    // 9. FILL IN THE BLANK SOLVER
    // =========================================================
    async function solveFillInTheBlank(questionId, inputEl, submitBtn) {
        isSolving = true;
        sendStatus('Answering fill-in-the-blank...', '#f9e2af');

        const typeInstruction = 'This is a fill-in-the-blank question. Output exactly the text or number that belongs in the blank. Do not write full sentences. If it asks for a number, just write the number. Do NOT wrap your answer in quotes or extra punctuation.';
        const sysMsg = 'You are a quiz solver. Output only the short text/number for the blank. No explanations.';
        let userMsg = `Question: ${questionId}\n\n${typeInstruction}`;

        let pageContext = "";
        try {
            const allText = document.body.innerText || '';
            const qIndex = allText.indexOf(questionId);
            if (qIndex > -1) {
                pageContext = allText.substring(0, qIndex).trim();
            } else {
                pageContext = allText.trim();
            }
            if (pageContext.length > 4000) {
                pageContext = "..." + pageContext.substring(pageContext.length - 4000);
            }
        } catch (e) {}

        if (pageContext && pageContext.length > 50) {
            userMsg = `--- COURSE CONTEXT ---\nHere is the text from the lesson just before the question appeared. Use this to help find the answer:\n${pageContext}\n----------------------\n\n` + userMsg;
        }

        const fails = pastFailures[questionId];
        if (fails && fails.size > 0) {
            userMsg += `\n\nWARNING — these exact answers were already tried and marked WRONG. Do NOT repeat them:\n`;
            for (const f of fails) { try { userMsg += `  - ${JSON.parse(f).join(', ')}\n`; } catch(e) {} }
        }

        const applyAnswer = async (answer) => {
            // To properly type in React/Rise:
            inputEl.focus();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(inputEl, answer);
            } else {
                inputEl.value = answer;
            }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            inputEl.blur();

            // Log attempt
            lastAttempt[questionId] = [answer];
            attempted.add(questionId);

            // Re-render logs
            const hist = loadHistory();
            if (!hist[questionId]) hist[questionId] = { q: questionId, type: 'fill_in_blank', attempts: [] };
            hist[questionId].status = `Attempted`;
            saveHistory(hist);

            if (AUTO_SUBMIT_QUIZ) {
                await sleep(1200 + Math.random() * 800);
                if (submitBtn && isVisible(submitBtn)) simulateHumanClick(submitBtn);
            }
            isSolving = false;
        };

        // Check Cache
        const history = loadHistory();
        const past = history[questionId];
        if (past) {
            let cachedAnswer = null;
            if (past.knownCorrect && past.knownCorrect[0]) cachedAnswer = past.knownCorrect[0];
            else {
                const correctAttempt = past.attempts.find(a => a.result === 'Correct');
                if (correctAttempt) {
                    try {
                        const guessArr = JSON.parse(correctAttempt.guess);
                        if (guessArr && guessArr.length > 0) cachedAnswer = guessArr[0];
                    } catch(e) { cachedAnswer = correctAttempt.guess; }
                }
            }
            if (cachedAnswer) {
                sendDebug('CACHE HIT: "' + cachedAnswer + '"');
                answerSrc[questionId] = 'history';
                await applyAnswer(cachedAnswer);
                return;
            }
        }

        // A prior submit already recorded the driver-verified correct answer.
        const scormAns = scormAnswerText(questionId);
        if (scormAns) {
            sendDebug('SCORM correct-response hit.');
            sendStatus('Applying recorded correct answer...', '#a6e3a1');
            answerSrc[questionId] = 'scorm';
            await applyAnswer(scormAns);
            return;
        }

        callOpenRouter(sysMsg, userMsg, 0, async (aiText) => {
            const answer = aiText.trim();
            sendDebug('AI: "' + answer + '"');
            answerSrc[questionId] = 'ai';
            await applyAnswer(answer);
        });
    }

    // =========================================================
    // 10. MATCHING SOLVER
    // col1 = draggable left pieces (ul.matching-interaction-col-1 buttons)
    // col2 = droppable right pieces (ul.matching-interaction-col-2 buttons)
    // =========================================================
    async function solveMatchingQuestion(questionId, col1, col2, submitBtn) {
        isSolving = true;
        sendStatus('Analysing matching question...', '#f9e2af');

        // ✅ Confirmed text selector from live HTML:
        // .matching-interaction-piece-content span — actual text only, no "Selectable item" noise
        const getPieceText = el => {
            if (!el || !el.querySelector) return '';
            const span = el.querySelector('.matching-interaction-piece-content span, [data-matching-interaction-piece-content-inline] span');
            if (span) return span.innerText.trim();
            // quiz-match: term/descriptor text lives in .quiz-match__item-content.
            // li.innerText is "" while the item is visibility:hidden (lazy mount
            // or mid-animation) — read textContent, which is visibility-blind.
            const qc = el.querySelector('.quiz-match__item-content .fr-view, .quiz-match__item-content > span:last-child');
            if (qc) return (qc.textContent || '').trim();
            return (el.innerText || '').replace(/Selectable item/gi, '').trim();
        };

        // Read existing match state.
        // When a piece is pre-matched, Rise adds:
        //   aria-pressed="true" + class "matching-interaction-piece--matched"
        //   AND a visually-hidden span: "Matched with <span>X</span>"
        const getCurrentMatchText = btn => {
            const spans = Array.from(btn.querySelectorAll('span.visually-hidden-always'));
            for (const s of spans) {
                const raw = (s.innerText || s.textContent || '').trim();
                if (raw.toLowerCase().startsWith('matched with')) {
                    // innerText of nested span is the match target name
                    const nested = s.querySelector('span');
                    return nested ? nested.innerText.trim() : raw.replace(/matched with\s*/i, '').trim();
                }
            }
            return null;
        };

        const col1Texts = col1.map(el => getPieceText(el));
        const col2Texts = col2.map(el => getPieceText(el));

        // Build prompt lines — annotate pre-matched items
        const LT = col1.map((el, i) => {
            const cur = getCurrentMatchText(el);
            const note = cur ? ` [currently matched with: ${cur}]` : '';
            return `L${i + 1}: ${col1Texts[i]}${note}`;
        });
        const RT = col2.map((el, i) => `R${i + 1}: ${col2Texts[i]}`);

        if (!LT.length || !RT.length) {
            releaseFailedQuestion('Could not read matching columns.', questionId);
            return;
        }

        // Count pre-matched
        const preMatchedCount = col1.filter(el => el.getAttribute('aria-pressed') === 'true').length;
        sendDebug(`Matching L(${LT.length}) R(${RT.length}) pre-matched(${preMatchedCount})`);

        let userMsg = `Left items (drag these):\n${LT.join('\n')}\n\nRight items (drop targets):\n${RT.join('\n')}`;

        if (preMatchedCount > 0) {
            userMsg += `\n\nNOTE: Items marked [currently matched with: X] are pre-selected from a prior attempt and may be WRONG. Provide ALL correct pairings — your answer overrides any existing state.`;
        }

        const fails = pastFailures[questionId];
        if (fails && fails.size > 0) {
            userMsg += `\n\nWARNING — these exact pairings were already tried and WRONG:\n`;
            for (const f of fails) { try { userMsg += `  - ${JSON.parse(f).join(' | ')}\n`; } catch(e) {} }
        }
        userMsg += `\n\nOutput ONLY pairs as L#,R# one per line. Example:\nL1,R3\nL2,R1\nL3,R2`;

        sendStatus('Asking AI for matches...', '#89b4fa');

        const applyAiText = async (aiText) => {
                const cleaned = aiText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                const pairs   = [...cleaned.matchAll(/L(\d+)\s*[,→\-:]\s*R(\d+)/gi)];

                if (!pairs.length) {
                    releaseFailedQuestion('AI parse fail on matching.', questionId);
                    return;
                }

                const labelLines = pairs.map(([, l, r]) =>
                    `${col1Texts[+l - 1] || '?'} ➔ ${col2Texts[+r - 1] || '?'}`
                );

                // Log question options if new
                const history = loadHistory();
                if (!history[questionId]) {
                    history[questionId] = {
                        type: 'matching',
                        course: getCourseName(),
                        left: col1Texts,
                        right: col2Texts,
                        attempts: []
                    };
                    saveHistory(history);
                }

                sendMatches(labelLines.join('\n'));
                lastAttempt[questionId] = JSON.stringify(labelLines);
                lastSolvedQuestion = questionId;

                sendStatus(`Dragging ${pairs.length} pairs...`, '#89b4fa');
                // The drop target must be in the viewport — pointer hit-tests
                // resolve at viewport coords, so off-screen rows can't match.
                const ensureVis = el => {
                    const r = el.getBoundingClientRect();
                    if (r.top >= 20 && r.bottom <= window.innerHeight - 20) return;
                    const sc = scrollContainerFor(el);
                    const dy = r.top - Math.max(60, (window.innerHeight - r.height) / 2);
                    if (sc && sc !== document.documentElement) sc.scrollTop += dy;
                    else window.scrollBy(0, dy);
                };
                for (const [, ls, rs] of pairs) {
                    let L = col1[+ls - 1], R = col2[+rs - 1];
                    // quiz-match remounts/re-sorts items after each drop — held
                    // refs detach. Re-resolve by text whenever the node is stale.
                    if (L && L.className && L.className.includes('quiz-match__item')) {
                        const cand = Array.from(document.querySelectorAll('li.quiz-match__item--draggable'))
                            .find(el => scormNorm(getPieceText(el)) === scormNorm(col1Texts[+ls - 1] || ''));
                        if (cand) L = cand;
                    } else if (L && !L.isConnected) L = null;
                    if (R && R.className && R.className.includes('quiz-match__item')) {
                        const cand = Array.from(document.querySelectorAll('li.quiz-match__item--immobile.droppable'))
                            .find(el => scormNorm(getPieceText(el)) === scormNorm(col2Texts[+rs - 1] || ''));
                        if (cand) R = cand;
                    } else if (R && !R.isConnected) R = null;
                    if (!L || !R) continue;

                    // Skip drag if this exact pair is already correctly matched
                    const existingMatch = getCurrentMatchText(L);
                    const targetText = col2Texts[+rs - 1];
                    if (existingMatch && existingMatch.toLowerCase() === targetText.toLowerCase()) {
                        sendDebug(`Already correct: ${col1Texts[+ls - 1]} ↔ ${targetText} — skipping drag`);
                        continue;
                    }

                    ensureVis(R); // synthetic pointerdown hits L off-screen anyway
                    await simulateDrag(L, R);
                    await sleep(450 + Math.random() * 400);

                    // quiz-match marks a landed drop with --matched on the li.
                    // A missed drop wedges the card: submit stays disabled and
                    // the partial state still counts as "committed". Verify each
                    // pair landed; re-resolve stale refs and retry once if not.
                    if (L.className && String(L.className).includes('quiz-match__item')) {
                        const cur = Array.from(document.querySelectorAll('li.quiz-match__item--draggable'))
                            .find(el => scormNorm(getPieceText(el)) === scormNorm(col1Texts[+ls - 1] || ''));
                        if (!(cur && String(cur.className).includes('matched'))) {
                            sendDebug('matching: L' + ls + ' → R' + rs + ' did not land — retrying');
                            const L2 = cur || L;
                            const R2 = Array.from(document.querySelectorAll('li.quiz-match__item--immobile.droppable'))
                                .find(el => scormNorm(getPieceText(el)) === scormNorm(col2Texts[+rs - 1] || '')) || R;
                            if (L2 && R2) { ensureVis(R2); await simulateDrag(L2, R2); await sleep(600); }
                        }
                    }
                }

                // Final pass for quiz-match: any pair still unmatched after the
                // retries gets one last drag before we give up honestly.
                if (col1[0] && String(col1[0].className).includes('quiz-match__item')) {
                    let stuck = 0;
                    for (const [, ls, rs] of pairs) {
                        const cur = Array.from(document.querySelectorAll('li.quiz-match__item--draggable'))
                            .find(el => scormNorm(getPieceText(el)) === scormNorm(col1Texts[+ls - 1] || ''));
                        if (cur && !String(cur.className).includes('matched')) {
                            const R2 = Array.from(document.querySelectorAll('li.quiz-match__item--immobile.droppable'))
                                .find(el => scormNorm(getPieceText(el)) === scormNorm(col2Texts[+rs - 1] || ''));
                            if (R2) { ensureVis(R2); await simulateDrag(cur, R2); await sleep(600); }
                        }
                    }
                    for (const [, ls] of pairs) {
                        const cur = Array.from(document.querySelectorAll('li.quiz-match__item--draggable'))
                            .find(el => scormNorm(getPieceText(el)) === scormNorm(col1Texts[+ls - 1] || ''));
                        if (!(cur && String(cur.className).includes('matched'))) stuck++;
                    }
                    if (stuck) {
                        // 5/6-style wedge: submit stays disabled and a partially
                        // matched card counts as "committed" — it can never be
                        // re-solved. Release so the idle watchdog reports it.
                        releaseFailedQuestion('matching: ' + stuck + ' quiz-match item(s) would not land.', questionId);
                        return;
                    }
                }

                sendStatus('Matched! Submitting...', '#a6e3a1');
                await sleep(1200 + Math.random() * 800);
                if (submitBtn && isVisible(submitBtn)) simulateHumanClick(submitBtn);
                isSolving = false;
        };

        // courseData — MATCHING defs pair answers[].title (term) → matchTitle
        // (descriptor). Deterministic, no AI needed (C1256 confirmed shape).
        const cdPairs = courseDataMatchingPairs(questionId, col1Texts, col2Texts);
        if (cdPairs) {
            sendDebug('matching: courseData pairs resolved (' + cdPairs.length + ')');
            sendStatus('Applying course-data matches...', '#a6e3a1');
            answerSrc[questionId] = 'courseData';
            applyAiText(cdPairs.map(p => `L${p.l},R${p.r}`).join('\n'));
            return;
        }

        // A prior submit already recorded the driver-verified correct pairs.
        const scormPairs = scormMatchingPairs(questionId, col1Texts, col2Texts);
        if (scormPairs) {
            sendDebug('SCORM correct-response hit: ' + scormPairs.length + ' pairs');
            sendStatus('Applying recorded correct matches...', '#a6e3a1');
            answerSrc[questionId] = 'scorm';
            applyAiText(scormPairs.map(p => `L${p.l},R${p.r}`).join('\n'));
            return;
        }

        answerSrc[questionId] = 'ai';
        callOpenRouter(
            'You solve matching quizzes. Output ONLY pairs as L#,R# one per line. No words, no explanations.',
            userMsg,
            0,
            applyAiText
        );
    }


    // =========================================================
    // 10b. DROPDOWN-MATCHING SOLVER — verified against live C3552 DOM.
    // Rows are li.matching-item-immobile: each shows a descriptor and a
    // combobox trigger (button[data-select-trigger], aria-haspopup=listbox).
    // The opened listbox (aria-owns → [data-select-content]) offers the
    // movable TERM list as options: [data-select-item] role=option with
    // data-value = 0-based index into li.matching-item-movable. So each row
    // answers "which term goes with this descriptor".
    // Answer contract for all sources: {l = term index, r = descriptor row index}, 1-based.
    // =========================================================
    async function solveMatchingDropdown(questionId, rows, submitBtn) {
        isSolving = true;
        sendStatus('Analysing dropdown matching...', '#f9e2af');

        const card = (rows[0] && rows[0].closest('.quiz-card, [class*="quiz-card"], .quiz-item__card, .quiz-question')) || document;
        const itemText = el => {
            const t = el.querySelector('.matching-item__text, [data-match-content]');
            return String((t ? t.innerText : el.innerText) || '').replace(/Selectable item/gi, '').replace(/\s+/g, ' ').trim();
        };
        const movables = Array.from(card.querySelectorAll('li.matching-item-movable'));
        const termTexts = movables.map(itemText);   // option pool (numbered)
        const descTexts = rows.map(itemText);       // descriptor per row
        sendDebug(`matching-dd: ${rows.length} descriptor rows, ${termTexts.length} terms (${termTexts.map(t=>t.slice(0,15)).join('|')})`);

        if (!rows.length || !termTexts.length) {
            releaseFailedQuestion('Could not read dropdown-matching rows/terms.', questionId);
            return;
        }

        const pickIdx = (list, text) => {
            const n = scormNorm(text);
            let i = list.findIndex(x => scormNorm(x) === n);
            if (i === -1) i = list.findIndex(x => { const m = scormNorm(x); return m.includes(n) || n.includes(m); });
            return i;
        };

        // Sets one descriptor row to a movable term index (0-based).
        const setRowValue = async (row, termText) => {
            const mi = pickIdx(termTexts, termText);
            if (mi === -1) return false;
            const sel = row.querySelector('select');
            if (sel) {
                // Generic native-select fallback (not seen in Rise, cheap to keep)
                const opt = Array.from(sel.options).find(o => scormNorm(o.textContent) === scormNorm(termText)
                    || o.value === String(mi) || o.textContent.trim() === String(mi + 1));
                if (!opt) return false;
                sel.value = opt.value;
                sel.dispatchEvent(new Event('input', { bubbles: true }));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            const trig = row.querySelector('[data-select-trigger], [role="combobox"], button[aria-haspopup]');
            if (!trig) return false;
            simulateHumanClick(trig);
            await sleep(350);
            const owns = trig.getAttribute('aria-owns') || trig.getAttribute('aria-controls');
            const lb = (owns && document.getElementById(owns)) || row.querySelector('[role="listbox"], [data-select-content]');
            const opts = lb ? Array.from(lb.querySelectorAll('[role="option"], [data-select-item]')) : [];
            const opt = opts.find(o => o.getAttribute('data-value') === String(mi))
                || opts.find(o => (o.getAttribute('aria-labelledby') || '').includes('movable-' + (mi + 1)))
                || opts.find(o => (o.innerText || '').trim() === String(mi + 1));
            if (!opt) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                await sleep(250);
                return false;
            }
            simulateHumanClick(opt);
            await sleep(300);
            return true;
        };

        // pairs: {l = 1-based term index (movable), r = 1-based descriptor row}
        const applyPairs = async (pairs) => {
            const labelLines = pairs.map(p => `${termTexts[p.l - 1] || '?'} ➔ ${descTexts[p.r - 1] || '?'}`);
            const history = loadHistory();
            if (!history[questionId]) {
                history[questionId] = {
                    type: 'matching-dd', course: getCourseName(),
                    left: termTexts, right: descTexts, attempts: []
                };
                saveHistory(history);
            }
            sendMatches(labelLines.join('\n'));
            lastAttempt[questionId] = JSON.stringify(labelLines);
            lastSolvedQuestion = questionId;

            sendStatus(`Setting ${pairs.length} dropdown matches...`, '#89b4fa');
            let failed = 0;
            for (const p of pairs) {
                const ok = await setRowValue(rows[p.r - 1], termTexts[p.l - 1]);
                if (!ok) { failed++; sendDebug(`matching-dd: failed to set "${(descTexts[p.r - 1] || '').slice(0, 35)}" → "${(termTexts[p.l - 1] || '').slice(0, 35)}"`); }
                await sleep(350 + Math.random() * 350);
            }
            if (failed) {
                // Submitting an incompletely-set card loops on "Please answer" —
                // release instead so the retry can re-read the control type.
                releaseFailedQuestion(`matching-dd: ${failed}/${pairs.length} rows wouldn't set.`, questionId);
                return;
            }

            sendStatus('Matched! Submitting...', '#a6e3a1');
            await sleep(1200 + Math.random() * 800);
            if (submitBtn && isVisible(submitBtn)) simulateHumanClick(submitBtn);
            isSolving = false;
        };

        // 1) courseData — answers[] items pair title (term) → matchTitle (descriptor)
        const cdPairs = courseDataMatchingPairs(questionId, termTexts, descTexts);
        if (cdPairs && cdPairs.length) {
            sendDebug('matching-dd: courseData pairs resolved (' + cdPairs.length + ')');
            sendStatus('Applying course matches...', '#a6e3a1');
            answerSrc[questionId] = 'courseData';
            try { await applyPairs(cdPairs); } catch(e) { releaseFailedQuestion('matching-dd apply failed: ' + e.message, questionId); }
            return;
        }

        // 2) SCORM prior-correct responses (src[.]dst = term→descriptor)
        const scormPairs = scormMatchingPairs(questionId, termTexts, descTexts);
        if (scormPairs) {
            sendDebug('matching-dd: SCORM correct-response hit: ' + scormPairs.length + ' pairs');
            sendStatus('Applying recorded correct matches...', '#a6e3a1');
            answerSrc[questionId] = 'scorm';
            try { await applyPairs(scormPairs); } catch(e) { releaseFailedQuestion('matching-dd apply failed: ' + e.message, questionId); }
            return;
        }

        // 3) AI fallback — L# = term, R# = descriptor (same contract)
        let userMsg = `Terms:\n${termTexts.map((t, i) => `L${i + 1}: ${t}`).join('\n')}`
            + `\n\nDescriptors:\n${descTexts.map((d, i) => `R${i + 1}: ${d}`).join('\n')}`;
        const fails = pastFailures[questionId];
        if (fails && fails.size) {
            userMsg += `\n\nWARNING — these exact pairings were already tried and WRONG:\n`;
            for (const f of fails) { try { userMsg += `  - ${JSON.parse(f).join(' | ')}\n`; } catch(e) {} }
        }
        userMsg += `\n\nOutput ONLY pairs as L#,R# one per line. Example:\nL1,R3\nL2,R1\nL3,R2`;

        sendStatus('Asking AI for matches...', '#89b4fa');
        answerSrc[questionId] = 'ai';
        callOpenRouter(
            'You solve matching quizzes. Output ONLY pairs as L#,R# one per line. No words, no explanations.',
            userMsg,
            0,
            async (aiText) => {
                const cleaned = aiText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                const pairs = [...cleaned.matchAll(/L(\d+)\s*[,→\-:]\s*R(\d+)/gi)]
                    .map(m => ({ l: +m[1], r: +m[2] }))
                    .filter(p => p.l >= 1 && p.l <= termTexts.length && p.r >= 1 && p.r <= descTexts.length);
                if (!pairs.length) {
                    releaseFailedQuestion('AI parse fail on dropdown matching.', questionId);
                    return;
                }
                try { await applyPairs(pairs); } catch(e) { releaseFailedQuestion('matching-dd apply failed: ' + e.message, questionId); }
            }
        );
    }


    // =========================================================
    // 10. DRAG SIMULATOR
    // =========================================================
    async function simulateDrag(src, tgt) {
        const handle = src.querySelector('[class*="handle"], [aria-roledescription="sortable"], [data-rbd-drag-handle-draggable-id], svg') || src;
        const sr = handle.getBoundingClientRect(), tr = tgt.getBoundingClientRect();
        const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
        const tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
        const dt = new DataTransfer();
        const p  = (x, y, btns = 0) => ({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y, buttons: btns });
        const m  = (x, y, btns = 0) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: btns });

        handle.dispatchEvent(new PointerEvent('pointerover',  p(sx, sy)));
        handle.dispatchEvent(new PointerEvent('pointerdown',  p(sx, sy, 1)));
        handle.dispatchEvent(new MouseEvent('mousedown',      m(sx, sy, 1)));
        handle.dispatchEvent(new DragEvent('dragstart',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: sx, clientY: sy }));
        await sleep(60);

        for (let i = 1; i <= 12; i++) {
            const cx = sx + (tx - sx) * i / 12, cy = sy + (ty - sy) * i / 12;
            document.dispatchEvent(new PointerEvent('pointermove', p(cx, cy, 1)));
            document.dispatchEvent(new MouseEvent('mousemove',     m(cx, cy, 1)));
            if (i === 12) {
                tgt.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
                tgt.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
            }
            await sleep(20);
        }

        tgt.dispatchEvent(new DragEvent('drop',    { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tx, clientY: ty }));
        document.dispatchEvent(new PointerEvent('pointerup', p(tx, ty, 0)));
        document.dispatchEvent(new MouseEvent('mouseup',     m(tx, ty, 0)));
        handle.dispatchEvent(new DragEvent('dragend',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tx, clientY: ty }));
    }

    // =========================================================
    // 11. NUMBER PARSER
    // =========================================================
    function parseNumbers(text, max) {
        if (!text) return [];
        const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\|thinking\|>[\s\S]*?<\/\|thinking\|>/gi, '').trim();
        for (const line of clean.split('\n').map(l => l.trim()).filter(Boolean)) {
            if (/^[\d,\s]+$/.test(line)) {
                const nums = (line.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= max);
                if (nums.length) return [...new Set(nums)];
            }
        }
        const m = clean.match(/ANSWER[:\s]+([\d,\s]+)/i);
        if (m) {
            const nums = (m[1].match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= max);
            if (nums.length) return [...new Set(nums)];
        }
        const all = (clean.match(/\b\d+\b/g) || []).map(Number).filter(n => n >= 1 && n <= max);
        return [...new Set(all)];
    }

    // =========================================================
    // 12. OPENROUTER
    // =========================================================
    function parseResponse(raw) {
        try {
            const d = JSON.parse(raw);
            if (d.error) return { error: d.error.message };
            if (d.choices?.[0]) return { text: d.choices[0].message?.content?.trim() || '' };
        } catch(_) {}
        let out = '';
        for (const line of raw.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const j = t.slice(5).trim();
            if (j === '[DONE]') continue;
            try {
                const c = JSON.parse(j);
                if (c.error) return { error: c.error.message };
                const d = c.choices?.[0]?.delta?.content;
                if (d) out += d;
            } catch(_) {}
        }
        return { text: out.trim() };
    }

    // Finds the SCORM API object. The content frame's parent is the same-origin
    // CloudFront launcher, which hosts the SCORM driver as a sibling frame.
    function findScormApi() {
        const probe = w => { try { if (w.API_1484_11) return w.API_1484_11; if (w.API) return w.API; } catch(e) {} return null; };
        try {
            // The launcher hosts API_1484_11 on its own window — an ancestor of
            // the content frame, not its parent. Walk up (like the driver's own
            // SCORM2004_ScanParentsForApi), scanning each level's child frames.
            let w = window;
            for (let depth = 0; depth < 20 && w; depth++) {
                let hit = probe(w);
                if (hit) return hit;
                try {
                    for (let i = 0; i < w.frames.length; i++) {
                        hit = probe(w.frames[i]);
                        if (hit) return hit;
                    }
                } catch(e) {}
                if (!w.parent || w.parent === w) break;
                w = w.parent;
            }
        } catch(e) {}
        return null;
    }
    function scormGet(api, n) { try { return api.GetValue(n); } catch(e) { try { return api.LMSGetValue(n); } catch(e2) { return ''; } } }

    // Best-effort read of what the player actually wrote to the LMS, for the
    // quiz-passed report.
    function readScormSummary() {
        const api = findScormApi();
        if (!api) return null;
        return {
            completion: scormGet(api, 'cmi.completion_status') || scormGet(api, 'cmi.core.lesson_status'),
            success:    scormGet(api, 'cmi.success_status'),
            score:      scormGet(api, 'cmi.score.scaled') || scormGet(api, 'cmi.core.score.raw')
        };
    }

    // ── SCORM-verified answers ─────────────────────────────────────────
    // Every submitted question writes cmi.interactions.N.correct_responses.0.pattern
    // (e.g. "urn:scormdriver:Lower-cost"). On a Take Again retry the correct
    // answer is already recorded — apply it directly instead of asking the AI.
    const scormNorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const scormNormQuestion = s => scormNorm(String(s || '').replace(
        /^\s*(true\s*[/ ]?\s*(?:or\s*[/ ]?\s*)?false|multiple\s*choice|multiple\s*response|select\s*all\s*that\s*apply|fill\s*in\s*the\s*blank|matching)\s*[:.\-–—]?\s*/i, ''));

    function findPriorInteraction(qId) {
        const api = findScormApi();
        if (!api) return null;
        const count = parseInt(scormGet(api, 'cmi.interactions._count'), 10);
        if (!count || count > 400) return null;
        const target = scormNormQuestion(qId);
        if (!target) return null;
        for (let i = count - 1; i >= 0; i--) {   // latest attempt wins
            const desc = scormNormQuestion(scormGet(api, `cmi.interactions.${i}.description`));
            if (desc && (desc === target || desc.includes(target) || target.includes(desc))) {
                const pattern = scormGet(api, `cmi.interactions.${i}.correct_responses.0.pattern`);
                if (pattern) return { pattern, type: scormGet(api, `cmi.interactions.${i}.type`), index: i };
            }
        }
        return null;
    }

    const scormPatternParts = pattern =>
        String(pattern).split('[,]').map(s => {
            let p = s.trim().replace(/^urn:scormdriver:/i, '');
            // scormdriver percent-encodes multi-word answers
            // ("High%20THC%20Potency") — decode or the text match fails.
            try { p = decodeURIComponent(p); } catch (e) {}
            return p;
        }).filter(Boolean);

    // MCQ: map each pattern part to an option index (1-based). Text-normalized,
    // so it survives option reshuffling between attempts.
    function scormAnswerNums(qId, plainOpts) {
        const hit = findPriorInteraction(qId);
        if (!hit) return null;
        const nums = [];
        for (const p of scormPatternParts(hit.pattern)) {
            const idx = plainOpts.findIndex(o => scormNorm(o) === scormNorm(p));
            if (idx === -1) return null;
            nums.push(idx + 1);
        }
        return nums.length ? nums : null;
    }

    // Rise ships the full course model to the client as base64 JSON on
    // window.courseData — including each quiz question's correct answers.
    // Deterministic ground truth that works on attempt 1 (the driver's
    // correct_responses readback returns "" on this platform).
    let _quizDefs = null;
    let _cdFetchStarted = false;
    // Sorting-block answer key: model item id -> pile title. Populated by the
    // same model walk as quizDefs (shape confirmed live on C1256:
    // {items:[{id,title,pileId}], piles:[{id,title}], variant:"sorting"}).
    let _sortingKey = null;
    function quizDefs() {
        if (_quizDefs) return _quizDefs;
        _quizDefs = [];
        const walk = o => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o.answers) && o.answers.length && (o.correct || (Array.isArray(o.corrects) && o.corrects.length))) {
                _quizDefs.push(o);
            } else {
                const titleish = o.title || o.prompt || o.question || o.stem;
                if (titleish && ((Array.isArray(o.pairs) && o.pairs.length) || /match/i.test(String(o.type || '')))) {
                    // Matching defs keep correct pairings outside answers/correct
                    // (pairs[] or a matching-typed object — shape varies by build).
                    _quizDefs.push(o);
                }
            }
            if (Array.isArray(o.items) && o.items.length && Array.isArray(o.piles) && o.piles.length
                && o.items.every(it => it && it.id != null && it.pileId != null)
                && o.piles.every(p => p && p.id != null && p.title != null)) {
                if (!_sortingKey) _sortingKey = {};
                const names = {};
                for (const p of o.piles) names[String(p.id)] = String(p.title).replace(/<[^>]+>/g, '').trim();
                for (const it of o.items) {
                    const n = names[String(it.pileId)];
                    if (it.id != null && n) _sortingKey[it.id] = n;
                }
            }
            for (const k in o) walk(o[k]);
        };
        try {
            // Userscripts run in a sandbox: page globals live on unsafeWindow.
            // Fallback: the courseData = "..." assignment is inline in the DOM.
            let raw = '';
            try { raw = (typeof unsafeWindow !== 'undefined' && unsafeWindow.courseData) || ''; } catch(e) {}
            if (!raw) raw = window.courseData || '';
            if (!raw) {
                const m = document.documentElement.innerHTML.match(/courseData\s*=\s*"([A-Za-z0-9+/=_-]{100,})"/);
                if (m) raw = m[1];
            }
            if (typeof raw === 'string' && raw.length > 100) {
                const text = raw[0] === '{' ? raw
                    : new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0)));
                walk(JSON.parse(text));
            } else if (!_cdFetchStarted) {
                // Newer Rise builds (C1012) have no courseData global — the model
                // loads via __fetchCourse(locale) → locales/*.js JSONP. Async, so
                // defs populate for the next question, not this one.
                _cdFetchStarted = true;
                try {
                    const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
                    if (typeof win.__fetchCourse === 'function') {
                        win.__fetchCourse().then(cd => { _quizDefs = []; walk(cd); }).catch(() => {});
                    }
                } catch(e) {}
            }
        } catch(e) {}
        return _quizDefs;
    }

    const htmlText = s => { const d = document.createElement('div'); d.innerHTML = String(s || ''); return d.textContent || ''; };

    // Maps the rendered question to the course model's correct answers, then to
    // 1-based option indices. MULTIPLE_RESPONSE uses `corrects` (the full set);
    // single-choice uses `correct` — its `corrects` list can hold alternates.
    function courseDataAnswerNums(qId, plainOpts) {
        const target = scormNormQuestion(qId);
        if (!target) return null;
        for (const q of quizDefs()) {
            const t = scormNormQuestion(htmlText(q.title));
            if (!t || !(t === target || t.includes(target) || target.includes(t))) continue;
            const ids = (q.type === 'MULTIPLE_RESPONSE' && Array.isArray(q.corrects) && q.corrects.length)
                ? q.corrects : [q.correct];
            const nums = [];
            for (const id of ids) {
                const ans = (q.answers || []).find(a => a.id === id);
                if (!ans) { nums.length = 0; break; }
                const idx = plainOpts.findIndex(o => scormNorm(o) === scormNorm(htmlText(ans.title)));
                if (idx === -1) { nums.length = 0; break; }
                nums.push(idx + 1);
            }
            if (nums.length) return nums;
        }
        return null;
    }

    // Fill-in-the-blank: first acceptable alternative. Driver escapes spaces as
    // hyphens in the pattern.
    function scormAnswerText(qId) {
        const hit = findPriorInteraction(qId);
        if (!hit) return null;
        const parts = scormPatternParts(hit.pattern);
        return parts[0] ? parts[0].replace(/-/g, ' ') : null;
    }

    // Matching: pattern is "src[.]dst[,]src[.]dst..." → {l, r} index pairs.
    function scormMatchingPairs(qId, col1Texts, col2Texts) {
        const hit = findPriorInteraction(qId);
        if (!hit) return null;
        const pairs = [];
        for (const p of scormPatternParts(hit.pattern)) {
            const seg = p.split('[.]');
            if (seg.length !== 2) return null;
            const l = col1Texts.findIndex(t => scormNorm(t) === scormNorm(seg[0]));
            const r = col2Texts.findIndex(t => scormNorm(t) === scormNorm(seg[1]));
            if (l === -1 || r === -1) return null;
            pairs.push({ l: l + 1, r: r + 1 });
        }
        return pairs.length ? pairs : null;
    }

    // Course-model matching pairs → {l, r} 1-based indices over the rendered
    // term/descriptor lists. `pairs` entries vary by Rise build, so each side
    // is read through flexible key names; values may be strings or objects.
    function courseDataMatchingPairs(qId, termTexts, descTexts) {
        const target = scormNormQuestion(qId);
        if (!target) return null;
        const sideText = (p, keys) => {
            for (const k of keys) {
                const v = p && p[k];
                if (typeof v === 'string' && v.trim()) return v;
                if (v && typeof v === 'object') {
                    const s = v.title || v.text || v.label || v.value;
                    if (typeof s === 'string' && s.trim()) return s;
                }
            }
            return null;
        };
        for (const q of quizDefs()) {
            const t = scormNormQuestion(htmlText(q.title || q.prompt || q.question || q.stem || ''));
            if (!t || !(t === target || t.includes(target) || target.includes(t))) continue;
            // Confirmed Rise shape (C3552): type:"MATCHING" carries no pairs[] —
            // answers[] holds {title: <term>, matchTitle: <descriptor>}. Checked
            // first so a stray items/responses array can't shadow it.
            if (Array.isArray(q.answers) && q.answers.length
                && q.answers.some(a => a && typeof a.matchTitle === 'string')) {
                const pairs = [];
                for (const a of q.answers) {
                    const li = termTexts.findIndex(x => scormNorm(x) === scormNorm(htmlText(a.title || '')));
                    const ri = descTexts.findIndex(x => scormNorm(x) === scormNorm(htmlText(a.matchTitle || '')));
                    if (li === -1 || ri === -1) return null;
                    pairs.push({ l: li + 1, r: ri + 1 });
                }
                if (pairs.length) return pairs;
            }
            // The pair list may live under several keys depending on the build.
            const pairArr = [q.pairs, q.matches, q.matchings, q.responses, q.items]
                .find(a => Array.isArray(a) && a.length && typeof a[0] === 'object');
            if (pairArr) {
                const pairs = [];
                for (const p of pairArr) {
                    const l = sideText(p, ['left', 'source', 'prompt', 'term', 'question', 'a', 'first']);
                    const r = sideText(p, ['right', 'target', 'response', 'match', 'answer', 'b', 'second']);
                    if (!l || !r) { sendDebug('matching-dd pair shape unknown: ' + Object.keys(p || {}).join(',')); return null; }
                    const li = termTexts.findIndex(x => scormNorm(x) === scormNorm(htmlText(l)));
                    const ri = descTexts.findIndex(x => scormNorm(x) === scormNorm(htmlText(r)));
                    if (li === -1 || ri === -1) return null;
                    pairs.push({ l: li + 1, r: ri + 1 });
                }
                if (pairs.length) return pairs;
            }
            sendDebug('matching-dd def keys: ' + Object.keys(q).slice(0, 15).join(','));
            return null;
        }
        // No title match — dump what defs exist so the next DIAG shows the shape.
        sendDebug('matching-dd: no def matched "' + target.slice(0, 30) + '"; defs: '
            + quizDefs().map(q => String(q.title || q.prompt || q.question || q.stem || '?').slice(0, 24)).join(' | ').slice(0, 300));
        return null;
    }

    // Releases a question whose AI solve failed so Priority A can retry it.
    // Bounded: after 3 failures the question stays in `attempted` and the
    // stall pipeline reports it instead of retrying forever.
    function releaseFailedQuestion(statusMsg, qid) {
        const id = qid || activeSolveQId;
        if (id) {
            const n = (quizSolveFails[id] || 0) + 1;
            quizSolveFails[id] = n;
            if (n < 3) {
                attempted.delete(id);
                sendDebug(`AI solve failed for ${id.substring(0, 20)} (${n}/3). Will retry.`);
            } else {
                sendDebug(`AI solve failed 3x for ${id.substring(0, 20)}. Not retrying.`);
            }
        }
        if (activeSolveQId === id) activeSolveQId = null;
        isSolving = false;
        nextActionTime = Date.now() + 6000;
        sendStatus(statusMsg, '#f38ba8');
    }

    function callOpenRouter(sysMsg, userMsg, modelIdx, onSuccess, retry = 0) {
        const apiKey = getOpenRouterApiKey();
        if (!apiKey) {
            if (activeSolveQId) { attempted.delete(activeSolveQId); activeSolveQId = null; }
            isSolving = false;
            sendStatus('Set an OpenRouter key with KEY, then press RESUME.', '#f38ba8');
            try { window.top.postMessage({ type: 'SEED_PAUSE_REQ' }, '*'); } catch(e) {}
            return;
        }
        const model = MODELS[modelIdx] || MODELS[0];
        const modelTag = model.id.split('/').pop().replace(':free', '');
        sendStatus(retry > 0 ? `Retrying AI (${retry}/3)...` : `Asking AI (${modelTag})...`, '#89b4fa');

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://openrouter.ai/api/v1/chat/completions',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer':  window.location.origin,
                'X-Title':       'Seed Talent Helper'
            },
            data: JSON.stringify({
                model: model.id,
                messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }],
                max_tokens: model.maxTok,
                temperature: 0
            }),
            timeout: 30000,
            onload(res) {
                const r = parseResponse(res.responseText);
                if (r.error || !r.text) {
                    const err = String(r.error || 'empty').toLowerCase();
                    sendDebug('AI error: ' + err);
                    const retryable = err.includes('overloaded') || err.includes('503') || err.includes('too many') || err.includes('rate') || err.includes('empty');
                    if (retry < 3 && retryable) { setTimeout(() => callOpenRouter(sysMsg, userMsg, modelIdx, onSuccess, retry + 1), 3000 * (retry + 1)); return; }
                    if (modelIdx + 1 < MODELS.length) { callOpenRouter(sysMsg, userMsg, modelIdx + 1, onSuccess, 0); return; }
                    releaseFailedQuestion('AI unavailable. Please refresh.');
                    return;
                }
                try {
                    const p = onSuccess(r.text);
                    if (p && typeof p.catch === 'function') p.catch(err => { sendDebug('Solver error: ' + err); releaseFailedQuestion('Solver error.'); });
                } catch (err) {
                    sendDebug('Solver error: ' + err);
                    releaseFailedQuestion('Solver error.');
                }
            },
            onerror()  {
                if (retry < 3) { setTimeout(() => callOpenRouter(sysMsg, userMsg, modelIdx, onSuccess, retry + 1), 3000); return; }
                if (modelIdx + 1 < MODELS.length) { callOpenRouter(sysMsg, userMsg, modelIdx + 1, onSuccess, 0); return; }
                releaseFailedQuestion('Network error.');
            },
            ontimeout() {
                if (retry < 3) { setTimeout(() => callOpenRouter(sysMsg, userMsg, modelIdx, onSuccess, retry + 1), 3000); return; }
                if (modelIdx + 1 < MODELS.length) { callOpenRouter(sysMsg, userMsg, modelIdx + 1, onSuccess, 0); return; }
                releaseFailedQuestion('AI timed out.');
            }
        });
    }

    // =========================================================
    // 13. NETWORK SNIFFER — captures the API calls that mark progress.
    //     Toggle 📡 SNIFF in the panel, manually complete a section,
    //     then ⬇ DUMP to download the captured requests as JSON.
    // =========================================================
    function __seedSnifferPage() {
        const origFetch = window.fetch;
        window.fetch = async function() {
            const args = arguments;
            let url = '', method = 'GET', reqBody = null;
            try {
                if (typeof args[0] === 'string') {
                    url = args[0]; method = (args[1] && args[1].method) || 'GET';
                    reqBody = args[1] && args[1].body;
                } else {
                    url = args[0].url; method = args[0].method || 'GET';
                    reqBody = await args[0].clone().text().catch(function(){ return null; });
                }
            } catch(e) {}
            const resp = await origFetch.apply(this, args);
            try {
                const clone = resp.clone();
                const ct = clone.headers.get('content-type') || '';
                const entry = { frame: location.href, method: method, url: String(url), status: resp.status,
                                reqBody: reqBody ? String(reqBody).slice(0, 40000) : null, respBody: null };
                if (ct.indexOf('json') > -1 || ct.indexOf('text') > -1 || ct.indexOf('xml') > -1) {
                    entry.respBody = (await clone.text()).slice(0, 40000);
                }
                window.postMessage({ type: 'SEED_SNIFF_ENTRY', entry: entry }, '*');
            } catch(e) {}
            return resp;
        };
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(m, u) {
            this.__sm = { m: m, u: u };
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(b) {
            const meta = this.__sm, xhr = this;
            if (meta) xhr.addEventListener('loadend', function() {
                try {
                    let rb = null;
                    if (!xhr.responseType || xhr.responseType === 'text') rb = String(xhr.responseText).slice(0, 40000);
                    else if (xhr.responseType === 'json') rb = JSON.stringify(xhr.response).slice(0, 40000);
                    window.postMessage({ type: 'SEED_SNIFF_ENTRY', entry: {
                        frame: location.href, method: meta.m, url: String(meta.u), status: xhr.status,
                        reqBody: b ? String(b).slice(0, 40000) : null, respBody: rb
                    }}, '*');
                } catch(e) {}
            });
            return origSend.apply(this, arguments);
        };

        // SCORM API call sniffing — SetValue/Commit are plain JS calls (not network),
        // so hook the API object itself. It may not exist yet at document-start; poll for it.
        const scormEntry = function(label, el, val, resp) {
            try {
                window.postMessage({ type: 'SEED_SNIFF_ENTRY', entry: {
                    frame: location.href, method: 'SCORM',
                    url: 'scorm://' + label + '/' + (el || ''),
                    status: 0, reqBody: val != null ? String(val).slice(0, 40000) : null,
                    respBody: resp != null ? String(resp).slice(0, 40000) : null
                }}, '*');
            } catch(e) {}
        };
        const apiPoll = setInterval(function() {
            const api = window.API_1484_11 || window.API;
            if (!api) return;
            clearInterval(apiPoll);
            const wrapCall = function(fn, hasEl, hasVal, retIsResp) {
                if (typeof api[fn] !== 'function') return;
                const orig = api[fn];
                api[fn] = function() {
                    const a = arguments;
                    const r = orig.apply(this, a);
                    try { scormEntry(fn, hasEl ? a[0] : fn, hasVal ? a[1] : null, retIsResp ? r : null); } catch(e) {}
                    return r;
                };
            };
            // SCORM 2004
            wrapCall('SetValue', true, true, false);
            wrapCall('GetValue', true, false, true);
            wrapCall('Commit', false, false, false);
            wrapCall('Terminate', false, false, false);
            // SCORM 1.2
            wrapCall('LMSSetValue', true, true, false);
            wrapCall('LMSGetValue', true, false, true);
            wrapCall('LMSCommit', false, false, false);
            wrapCall('LMSFinish', false, false, false);
            scormEntry('API_FOUND', window.API_1484_11 ? 'SCORM_2004' : 'SCORM_1.2', null, null);
        }, 500);
        setTimeout(function(){ clearInterval(apiPoll); }, 120000);
    }

    // Inject hooks into PAGE context (the userscript sandbox's window.fetch isn't the page's)
    try {
        const snifferScript = document.createElement('script');
        snifferScript.textContent = '(' + __seedSnifferPage.toString() + ')();';
        (document.documentElement || document.head || document.body).appendChild(snifferScript);
        setTimeout(function(){ try { snifferScript.remove(); } catch(e){} }, 1000);
    } catch(e) {}

    // Relay page-context entries up to the top frame (only when enabled)
    window.addEventListener('message', (e) => {
        if (!e.data) return;
        if (e.data.type === 'SEED_SNIFF_SET') {
            sniffOn = !!e.data.on;
            // Forward deeper so nested iframes get the toggle too
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'SEED_SNIFF_SET', on: sniffOn }, '*'); } catch(_) {}
            });
        }
        if (e.data.type === 'SEED_DIAG_REQ') {
            try { GM_setValue(diagKey, JSON.stringify(buildDiag())); } catch(_) {}
            // Relay deeper so nested frames also snapshot
            document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ type: 'SEED_DIAG_REQ' }, '*'); } catch(_) {}
            });
        }
        if (e.data.type === 'SEED_SNIFF_ENTRY' && sniffOn) {
            try { window.top.postMessage({ type: 'SEED_SNIFF_AGG', entry: e.data.entry }, '*'); } catch(_) {}
        }
    });

    // Top frame: aggregate entries, filter static assets, surface in debug line
    if (window === window.top) {
        const STATIC_RE = /\.(css|js|png|jpe?g|gif|svg|woff2?|ttf|mp4|webm|mp3|ico)(\?|#|$)/i;
        window.addEventListener('message', (e) => {
            if (!e.data || e.data.type !== 'SEED_SNIFF_AGG') return;
            const en = e.data.entry;
            if (!en || STATIC_RE.test(en.url)) return;
            sniffEntries.push(en);
            if (sniffEntries.length > 2000) sniffEntries.shift();
            sendDebug('[SNIFF] ' + en.method + ' ' + en.status + ' ' + String(en.url).slice(0, 110));
        });
    }

})();
