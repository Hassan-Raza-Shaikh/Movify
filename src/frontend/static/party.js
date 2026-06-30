/* =====================================================
   Nautilus Watch Parties ("Crews")
   Sign-up-free, room-code synced playback + crew chat.
   Only the timeline is shared — every viewer streams their
   own copy, so there is no shared video pipe to choke.
   ===================================================== */
(function () {
    const LS_NAME = 'nautilus_party_name';

    const ADJ = ['Salty', 'Iron', 'Crimson', 'Ghost', 'Mad', 'Golden', 'Black', 'Storm', 'Bones', 'Dread'];
    const NOUN = ['Beard', 'Hook', 'Kraken', 'Gull', 'Marlin', 'Tide', 'Compass', 'Anchor', 'Reef', 'Cannon'];
    function randomCaptain() {
        const a = ADJ[Math.floor(Math.random() * ADJ.length)];
        const n = NOUN[Math.floor(Math.random() * NOUN.length)];
        return `${a}${n}`;
    }

    const state = {
        ws: null,
        code: null,
        memberId: null,
        hostId: null,
        name: localStorage.getItem(LS_NAME) || randomCaptain(),
        members: [],
        connected: false,
        desired: null,        // latest {media, paused, position}
        applyTimer: null,
        catchingUp: false,    // loading + seeking to crew position
        suppressMedia: false, // applying a remote set_media right now
        pingTimer: null,
        collapsed: false,
    };
    localStorage.setItem(LS_NAME, state.name);

    // ---------------------------------------------------------------- bridge
    // Called by player.js / script.js. Defined up front so they always exist.
    window.NautilusParty = {
        active: () => state.connected,
        onLocalAction,
        onLocalMediaChange,
        toggle: launcherClick,
    };

    function onLocalAction(action, time) {
        if (!state.connected || state.catchingUp || state.suppressMedia) return;
        send({ type: action, position: time });
    }

    function onLocalMediaChange(type, tmdbId, season, episode, title, poster) {
        if (!state.connected || state.suppressMedia) return;
        const media = { type, tmdb_id: tmdbId, season: season || 1, episode: episode || 1, title: title || '', poster: poster || '' };
        state.desired = { media, paused: true, position: 0 };
        send({ type: 'set_media', media });
    }

    // ----------------------------------------------------------- websocket io
    function connect(code) {
        if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${location.host}/ws/party/${encodeURIComponent(code || 'new')}`;
        let ws;
        try { ws = new WebSocket(url); } catch (e) { toast('Could not open a crew connection.'); return; }
        state.ws = ws;
        ws.onopen = () => {
            send({ type: 'hello', name: state.name, guest_id: (window.getGuestId ? getGuestId() : 'guest') });
            startPing();
        };
        ws.onmessage = (e) => {
            let m; try { m = JSON.parse(e.data); } catch (_) { return; }
            handle(m);
        };
        ws.onclose = () => {
            stopPing();
            if (state.connected) {
                state.connected = false;
                chatSystem('Disconnected from the crew.');
                renderDock();
            }
        };
        ws.onerror = () => {};
    }

    function send(o) {
        if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o));
    }

    function startPing() { stopPing(); state.pingTimer = setInterval(() => send({ type: 'ping' }), 25000); }
    function stopPing() { if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; } }

    function handle(msg) {
        switch (msg.type) {
            case 'welcome':
                state.code = msg.code;
                state.memberId = msg.member_id;
                state.hostId = msg.host_id;
                state.members = msg.members || [];
                state.connected = true;
                state.desired = stateToDesired(msg.state);
                hideLaunch();
                renderDock();
                showDock();
                writeUrlParty(state.code);
                chatSystem(`You joined crew ${state.code}.`);
                if (msg.state && msg.state.media) {
                    applyMedia(msg.state.media);
                }
                break;

            case 'member_join':
                state.members = msg.members || state.members;
                renderMembers();
                chatSystem(`${msg.member?.name || 'A crewmate'} climbed aboard.`);
                break;

            case 'member_leave':
                state.members = msg.members || state.members;
                if (msg.host_id) state.hostId = msg.host_id;
                renderMembers();
                chatSystem('A crewmate left the ship.');
                break;

            case 'members':
                state.members = msg.members || state.members;
                renderMembers();
                break;

            case 'set_media':
                state.desired = { media: msg.media, paused: true, position: 0 };
                chatSystem(`${msg.by_name || 'Someone'} set course for "${msg.media?.title || 'a new title'}".`);
                applyMedia(msg.media);
                break;

            case 'play':
            case 'pause':
            case 'seek':
                state.desired = state.desired || {};
                state.desired.paused = (msg.type === 'pause');
                if (typeof msg.position === 'number') state.desired.position = msg.position;
                applyControl(msg.type, msg.position);
                break;

            case 'state':
                if (msg.host_id) state.hostId = msg.host_id;
                if (msg.state) {
                    state.desired = stateToDesired(msg.state);
                    applyControl(msg.state.paused ? 'pause' : 'play', msg.state.position);
                }
                break;

            case 'chat':
                renderChat(msg.name, msg.text, msg.from === state.memberId);
                break;

            case 'pong':
            default:
                break;
        }
    }

    function stateToDesired(s) {
        if (!s) return null;
        return { media: s.media || null, paused: !!s.paused, position: s.position || 0 };
    }

    // --------------------------------------------------------- apply to player
    function applyControl(action, position) {
        const np = window.nautPlayer;
        if (!np || !np.video || state.catchingUp) return; // catch-up loop applies the latest
        np.partyApply(action, position);
    }

    // Load the crew's current title locally, then snap to their live position.
    function applyMedia(media) {
        if (!media) return;
        if (media.type !== 'movie') {
            // TV parties live on the dedicated show page — not wired here yet.
            toast('Crew is watching a series — open it from the Series page to follow along.');
            return;
        }
        // Already playing this exact title? just resync.
        if (window.currentTmdbId === media.tmdb_id && window.nautPlayer) {
            scheduleCatchUp();
            return;
        }
        state.suppressMedia = true;
        state.catchingUp = true;
        const modal = document.getElementById('modal');
        const title = document.getElementById('m-title');
        const poster = document.getElementById('m-poster');
        if (title) title.textContent = media.title || 'Nautilus';
        if (poster && media.poster) poster.src = media.poster;
        if (modal) modal.classList.remove('hidden');
        if (typeof window.playVideo === 'function') {
            window.playVideo('movie', media.tmdb_id, media.season || 1, media.episode || 1);
        }
        setTimeout(() => { state.suppressMedia = false; }, 700);
        scheduleCatchUp();
    }

    // Poll until the player has metadata, then apply the desired play/pause/pos
    // and ask the server for a fresh position (our stream may have loaded late).
    function scheduleCatchUp() {
        state.catchingUp = true;
        clearInterval(state.applyTimer);
        let tries = 0;
        state.applyTimer = setInterval(() => {
            tries++;
            const np = window.nautPlayer;
            const ready = np && np.video && np.video.readyState >= 1 && isFinite(np.video.duration) && np.video.duration > 0;
            if (ready) {
                clearInterval(state.applyTimer);
                const d = state.desired;
                if (d) np.partyApply(d.paused ? 'pause' : 'play', d.position);
                send({ type: 'sync_request' });   // get the freshest position
                setTimeout(() => { state.catchingUp = false; }, 500);
            } else if (tries > 70) {              // ~35s give-up
                clearInterval(state.applyTimer);
                state.catchingUp = false;
            }
        }, 500);
    }

    // -------------------------------------------------------------- URL helpers
    function writeUrlParty(code) {
        try {
            const u = new URL(location.href);
            u.searchParams.set('party', code);
            history.replaceState(null, '', u);
        } catch (e) {}
    }
    function clearUrlParty() {
        try {
            const u = new URL(location.href);
            u.searchParams.delete('party');
            history.replaceState(null, '', u);
        } catch (e) {}
    }

    // --------------------------------------------------------------- launcher
    function launcherClick() {
        if (state.connected) { state.collapsed = false; showDock(); }
        else showLaunch();
    }

    function leave() {
        if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
        stopPing();
        clearInterval(state.applyTimer);
        state.connected = false;
        state.code = null;
        state.members = [];
        hideDock();
        clearUrlParty();
        setLauncherActive(false);
    }

    // =========================================================== UI: launch modal
    let launchEl, dockEl, chatBox, codeLabel, membersEl, launcherBtn;

    function buildUI() {
        // --- launch / join modal ---
        launchEl = document.createElement('div');
        launchEl.id = 'party-launch';
        launchEl.className = 'modal hidden';
        launchEl.innerHTML = `
            <div class="modal-content parchment-bg" style="max-width:440px;text-align:center;padding:2rem;">
                <span class="close-btn" data-close><i class="fa-solid fa-xmark"></i></span>
                <h2 class="helm-title">&#9875; Watch Together &#9875;</h2>
                <p class="helm-sub">Gather your crew and watch in perfect sync.</p>
                <div style="margin:1.1rem 0 0.4rem;text-align:left;">
                    <label class="party-field-label">Your name</label>
                    <input id="party-name" class="pixel-select" maxlength="24" style="width:100%;">
                </div>
                <button class="pixel-btn action" id="party-create" style="width:100%;justify-content:center;margin-top:0.8rem;">
                    <i class="fa-solid fa-anchor"></i> Start a Crew
                </button>
                <div class="party-or">— or join one —</div>
                <div style="display:flex;gap:0.5rem;">
                    <input id="party-code-input" class="pixel-select" placeholder="CODE" maxlength="6"
                           style="flex:1;text-transform:uppercase;letter-spacing:2px;text-align:center;">
                    <button class="pixel-btn" id="party-join" style="justify-content:center;">Join</button>
                </div>
                <p class="party-tip">Share the invite link and friends hop in — no sign-up.</p>
            </div>`;
        document.body.appendChild(launchEl);

        launchEl.addEventListener('click', (e) => { if (e.target === launchEl) hideLaunch(); });
        launchEl.querySelector('[data-close]').addEventListener('click', hideLaunch);
        const nameInput = launchEl.querySelector('#party-name');
        nameInput.value = state.name;
        nameInput.addEventListener('change', () => {
            const v = nameInput.value.trim().slice(0, 24);
            if (v) { state.name = v; localStorage.setItem(LS_NAME, v); }
        });
        launchEl.querySelector('#party-create').addEventListener('click', () => {
            commitName(nameInput.value);
            hideLaunch();
            connect('new');
        });
        launchEl.querySelector('#party-join').addEventListener('click', () => {
            const code = launchEl.querySelector('#party-code-input').value.trim().toUpperCase();
            if (!code) { toast('Enter a crew code first.'); return; }
            commitName(nameInput.value);
            hideLaunch();
            connect(code);
        });
        launchEl.querySelector('#party-code-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') launchEl.querySelector('#party-join').click();
        });

        // --- docked crew panel ---
        dockEl = document.createElement('div');
        dockEl.id = 'party-dock';
        dockEl.className = 'party-dock hidden';
        dockEl.innerHTML = `
            <div class="party-dock-head">
                <span class="party-dock-title">&#9875; Crew &middot; <b id="party-code-label"></b></span>
                <div class="party-dock-actions">
                    <button id="party-copy-code" title="Copy crew code"><i class="fa-solid fa-hashtag"></i></button>
                    <button id="party-copy" title="Copy invite link"><i class="fa-solid fa-link"></i></button>
                    <button id="party-collapse" title="Collapse"><i class="fa-solid fa-chevron-down"></i></button>
                    <button id="party-leave" title="Leave crew"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="party-dock-body">
                <div id="party-members" class="party-members"></div>
                <button id="party-resync" class="party-resync" title="Snap to the crew's position">
                    <i class="fa-solid fa-rotate"></i> Resync
                </button>
                <div id="party-chat" class="party-chat"></div>
                <form id="party-chat-form" class="party-chat-form">
                    <input id="party-chat-input" placeholder="Message the crew…" autocomplete="off" maxlength="500">
                    <button type="submit" title="Send"><i class="fa-solid fa-paper-plane"></i></button>
                </form>
            </div>`;
        document.body.appendChild(dockEl);

        codeLabel = dockEl.querySelector('#party-code-label');
        membersEl = dockEl.querySelector('#party-members');
        chatBox = dockEl.querySelector('#party-chat');

        dockEl.querySelector('#party-copy-code').addEventListener('click', copyCode);
        dockEl.querySelector('#party-copy').addEventListener('click', copyInvite);
        dockEl.querySelector('#party-collapse').addEventListener('click', () => {
            state.collapsed = !state.collapsed;
            dockEl.classList.toggle('collapsed', state.collapsed);
            dockEl.querySelector('#party-collapse i').className =
                state.collapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
        });
        dockEl.querySelector('#party-leave').addEventListener('click', leave);
        dockEl.querySelector('#party-resync').addEventListener('click', () => {
            send({ type: 'sync_request' });
            toast('Snapping to the crew…');
        });
        dockEl.querySelector('#party-chat-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = dockEl.querySelector('#party-chat-input');
            const txt = input.value.trim();
            if (!txt) return;
            send({ type: 'chat', text: txt });
            input.value = '';
        });

        launcherBtn = document.getElementById('party-launch-btn');
        if (launcherBtn) launcherBtn.addEventListener('click', launcherClick);
    }

    function commitName(v) {
        v = (v || '').trim().slice(0, 24);
        if (v) { state.name = v; localStorage.setItem(LS_NAME, v); }
    }

    function showLaunch() {
        const ni = launchEl.querySelector('#party-name');
        if (ni) ni.value = state.name;
        launchEl.classList.remove('hidden');
    }
    function hideLaunch() { launchEl.classList.add('hidden'); }

    function showDock() {
        dockEl.classList.remove('hidden');
        // On phones, start collapsed (just the title bar above the nav) so the
        // crew panel doesn't swallow the screen; tap the chevron to expand.
        state.collapsed = window.innerWidth <= 768;
        dockEl.classList.toggle('collapsed', state.collapsed);
        const ic = dockEl.querySelector('#party-collapse i');
        if (ic) ic.className = state.collapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
        setLauncherActive(true);
    }
    function hideDock() { dockEl.classList.add('hidden'); }

    function setLauncherActive(on) {
        if (launcherBtn) launcherBtn.classList.toggle('party-active', !!on);
    }

    function renderDock() {
        if (codeLabel) codeLabel.textContent = state.code || '';
        renderMembers();
        setLauncherActive(state.connected);
    }

    function renderMembers() {
        if (!membersEl) return;
        membersEl.innerHTML = '';
        state.members.forEach(m => {
            const chip = document.createElement('span');
            chip.className = 'party-chip' + (m.id === state.hostId ? ' host' : '') + (m.id === state.memberId ? ' me' : '');
            const initials = (m.name || '?').slice(0, 2).toUpperCase();
            chip.innerHTML = `<span class="party-chip-av">${initials}</span>${escapeHtml(m.name || 'Captain')}${m.id === state.hostId ? ' <i class="fa-solid fa-anchor" title="Host"></i>' : ''}`;
            membersEl.appendChild(chip);
        });
    }

    function renderChat(name, text, mine) {
        if (!chatBox) return;
        const line = document.createElement('div');
        line.className = 'party-msg' + (mine ? ' mine' : '');
        line.innerHTML = `<span class="party-msg-name">${escapeHtml(name || 'Captain')}</span><span class="party-msg-text">${escapeHtml(text)}</span>`;
        chatBox.appendChild(line);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    function chatSystem(text) {
        if (!chatBox) return;
        const line = document.createElement('div');
        line.className = 'party-msg system';
        line.textContent = text;
        chatBox.appendChild(line);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    function copyCode() {
        if (!state.code) return;
        const done = () => toast('Crew code copied! ⚓');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(state.code).then(done).catch(() => prompt('Crew code:', state.code));
        } else { prompt('Crew code:', state.code); }
    }
    function copyInvite() {
        const link = `${location.origin}${location.pathname}?party=${state.code}`;
        const done = () => toast('Invite link copied! ⚓');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(done).catch(() => prompt('Copy this invite link:', link));
        } else {
            prompt('Copy this invite link:', link);
        }
    }

    // ------------------------------------------------------------------- toast
    let toastEl, toastTimer;
    function toast(text) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'party-toast';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // -------------------------------------------------------------------- init
    function init() {
        buildUI();
        renderDock();
        // Auto-join from a shared invite link (?party=CODE).
        const params = new URLSearchParams(location.search);
        const code = params.get('party');
        if (code) connect(code.toUpperCase());
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
