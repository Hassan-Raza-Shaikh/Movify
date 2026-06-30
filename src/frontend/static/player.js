/* =====================================================
   Nautilus Player — Custom HTML5 Video Player
   Movie-web / sudo-flix inspired, built from scratch
   ===================================================== */

// ─── Player Preferences (localStorage) ───
const PREFS_KEY = 'nautilus_player_prefs';

function getPlayerPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return {};
        return JSON.parse(raw);
    } catch { return {}; }
}

function setPlayerPrefs(updates) {
    const prefs = { ...getPlayerPrefs(), ...updates };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return prefs;
}

// ─── Subtitle Parser (SRT/VTT/MicroDVD/ASS → cue array) ───
function parseSubtitles(text) {
    if (!text) return [];
    // Normalize line endings
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const trimmed = text.trim();

    // Detect MicroDVD format: lines like {start_frame}{end_frame}text
    if (/^\{\d+\}\{\d+\}/.test(trimmed)) {
        return _parseMicroDVD(trimmed);
    }
    // Detect ASS/SSA format
    if (trimmed.startsWith('[Script Info]') || trimmed.includes('Format:') && trimmed.includes('Dialogue:')) {
        return _parseASS(trimmed);
    }
    // Standard SRT/VTT parsing
    return _parseSrtVtt(trimmed);
}

function _parseMicroDVD(text) {
    const cues = [];
    const fps = 23.976; // Standard film framerate
    const lines = text.split('\n');
    for (const line of lines) {
        const m = line.match(/^\{(\d+)\}\{(\d+)\}(.+)/);
        if (!m) continue;
        const start = parseInt(m[1]) / fps;
        const end = parseInt(m[2]) / fps;
        let txt = m[3].replace(/\|/g, '\n').replace(/\{[^}]*\}/g, '').trim();
        if (txt) cues.push({ start, end, text: txt });
    }
    return cues;
}

function _parseASS(text) {
    const cues = [];
    const lines = text.split('\n');
    for (const line of lines) {
        const m = line.match(/^Dialogue:\s*\d+,(\d+):(\d{2}):(\d{2})\.(\d{2}),(\d+):(\d{2}):(\d{2})\.(\d{2}),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)/);
        if (!m) continue;
        const start = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) + parseInt(m[4])/100;
        const end = parseInt(m[5])*3600 + parseInt(m[6])*60 + parseInt(m[7]) + parseInt(m[8])/100;
        let txt = m[m.length-1].replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').trim();
        if (txt) cues.push({ start, end, text: txt });
    }
    return cues;
}

function _parseSrtVtt(text) {
    const cues = [];
    const lines = text.split('\n');
    let i = 0;
    // Skip WebVTT header
    if (lines[0] && lines[0].trim().startsWith('WEBVTT')) {
        i = 1;
        while (i < lines.length && lines[i].trim() !== '') i++;
    }
    while (i < lines.length) {
        // Skip blank lines and cue numbers
        while (i < lines.length && (!lines[i].trim() || /^\d+$/.test(lines[i].trim()))) i++;
        if (i >= lines.length) break;
        // Timestamp line
        const tsMatch = lines[i].match(/(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})/);
        if (!tsMatch) { i++; continue; }
        const startH = tsMatch[1] ? parseInt(tsMatch[1]) : 0;
        const startM = parseInt(tsMatch[2]);
        const startS = parseInt(tsMatch[3]);
        const startMs = parseInt(tsMatch[4]);
        const endH = tsMatch[5] ? parseInt(tsMatch[5]) : 0;
        const endM = parseInt(tsMatch[6]);
        const endS = parseInt(tsMatch[7]);
        const endMs = parseInt(tsMatch[8]);
        const start = startH * 3600 + startM * 60 + startS + startMs / 1000;
        const end = endH * 3600 + endM * 60 + endS + endMs / 1000;
        i++;
        // Collect text lines until blank line
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
            textLines.push(lines[i].trim());
            i++;
        }
        if (textLines.length > 0) {
            cues.push({ start, end, text: textLines.join('\n') });
        }
    }
    return cues;
}

// ─── NautilusPlayer Class ───
class NautilusPlayer {
    constructor(containerEl) {
        this.container = containerEl;
        this.video = null;
        this.hls = null;
        this.cues = [];
        this.currentCueIdx = -1;
        this.subtitleDelay = 0;
        this.hideControlsTimer = null;
        this.isPlaying = false;
        this.isDragging = false;
        this.settingsOpen = false;
        this.sourcesPanelOpen = false;

        // Current state
        this.currentSource = null;  // { source, embed, stream }
        this.allSources = [];       // All hunted streams
        this.mediaTitle = '';
        this.onCloseCallback = null;

        // Preferences
        const prefs = getPlayerPrefs();
        this.volume = prefs.volume ?? 1.0;
        this.autoplaySubtitles = prefs.autoplaySubtitles ?? true;
        this.preferredQuality = prefs.preferredQuality ?? 'auto';
        this.subtitleSize = prefs.subtitleSize ?? 1.0;
        this.subtitleBgOpacity = prefs.subtitleBgOpacity ?? 0.75;
        this.subtitleBold = prefs.subtitleBold ?? false;
        this.subtitleColor = prefs.subtitleColor ?? '#ffffff';

        this._build();
        this._bindEvents();
    }

    // ─── Build DOM ───
    _build() {
        this.container.innerHTML = '';
        this.container.className = 'naut-player';

        // Video element
        this.video = document.createElement('video');
        this.video.playsInline = true;
        this.video.preload = 'auto';
        this.container.appendChild(this.video);

        // Click target
        this.clickTarget = this._el('div', 'click-target');
        this.container.appendChild(this.clickTarget);

        // Center play button
        this.centerPlay = this._el('div', 'naut-center-play');
        this.centerPlay.innerHTML = '<i class="fa-solid fa-play"></i>';
        this.container.appendChild(this.centerPlay);

        // Loading spinner
        this.loadingEl = this._el('div', 'naut-loading');
        this.loadingEl.innerHTML = '<div class="naut-spinner"></div>';
        this.container.appendChild(this.loadingEl);

        // Title bar
        this.titleBar = this._el('div', 'naut-title-bar');
        this.titleBar.innerHTML = `
            <button class="naut-back-btn" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
            <span class="naut-title-text"></span>
        `;
        this.container.appendChild(this.titleBar);

        // Source badge (top-right)
        this.sourceBadge = this._el('div', 'naut-source-badge');
        this.container.appendChild(this.sourceBadge);

        // Subtitle layer
        this.subtitleLayer = this._el('div', 'naut-subtitle-layer');
        this.container.appendChild(this.subtitleLayer);

        // Controls
        this.controls = this._el('div', 'naut-controls');
        this.controls.innerHTML = `
            <div class="naut-progress-wrap">
                <div class="naut-progress-bar">
                    <div class="naut-progress-buffered"></div>
                    <div class="naut-progress-played"></div>
                    <div class="naut-progress-thumb"></div>
                </div>
                <div class="naut-progress-tooltip">0:00</div>
            </div>
            <div class="naut-btn-row">
                <div class="naut-btn-left">
                    <button class="naut-ctrl-btn play-pause-btn" title="Play/Pause"><i class="fa-solid fa-play"></i></button>
                    <button class="naut-ctrl-btn skip-back-btn" title="Rewind 10s"><i class="fa-solid fa-rotate-left"></i></button>
                    <button class="naut-ctrl-btn skip-fwd-btn" title="Forward 10s"><i class="fa-solid fa-rotate-right"></i></button>
                    <div class="naut-vol-wrap">
                        <button class="naut-ctrl-btn vol-btn" title="Volume"><i class="fa-solid fa-volume-high"></i></button>
                        <div class="naut-vol-slider"><input type="range" min="0" max="1" step="0.05" value="1"></div>
                    </div>
                    <span class="naut-time"><span class="time-current">0:00</span> / <span class="time-duration">0:00</span></span>
                </div>
                <div class="naut-btn-right">
                    <button class="naut-ctrl-btn cc-btn" title="Subtitles"><i class="fa-solid fa-closed-captioning"></i></button>
                    <button class="naut-ctrl-btn sources-btn" title="Sources"><i class="fa-solid fa-server"></i></button>
                    <button class="naut-ctrl-btn settings-btn" title="Settings"><i class="fa-solid fa-gear"></i></button>
                    <button class="naut-ctrl-btn pip-btn" title="Picture-in-Picture"><i class="fa-solid fa-clone"></i></button>
                    <button class="naut-ctrl-btn fs-btn" title="Fullscreen"><i class="fa-solid fa-expand"></i></button>
                </div>
            </div>
        `;
        this.container.appendChild(this.controls);

        // Settings panel
        this.settingsPanel = this._el('div', 'naut-settings-panel');
        this.container.appendChild(this.settingsPanel);

        // Source selection panel
        this.sourcePanel = this._el('div', 'naut-source-panel');
        this.container.appendChild(this.sourcePanel);

        // Cache refs
        this.progressWrap = this.controls.querySelector('.naut-progress-wrap');
        this.progressBar = this.controls.querySelector('.naut-progress-bar');
        this.progressPlayed = this.controls.querySelector('.naut-progress-played');
        this.progressBuffered = this.controls.querySelector('.naut-progress-buffered');
        this.progressThumb = this.controls.querySelector('.naut-progress-thumb');
        this.progressTooltip = this.controls.querySelector('.naut-progress-tooltip');
        this.playPauseBtn = this.controls.querySelector('.play-pause-btn');
        this.timeCurrent = this.controls.querySelector('.time-current');
        this.timeDuration = this.controls.querySelector('.time-duration');
        this.volBtn = this.controls.querySelector('.vol-btn');
        this.volSlider = this.controls.querySelector('.naut-vol-slider input');
        this.ccBtn = this.controls.querySelector('.cc-btn');
        this.sourcesBtn = this.controls.querySelector('.sources-btn');
        this.settingsBtn = this.controls.querySelector('.settings-btn');
        this.pipBtn = this.controls.querySelector('.pip-btn');
        this.fsBtn = this.controls.querySelector('.fs-btn');
        this.backBtn = this.titleBar.querySelector('.naut-back-btn');
        this.titleText = this.titleBar.querySelector('.naut-title-text');
    }

    _el(tag, cls) {
        const el = document.createElement(tag);
        el.className = cls;
        return el;
    }

    // ─── Event Bindings ───
    _bindEvents() {
        const v = this.video;

        // Play/Pause
        this.clickTarget.addEventListener('click', () => this.togglePlay());
        this.clickTarget.addEventListener('dblclick', () => this.toggleFullscreen());
        this.playPauseBtn.addEventListener('click', () => this.togglePlay());

        // Skip
        this.controls.querySelector('.skip-back-btn').addEventListener('click', () => {
            v.currentTime = Math.max(0, v.currentTime - 10);
        });
        this.controls.querySelector('.skip-fwd-btn').addEventListener('click', () => {
            v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
        });

        // Volume
        this.volBtn.addEventListener('click', () => {
            v.muted = !v.muted;
            this._updateVolumeIcon();
        });
        this.volSlider.value = this.volume;
        v.volume = this.volume;
        this.volSlider.addEventListener('input', () => {
            v.volume = parseFloat(this.volSlider.value);
            v.muted = false;
            this.volume = v.volume;
            setPlayerPrefs({ volume: this.volume });
            this._updateVolumeIcon();
        });

        // Progress bar interactions
        this.progressWrap.addEventListener('mousedown', (e) => this._startSeek(e));
        this.progressWrap.addEventListener('touchstart', (e) => this._startSeek(e), { passive: true });
        this.progressWrap.addEventListener('mousemove', (e) => this._showTooltip(e));

        // Video events
        v.addEventListener('play', () => {
            this.isPlaying = true;
            this.playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            this.centerPlay.classList.remove('visible');
            this._startHideTimer();
        });
        v.addEventListener('pause', () => {
            this.isPlaying = false;
            this.playPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            this.centerPlay.innerHTML = '<i class="fa-solid fa-play"></i>';
            this.centerPlay.classList.add('visible');
            this._showControls();
        });
        v.addEventListener('timeupdate', () => this._onTimeUpdate());
        v.addEventListener('progress', () => this._onBufferUpdate());
        v.addEventListener('loadedmetadata', () => {
            this.timeDuration.textContent = this._formatTime(v.duration);
            this.loadingEl.classList.remove('visible');
            clearTimeout(this._loadTimeout);
        });
        v.addEventListener('waiting', () => this.loadingEl.classList.add('visible'));
        v.addEventListener('canplay', () => {
            this.loadingEl.classList.remove('visible');
            clearTimeout(this._loadTimeout);
        });
        v.addEventListener('ended', () => {
            this.centerPlay.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
            this.centerPlay.classList.add('visible');
            this._maybeRecordProgress(true);   // mark watched
            // Auto-advance to the next episode for TV
            if (this._subCtx && this._subCtx.type === 'tv' && typeof window.nautilusAutoNext === 'function') {
                window.nautilusAutoNext();
            }
        });

        // Fullscreen
        this.fsBtn.addEventListener('click', () => this.toggleFullscreen());
        document.addEventListener('fullscreenchange', () => this._updateFsIcon());

        // PiP
        this.pipBtn.addEventListener('click', () => this.togglePiP());

        // CC
        this.ccBtn.addEventListener('click', () => this._toggleSubtitles());

        // Sources panel
        this.sourcesBtn.addEventListener('click', () => this._toggleSourcesPanel());

        // Settings
        this.settingsBtn.addEventListener('click', () => this._toggleSettings());

        // Back button
        this.backBtn.addEventListener('click', () => {
            if (this.onCloseCallback) this.onCloseCallback();
        });

        // Mouse movement for controls visibility
        this.container.addEventListener('mousemove', () => {
            this._showControls();
            this._startHideTimer();
        });
        this.container.addEventListener('mouseleave', () => {
            if (this.isPlaying) this._startHideTimer(800);
        });

        // Touch support
        this.container.addEventListener('touchstart', () => {
            this._showControls();
            this._startHideTimer(3000);
        }, { passive: true });

        // Keyboard shortcuts
        this.container.setAttribute('tabindex', '0');
        this.container.addEventListener('keydown', (e) => this._onKeyDown(e));
    }

    // ─── Public API ───
    loadStream(data, allSources = []) {
        this.currentSource = data;
        this.allSources = allSources;
        const stream = data.stream;
        if (!stream) return;

        // Update source badge
        const label = data.embed ? `${data.source} → ${data.embed}` : data.source;
        this.sourceBadge.textContent = label;

        // Destroy existing HLS
        if (this.hls) { this.hls.destroy(); this.hls = null; }

        // Reset loading spinner (in case _showError replaced innerHTML)
        this.loadingEl.innerHTML = '<div class="naut-spinner"></div>';
        this.loadingEl.classList.add('visible');

        // Timeout: if nothing loads within 20s, try next source
        clearTimeout(this._loadTimeout);
        this._loadTimeout = setTimeout(() => {
            if (this.loadingEl.classList.contains('visible') && !this.isPlaying) {
                console.warn('[Player] Load timeout, trying next source');
                if (this.hls) { this.hls.destroy(); this.hls = null; }
                this._tryNextSource();
            }
        }, 20000);

        console.log(`[Player] Loading ${stream.type} stream from ${label}`, stream.playlist || stream.qualities);

        if (stream.type === 'hls' && stream.playlist) {
            this._loadHLS(stream);
        } else if (stream.type === 'file' && stream.qualities?.length) {
            this._loadFile(stream);
        } else {
            console.warn('[Player] Unknown/invalid stream type:', stream.type, stream);
            this._tryNextSource();
            return;
        }

        // Subtitles
        this.cues = [];
        this.subtitleLayer.innerHTML = '';

        const captions = stream.captions || [];
        // Keep provider captions separate so external (OpenSubtitles) subs survive source switches.
        this._providerCaptions = captions;
        this._availableCaptions = captions.concat(this._extSubs || []);
        if (this._availableCaptions.length > 0 && this.autoplaySubtitles) {
            // Load first English subtitle, or first available
            const enSub = this._availableCaptions.find(c => c.lang === 'en') || this._availableCaptions[0];
            if (enSub) this._loadSubtitleTrack(enSub);
            this.ccBtn.classList.add('active');
        } else {
            this.ccBtn.classList.remove('active');
        }
        // Pull keyless OpenSubtitles in the background and merge into the CC menu.
        this._fetchExternalSubs();

        this.container.focus();
        // For file streams, play immediately; HLS play is deferred to MANIFEST_PARSED
        if (stream.type !== 'hls') this.video.play().catch(() => {});
    }

    setMediaContext(mediaType, tmdbId, season, episode) {
        // Lets the player pull external subtitles for the current title.
        this._subCtx = { type: mediaType, tmdbId, season: season || 1, episode: episode || 1 };
        this._extSubs = null;
        this._extSubsFetched = false;
    }

    async _fetchExternalSubs() {
        const c = this._subCtx;
        if (this._extSubsFetched || !c || !c.tmdbId) return;
        this._extSubsFetched = true;
        try {
            const q = c.type === 'tv' ? `?season=${c.season}&episode=${c.episode}` : '';
            const res = await fetch(`/subtitles/${c.type}/${c.tmdbId}${q}`);
            const subs = await res.json();
            if (Array.isArray(subs) && subs.length) {
                this._extSubs = subs;
                this._availableCaptions = (this._providerCaptions || []).concat(subs);
                // Refresh the CC menu only if that panel is the one currently shown.
                if (this.settingsPanel && this.settingsPanel.querySelector('[data-sub]')) {
                    this._renderSubtitleMenu();
                }
            }
        } catch (e) {
            console.warn('[Player] external subtitles failed', e);
        }
    }

    // Server-backed watch progress: throttled heartbeat (+ force on ended).
    _maybeRecordProgress(force) {
        const c = this._subCtx;
        if (!c || !c.tmdbId) return;
        const now = Date.now();
        if (!force && this._lastProg && (now - this._lastProg) < 15000) return;
        this._lastProg = now;
        const pos = this.video.currentTime || 0;
        const dur = this.video.duration || 0;
        if (dur < 1) return;
        try {
            const gid = (typeof window.getGuestId === 'function') ? window.getGuestId() : 'guest';
            fetch('/progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    guest_id: gid, media_type: c.type, tmdb_id: c.tmdbId,
                    season: c.type === 'tv' ? c.season : 0,
                    episode: c.type === 'tv' ? c.episode : 0,
                    position_seconds: force ? dur : pos,
                    duration_seconds: dur,
                }),
            }).catch(() => {});
        } catch (e) { /* ignore */ }
    }

    setTitle(title) {
        this.mediaTitle = title;
        this.titleText.textContent = title;
    }

    onClose(cb) {
        this.onCloseCallback = cb;
    }

    pause() {
        this.video.pause();
    }

    get currentTime() {
        return this.video.currentTime;
    }

    set currentTime(v) {
        this.video.currentTime = v;
    }

    get duration() {
        return this.video.duration;
    }

    get playing() {
        return this.isPlaying;
    }

    destroy() {
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        this.video.pause();
        this.video.src = '';
        clearTimeout(this.hideControlsTimer);
        clearTimeout(this._loadTimeout);
    }

    // ─── HLS Loading ───
    _proxyUrl(rawUrl, headers) {
        const params = new URLSearchParams({ url: rawUrl });
        if (headers) {
            if (headers.Referer) params.append('referer', headers.Referer);
            if (headers.Origin)  params.append('origin', headers.Origin);
        }
        return `/proxy_stream?${params}`;
    }

    _loadHLS(stream) {
        // Always proxy HLS through our backend to avoid CORS issues
        const hdrs = stream.headers || {};
        const playUrl = this._proxyUrl(stream.playlist, hdrs);

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            const self = this;
            const hlsCfg = {
                // Aggressive buffering — now safe since /proxy_stream streams instead of
                // buffering whole files. Loads minutes ahead so playback rarely stalls.
                maxBufferSize: 240 * 1000 * 1000,  // 240 MB of segments held in browser memory
                maxBufferLength: 120,              // keep ~2 min buffered ahead at all times
                maxMaxBufferLength: 900,           // allow up to ~15 min on a fast connection
                backBufferLength: 90,              // keep 90s behind for instant rewind
                startLevel: -1,                    // let ABR choose — faster first frame
                capLevelToPlayerSize: true,        // don't fetch 4K into a 720p window
                abrEwmaDefaultEstimate: 1500000,   // assume a decent pipe so it ramps quality fast
                startFragPrefetch: true,           // prefetch first segment during manifest parse
                enableWorker: true,                // demux off the main thread
                // Robust retry policies (from sudoflix)
                fragLoadPolicy: {
                    default: {
                        maxLoadTimeMs: 30000,
                        maxTimeToFirstByteMs: 30000,
                        errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
                        timeoutRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
                    },
                },
                manifestLoadPolicy: {
                    default: {
                        maxLoadTimeMs: 30000,
                        maxTimeToFirstByteMs: 30000,
                        errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
                        timeoutRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
                    },
                },
                // Proxy all sub-requests (segments, variant playlists, keys)
                xhrSetup(xhr, url) {
                    if (!url.startsWith('/proxy_stream')) {
                        const proxied = self._proxyUrl(url, hdrs);
                        xhr.open('GET', proxied, true);
                    }
                }
            };

            this.hls = new Hls(hlsCfg);
            this.hls.loadSource(playUrl);
            this.hls.attachMedia(this.video);
            this.hls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
                console.log(`[Player] HLS manifest parsed: ${data.levels.length} quality levels`);
                // Apply preferred quality if set
                if (this.preferredQuality !== 'auto' && data.levels.length > 0) {
                    const prefH = parseInt(this.preferredQuality);
                    if (prefH) {
                        const idx = data.levels.findIndex(l => l.height === prefH);
                        if (idx >= 0) {
                            this.hls.currentLevel = idx;
                            console.log(`[Player] Set preferred quality: ${prefH}p (level ${idx})`);
                        }
                    }
                }
                this.video.play().catch(() => {});
            });
            this.hls.on(Hls.Events.ERROR, (e, data) => {
                console.warn('[Player] HLS error:', data.type, data.details, data.fatal ? '(FATAL)' : '');
                if (data.response) {
                    console.warn('[Player] Response status:', data.response.code);
                }
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.warn('[Player] Network error, attempting recovery...');
                            this.hls.startLoad();
                            // If recovery fails after 5s, try next source
                            setTimeout(() => {
                                if (this.loadingEl.classList.contains('visible') && !this.isPlaying) {
                                    console.warn('[Player] Recovery failed, trying next source');
                                    this.hls.destroy();
                                    this.hls = null;
                                    this._tryNextSource();
                                }
                            }, 5000);
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.warn('[Player] Media error, attempting recovery...');
                            this.hls.recoverMediaError();
                            break;
                        default:
                            console.error('[Player] Unrecoverable HLS error');
                            this.hls.destroy();
                            this.hls = null;
                            this._tryNextSource();
                            break;
                    }
                }
            });
            this.hls.on(Hls.Events.FRAG_LOADED, () => {
                // Clear load timeout on first successful fragment
                clearTimeout(this._loadTimeout);
            });
        } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari native HLS
            this.video.src = playUrl;
        }
    }

    _tryNextSource() {
        if (!this.allSources || this.allSources.length === 0) {
            this._showError('No streams available');
            return;
        }
        const currentKey = this.currentSource
            ? `${this.currentSource.source}-${this.currentSource.embed||''}`
            : '';
        const idx = this.allSources.findIndex(s => `${s.source}-${s.embed||''}` === currentKey);
        const next = this.allSources[idx + 1];
        if (next) {
            console.log('[Player] Auto-trying next source:', next.source);
            this.loadStream(next, this.allSources);
        } else {
            this._showError('All sources failed');
        }
    }

    _showError(msg) {
        this.loadingEl.classList.remove('visible');
        this.loadingEl.innerHTML = `<div style="color:#ff6b6b;font-family:var(--font-pixel,monospace);font-size:0.9rem;text-align:center;padding:20px;">${msg}<br><span style="font-size:0.75rem;opacity:0.7;margin-top:8px;display:block;">Try another source from the panel</span></div>`;
        this.loadingEl.classList.add('visible');
    }

    // ─── File Loading ───
    _loadFile(stream) {
        // Pick best quality or preferred
        const sorted = [...stream.qualities].sort((a, b) => {
            const qA = parseInt(a.quality) || 0;
            const qB = parseInt(b.quality) || 0;
            return qB - qA;
        });

        let pick = sorted[0];
        if (this.preferredQuality !== 'auto') {
            const match = sorted.find(q => q.quality === this.preferredQuality);
            if (match) pick = match;
        }

        // Always proxy file streams to avoid CORS issues
        const playUrl = this._proxyUrl(pick.url, stream.headers || {});

        this.video.src = playUrl;
        this._fileQualities = sorted;
        this._fileHeaders = stream.headers || {};
        this._currentFileQuality = pick.quality;
        console.log(`[Player] Loading file stream: ${pick.quality}p via proxy`);
    }

    // ─── Subtitle Loading ───
    async _loadSubtitleTrack(caption) {
        try {
            // Proxy all subtitle URLs through our server to avoid CORS
            let fetchUrl = caption.url;
            if (fetchUrl && !fetchUrl.startsWith('/')) {
                fetchUrl = `/proxy_subtitle?url=${encodeURIComponent(caption.url)}`;
            }
            const resp = await fetch(fetchUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            this.cues = parseSubtitles(text);
            if (this.cues.length === 0) {
                console.warn('[Player] Subtitle parsed but 0 cues, raw length:', text.length);
            } else {
                console.log(`[Player] Loaded ${this.cues.length} subtitle cues for ${caption.lang}`);
            }
            this._activeCaption = caption;
            this.ccBtn.classList.add('active');
        } catch (e) {
            console.warn('[Player] Subtitle load failed:', e);
            this.cues = [];
        }
    }

    _renderSubtitle(time) {
        const adjustedTime = time + this.subtitleDelay;
        const active = this.cues.filter(c => adjustedTime >= c.start && adjustedTime <= c.end);
        if (active.length === 0) {
            this.subtitleLayer.innerHTML = '';
            return;
        }
        const html = active.map(c => {
            const sanitized = c.text
                .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/&lt;(b|i|u|br\s*\/?)&gt;/g, '<$1>')
                .replace(/&lt;\/(b|i|u)&gt;/g, '</$1>');
            const bgClass = `sub-bg-${Math.round(this.subtitleBgOpacity * 100 / 25) * 25}`;
            const boldClass = this.subtitleBold ? 'sub-bold' : '';
            return `<div class="naut-sub-line ${bgClass} ${boldClass}" style="font-size:${1.2 * this.subtitleSize}em; color:${this.subtitleColor}">${sanitized}</div>`;
        }).join('');
        this.subtitleLayer.innerHTML = html;
    }

    // ─── Controls Visibility ───
    _showControls() {
        this.container.classList.remove('controls-hidden');
    }

    _hideControls() {
        if (!this.isPlaying || this.isDragging || this.settingsOpen || this.sourcesPanelOpen) return;
        this.container.classList.add('controls-hidden');
    }

    _startHideTimer(ms = 3000) {
        clearTimeout(this.hideControlsTimer);
        this.hideControlsTimer = setTimeout(() => this._hideControls(), ms);
    }

    // ─── Time & Progress Updates ───
    _onTimeUpdate() {
        const v = this.video;
        if (!v.duration || this.isDragging) return;
        this._maybeRecordProgress();
        const pct = (v.currentTime / v.duration) * 100;
        this.progressPlayed.style.width = pct + '%';
        this.progressThumb.style.left = pct + '%';
        this.timeCurrent.textContent = this._formatTime(v.currentTime);

        // Render subtitle
        if (this.cues.length > 0) {
            this._renderSubtitle(v.currentTime);
        }
    }

    _onBufferUpdate() {
        const v = this.video;
        if (!v.duration || !v.buffered.length) return;
        const buffEnd = v.buffered.end(v.buffered.length - 1);
        this.progressBuffered.style.width = (buffEnd / v.duration * 100) + '%';
    }

    // ─── Seek ───
    _startSeek(e) {
        this.isDragging = true;
        this._doSeek(e);
        const onMove = (ev) => this._doSeek(ev);
        const onUp = () => {
            this.isDragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: true });
        document.addEventListener('touchend', onUp);
    }

    _doSeek(e) {
        const rect = this.progressBar.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        this.video.currentTime = pct * (this.video.duration || 0);
        this.progressPlayed.style.width = (pct * 100) + '%';
        this.progressThumb.style.left = (pct * 100) + '%';
    }

    _showTooltip(e) {
        const rect = this.progressBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const time = pct * (this.video.duration || 0);
        this.progressTooltip.textContent = this._formatTime(time);
        this.progressTooltip.style.left = (pct * 100) + '%';
    }

    // ─── Toggle Functions ───
    togglePlay() {
        if (this.video.paused || this.video.ended) {
            this.video.play().catch(() => {});
        } else {
            this.video.pause();
        }
    }

    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            this.container.requestFullscreen().catch(() => {});
        }
    }

    _updateFsIcon() {
        this.fsBtn.innerHTML = document.fullscreenElement
            ? '<i class="fa-solid fa-compress"></i>'
            : '<i class="fa-solid fa-expand"></i>';
    }

    togglePiP() {
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        } else {
            this.video.requestPictureInPicture().catch(() => {});
        }
    }

    _updateVolumeIcon() {
        const v = this.video;
        let icon = 'fa-volume-high';
        if (v.muted || v.volume === 0) icon = 'fa-volume-xmark';
        else if (v.volume < 0.5) icon = 'fa-volume-low';
        this.volBtn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    }

    _toggleSubtitles() {
        const caps = this._availableCaptions || [];
        if (caps.length === 0) {
            // No subtitles available
            this.ccBtn.classList.remove('active');
            return;
        }

        if (this.cues.length > 0) {
            // Subtitles are ON — turn off
            this.cues = [];
            this.subtitleLayer.innerHTML = '';
            this.ccBtn.classList.remove('active');
            this._activeCaption = null;
        } else {
            // Open subtitle picker in settings
            this._openSubtitlePicker();
        }
    }

    // ─── Settings Panel ───
    _toggleSettings() {
        this.settingsOpen = !this.settingsOpen;
        if (this.settingsOpen) {
            this._renderSettingsMain();
            this.settingsPanel.classList.add('open');
        } else {
            this.settingsPanel.classList.remove('open');
        }
    }

    _closeSettings() {
        this.settingsOpen = false;
        this.settingsPanel.classList.remove('open');
    }

    _renderSettingsMain() {
        // Quality label
        let qualLabel = 'Auto';
        if (this.hls && this.hls.levels && this.hls.levels.length > 0) {
            if (this.hls.autoLevelEnabled || this.hls.currentLevel === -1) {
                const autoLevel = this.hls.currentLevel >= 0 ? this.hls.levels[this.hls.currentLevel]?.height : null;
                qualLabel = autoLevel ? `Auto (${autoLevel}p)` : 'Auto';
            } else if (this.hls.currentLevel >= 0) {
                qualLabel = this.hls.levels[this.hls.currentLevel]?.height + 'p' || '?';
            }
        } else if (this._currentFileQuality) {
            qualLabel = this._currentFileQuality === 'unknown' ? 'Auto' : this._currentFileQuality + 'p';
        }
        const subLabel = this._activeCaption ? (this._activeCaption.lang || 'On').toUpperCase() : 'Off';
        this.settingsPanel.innerHTML = `
            <div class="naut-settings-item" data-action="quality">
                <span><i class="fa-solid fa-signal" style="margin-right:8px;opacity:0.5"></i> Quality</span>
                <span class="value">${qualLabel}</span>
            </div>
            <hr class="naut-settings-divider">
            <div class="naut-settings-item" data-action="subtitles">
                <span><i class="fa-solid fa-closed-captioning" style="margin-right:8px;opacity:0.5"></i> Subtitles</span>
                <span class="value">${subLabel}</span>
            </div>
            <hr class="naut-settings-divider">
            <div class="naut-settings-item" data-action="subtitle-style">
                <span><i class="fa-solid fa-paint-brush" style="margin-right:8px;opacity:0.5"></i> Subtitle Style</span>
                <span class="value"><i class="fa-solid fa-chevron-right" style="font-size:11px;opacity:0.4"></i></span>
            </div>
            <hr class="naut-settings-divider">
            <div class="naut-settings-item" data-action="playback-speed">
                <span><i class="fa-solid fa-gauge-high" style="margin-right:8px;opacity:0.5"></i> Speed</span>
                <span class="value">${this.video.playbackRate}x</span>
            </div>
        `;
        this.settingsPanel.querySelectorAll('[data-action]').forEach(el => {
            el.addEventListener('click', () => {
                const action = el.dataset.action;
                if (action === 'quality') this._renderQualityMenu();
                else if (action === 'subtitles') this._renderSubtitleMenu();
                else if (action === 'subtitle-style') this._renderSubtitleStyleMenu();
                else if (action === 'playback-speed') this._renderSpeedMenu();
            });
        });
    }

    _renderQualityMenu() {
        let items = '';

        if (this.hls && this.hls.levels && this.hls.levels.length > 0) {
            // HLS quality levels
            const currentLevel = this.hls.currentLevel;
            const autoEnabled = this.hls.autoLevelEnabled;
            // Always show Auto option
            items += `<div class="naut-settings-item ${autoEnabled ? 'selected' : ''}" data-q="-1">
                <span>Auto</span>
                ${autoEnabled && this.hls.currentLevel >= 0 ? `<span class="quality-auto-hint">${this.hls.levels[this.hls.currentLevel]?.height || '?'}p</span>` : ''}
            </div>`;
            // Deduplicate levels by height and sort descending
            const seen = new Set();
            const uniqueLevels = [];
            this.hls.levels.forEach((level, idx) => {
                const h = level.height || 0;
                if (!seen.has(h)) { seen.add(h); uniqueLevels.push({ level, idx, height: h }); }
            });
            uniqueLevels.sort((a, b) => b.height - a.height);
            uniqueLevels.forEach(({ level, idx, height }) => {
                const sel = !autoEnabled && currentLevel === idx ? 'selected' : '';
                const bitrate = level.bitrate ? ` <span style="opacity:0.4;font-size:0.8em">${(level.bitrate/1000000).toFixed(1)}Mbps</span>` : '';
                items += `<div class="naut-settings-item ${sel}" data-q="${idx}">${height}p${bitrate}</div>`;
            });
        } else if (this._fileQualities && this._fileQualities.length > 0) {
            // File quality
            this._fileQualities.forEach((q) => {
                const label = q.quality === 'unknown' ? 'Auto' : q.quality + 'p';
                const sel = q.quality === this._currentFileQuality ? 'selected' : '';
                items += `<div class="naut-settings-item ${sel}" data-fq="${q.quality}">${label}</div>`;
            });
        } else {
            items = '<div class="naut-settings-item" style="opacity:0.5">No quality options</div>';
        }

        this.settingsPanel.innerHTML = `
            <div class="naut-settings-header" data-back="main"><i class="fa-solid fa-chevron-left"></i> Quality</div>
            <hr class="naut-settings-divider">
            ${items}
        `;

        this.settingsPanel.querySelector('[data-back]')?.addEventListener('click', () => this._renderSettingsMain());

        this.settingsPanel.querySelectorAll('[data-q]').forEach(el => {
            el.addEventListener('click', () => {
                const level = parseInt(el.dataset.q);
                if (level === -1) {
                    // Auto: let HLS.js pick
                    this.hls.currentLevel = -1;
                    this.hls.nextLevel = -1;
                    this.preferredQuality = 'auto';
                } else {
                    // Manual: lock to specific level
                    this.hls.currentLevel = level;
                    this.hls.nextLevel = level;
                    this.preferredQuality = this.hls.levels[level]?.height?.toString() || 'auto';
                }
                setPlayerPrefs({ preferredQuality: this.preferredQuality });
                this._renderQualityMenu();
            });
        });

        this.settingsPanel.querySelectorAll('[data-fq]').forEach(el => {
            el.addEventListener('click', () => {
                const quality = el.dataset.fq;
                const match = this._fileQualities.find(q => q.quality === quality);
                if (match) {
                    const curTime = this.video.currentTime;
                    let playUrl = match.url;
                    if (this._fileHeaders && Object.keys(this._fileHeaders).length) {
                        const params = new URLSearchParams({ url: match.url });
                        if (this._fileHeaders.Referer) params.append('referer', this._fileHeaders.Referer);
                        if (this._fileHeaders.Origin) params.append('origin', this._fileHeaders.Origin);
                        playUrl = `/proxy_stream?${params}`;
                    }
                    this.video.src = playUrl;
                    this.video.currentTime = curTime;
                    this.video.play().catch(() => {});
                    this._currentFileQuality = quality;
                    this.preferredQuality = quality;
                    setPlayerPrefs({ preferredQuality: quality });
                }
                this._renderQualityMenu();
            });
        });
    }

    _renderSubtitleMenu() {
        const caps = this._availableCaptions || [];
        const offSel = !this._activeCaption ? 'selected' : '';
        
        // Deduplicate captions by language (keep first of each)
        const langMap = new Map();
        const deduped = [];
        for (const c of caps) {
            const key = c.lang || 'unknown';
            if (!langMap.has(key)) {
                langMap.set(key, deduped.length);
                deduped.push(c);
            }
        }
        
        // Language code to display name map
        const langNames = {
            en: 'English', es: 'Spanish', fr: 'French', de: 'German',
            it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
            ko: 'Korean', zh: 'Chinese', ar: 'Arabic', tr: 'Turkish',
            nl: 'Dutch', pl: 'Polish', cs: 'Czech', sv: 'Swedish',
            da: 'Danish', fi: 'Finnish', no: 'Norwegian', hu: 'Hungarian',
            ro: 'Romanian', hr: 'Croatian', el: 'Greek', he: 'Hebrew',
            th: 'Thai', id: 'Indonesian', vi: 'Vietnamese', hi: 'Hindi',
            bg: 'Bulgarian', sr: 'Serbian', sl: 'Slovenian', sk: 'Slovak',
            ms: 'Malay', bn: 'Bengali', is: 'Icelandic',
        };
        
        let items = `<div class="naut-settings-item ${offSel}" data-sub="off">Off</div>`;
        deduped.forEach((c, idx) => {
            const sel = this._activeCaption === c ? 'selected' : '';
            const code = (c.lang || 'unknown').toLowerCase();
            const label = langNames[code] || code.toUpperCase();
            items += `<div class="naut-settings-item ${sel}" data-sub="${caps.indexOf(c)}">${label}</div>`;
        });

        this.settingsPanel.innerHTML = `
            <div class="naut-settings-header" data-back="main"><i class="fa-solid fa-chevron-left"></i> Subtitles</div>
            <hr class="naut-settings-divider">
            ${items}
        `;

        this.settingsPanel.querySelector('[data-back]')?.addEventListener('click', () => this._renderSettingsMain());

        this.settingsPanel.querySelectorAll('[data-sub]').forEach(el => {
            el.addEventListener('click', () => {
                const val = el.dataset.sub;
                if (val === 'off') {
                    this.cues = [];
                    this.subtitleLayer.innerHTML = '';
                    this._activeCaption = null;
                    this.ccBtn.classList.remove('active');
                } else {
                    const cap = caps[parseInt(val)];
                    if (cap) this._loadSubtitleTrack(cap);
                }
                this._renderSubtitleMenu();
            });
        });
    }

    _openSubtitlePicker() {
        this.settingsOpen = true;
        this._renderSubtitleMenu();
        this.settingsPanel.classList.add('open');
    }

    _renderSubtitleStyleMenu() {
        this.settingsPanel.innerHTML = `
            <div class="naut-settings-header" data-back="main"><i class="fa-solid fa-chevron-left"></i> Subtitle Style</div>
            <hr class="naut-settings-divider">
            <div class="naut-settings-item">
                <span>Size</span>
                <input type="range" min="0.5" max="2" step="0.1" value="${this.subtitleSize}" 
                       style="width:100px;accent-color:#e44" data-style="size">
            </div>
            <div class="naut-settings-item">
                <span>Background</span>
                <input type="range" min="0" max="1" step="0.25" value="${this.subtitleBgOpacity}" 
                       style="width:100px;accent-color:#e44" data-style="bg">
            </div>
            <div class="naut-settings-item" data-style-toggle="bold">
                <span>Bold</span>
                <span class="value">${this.subtitleBold ? 'ON' : 'OFF'}</span>
            </div>
            <hr class="naut-settings-divider">
            <div class="naut-settings-item" style="gap:8px;justify-content:flex-start;">
                <span style="margin-right:8px;">Color</span>
                ${['#ffffff','#e2e535','#80b1fa','#b0b0b0'].map(c => 
                    `<span data-color="${c}" style="display:inline-block;width:24px;height:24px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${this.subtitleColor===c?'#e44':'transparent'}"></span>`
                ).join('')}
            </div>
        `;

        this.settingsPanel.querySelector('[data-back]')?.addEventListener('click', () => this._renderSettingsMain());

        this.settingsPanel.querySelectorAll('[data-style]').forEach(el => {
            el.addEventListener('input', () => {
                if (el.dataset.style === 'size') {
                    this.subtitleSize = parseFloat(el.value);
                    setPlayerPrefs({ subtitleSize: this.subtitleSize });
                } else if (el.dataset.style === 'bg') {
                    this.subtitleBgOpacity = parseFloat(el.value);
                    setPlayerPrefs({ subtitleBgOpacity: this.subtitleBgOpacity });
                }
            });
        });

        this.settingsPanel.querySelector('[data-style-toggle="bold"]')?.addEventListener('click', () => {
            this.subtitleBold = !this.subtitleBold;
            setPlayerPrefs({ subtitleBold: this.subtitleBold });
            this._renderSubtitleStyleMenu();
        });

        this.settingsPanel.querySelectorAll('[data-color]').forEach(el => {
            el.addEventListener('click', () => {
                this.subtitleColor = el.dataset.color;
                setPlayerPrefs({ subtitleColor: this.subtitleColor });
                this._renderSubtitleStyleMenu();
            });
        });
    }

    _renderSpeedMenu() {
        const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
        let items = speeds.map(s => {
            const sel = this.video.playbackRate === s ? 'selected' : '';
            return `<div class="naut-settings-item ${sel}" data-speed="${s}">${s}x${s === 1 ? ' (Normal)' : ''}</div>`;
        }).join('');

        this.settingsPanel.innerHTML = `
            <div class="naut-settings-header" data-back="main"><i class="fa-solid fa-chevron-left"></i> Playback Speed</div>
            <hr class="naut-settings-divider">
            ${items}
        `;

        this.settingsPanel.querySelector('[data-back]')?.addEventListener('click', () => this._renderSettingsMain());

        this.settingsPanel.querySelectorAll('[data-speed]').forEach(el => {
            el.addEventListener('click', () => {
                this.video.playbackRate = parseFloat(el.dataset.speed);
                this._renderSpeedMenu();
            });
        });
    }

    // ─── Sources Panel ───
    _toggleSourcesPanel() {
        this.sourcesPanelOpen = !this.sourcesPanelOpen;
        if (this.sourcesPanelOpen) {
            this._renderSourcesPanel();
            this.sourcePanel.classList.add('open');
        } else {
            this.sourcePanel.classList.remove('open');
        }
    }

    _renderSourcesPanel() {
        const currentKey = this.currentSource ? `${this.currentSource.source}-${this.currentSource.embed || ''}` : '';
        let items = this.allSources.map((s, idx) => {
            const key = `${s.source}-${s.embed || ''}`;
            const label = s.embed ? `${s.source} → ${s.embed}` : s.source;
            const typeIcon = s.stream?.type === 'hls' ? 'fa-satellite-dish' : 'fa-file-video';
            const qualInfo = s.stream?.type === 'file' && s.stream.qualities?.length
                ? s.stream.qualities.map(q => q.quality).filter(q => q !== 'unknown').join('/')
                : s.stream?.type === 'hls' ? 'HLS' : '';
            const active = key === currentKey ? 'active' : '';
            return `
                <div class="naut-source-item ${active}" data-src-idx="${idx}">
                    <div class="src-icon"><i class="fa-solid ${typeIcon}"></i></div>
                    <div class="src-name">${label}</div>
                    <div class="src-type">${qualInfo}</div>
                </div>
            `;
        }).join('');

        if (this.allSources.length === 0) {
            items = '<div style="padding:20px;color:rgba(255,255,255,0.4);text-align:center;font-family:var(--font-pixel)">No sources found</div>';
        }

        this.sourcePanel.innerHTML = `
            <div class="naut-source-panel-header">
                <h3>Sources</h3>
                <button class="naut-ctrl-btn" data-close-src><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="naut-source-list">${items}</div>
        `;

        this.sourcePanel.querySelector('[data-close-src]')?.addEventListener('click', () => {
            this.sourcesPanelOpen = false;
            this.sourcePanel.classList.remove('open');
        });

        this.sourcePanel.querySelectorAll('[data-src-idx]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.srcIdx);
                const src = this.allSources[idx];
                if (src) {
                    const curTime = this.video.currentTime;
                    this.loadStream(src, this.allSources);
                    // Try to resume position
                    setTimeout(() => { this.video.currentTime = curTime; }, 500);
                }
                this.sourcesPanelOpen = false;
                this.sourcePanel.classList.remove('open');
            });
        });
    }

    // ─── Keyboard Shortcuts ───
    _onKeyDown(e) {
        if (e.target.tagName === 'INPUT') return;
        const v = this.video;
        switch (e.key) {
            case ' ':
            case 'k': case 'K':
                e.preventDefault();
                this.togglePlay();
                break;
            case 'f': case 'F':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm': case 'M':
                e.preventDefault();
                v.muted = !v.muted;
                this._updateVolumeIcon();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                v.currentTime = Math.max(0, v.currentTime - 5);
                break;
            case 'ArrowRight':
                e.preventDefault();
                v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
                break;
            case 'ArrowUp':
                e.preventDefault();
                v.volume = Math.min(1, v.volume + 0.1);
                this.volSlider.value = v.volume;
                this._updateVolumeIcon();
                break;
            case 'ArrowDown':
                e.preventDefault();
                v.volume = Math.max(0, v.volume - 0.1);
                this.volSlider.value = v.volume;
                this._updateVolumeIcon();
                break;
            case 'j': case 'J':
                e.preventDefault();
                v.currentTime = Math.max(0, v.currentTime - 10);
                break;
            case 'l': case 'L':
                e.preventDefault();
                v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
                break;
            case 'c': case 'C':
                e.preventDefault();
                this._toggleSubtitles();
                break;
            case 'Escape':
                e.preventDefault();
                if (this.settingsOpen) this._closeSettings();
                else if (this.sourcesPanelOpen) {
                    this.sourcesPanelOpen = false;
                    this.sourcePanel.classList.remove('open');
                }
                else if (document.fullscreenElement) document.exitFullscreen();
                else if (this.onCloseCallback) this.onCloseCallback();
                break;
        }
    }

    // ─── Utilities ───
    _formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }
}
