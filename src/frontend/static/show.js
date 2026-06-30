// Dedicated TV show page — seasons, episodes, server-backed watch progress.
(function () {
    const params = new URLSearchParams(location.search);
    const SHOW_ID = params.get('id');
    let SHOW_TITLE = 'Show';
    let SEASONS = [];
    let PROGRESS = {};   // `${season}_${episode}` -> progress row
    let CUR_SEASON = 1;

    const root = document.getElementById('show-root');
    const guest = () => (typeof getGuestId === 'function') ? getGuestId() : 'guest';
    const key = (s, e) => `${s}_${e}`;

    async function load() {
        if (!SHOW_ID) { root.innerHTML = '<div style="padding:60px;text-align:center">No show specified.</div>'; return; }
        const [details, seasons, prog] = await Promise.all([
            fetch(`/media/${SHOW_ID}?media_type=tv`).then(r => r.json()).catch(() => ({})),
            fetch(`/shows/${SHOW_ID}/seasons`).then(r => r.json()).catch(() => []),
            fetch(`/progress/${guest()}/${SHOW_ID}`).then(r => r.json()).catch(() => []),
        ]);
        SHOW_TITLE = details.title || details.name || 'Show';
        document.title = `Nautilus | ${SHOW_TITLE}`;
        SEASONS = (Array.isArray(seasons) ? seasons : [])
            .filter(s => (s.season_number ?? 0) >= 1)
            .sort((a, b) => a.season_number - b.season_number);
        loadProgress(prog);
        CUR_SEASON = SEASONS.length ? SEASONS[0].season_number : 1;
        const inprog = (Array.isArray(prog) ? prog : [])
            .filter(p => p.percentage > 0 && p.percentage < 90)
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
        if (inprog) CUR_SEASON = inprog.season;
        render(details);
    }

    function loadProgress(prog) {
        PROGRESS = {};
        (Array.isArray(prog) ? prog : []).forEach(p => { PROGRESS[key(p.season, p.episode)] = p; });
    }

    function render(details) {
        const poster = details.poster_path ? `https://image.tmdb.org/t/p/w342${details.poster_path}` : '';
        root.innerHTML = `
            <div class="show-hero">
                ${poster ? `<img class="show-hero-poster" src="${poster}" alt="">` : ''}
                <div class="show-hero-info">
                    <h1 class="show-hero-title">${SHOW_TITLE}</h1>
                    <p class="show-hero-overview">${details.overview || ''}</p>
                    <button class="pixel-btn action" id="show-continue"><i class="fa-solid fa-play"></i> <span id="continue-label">Start Watching</span></button>
                </div>
            </div>
            <div class="show-seasons" id="season-tabs"></div>
            <div class="show-episodes" id="episode-list"></div>`;
        renderSeasonTabs();
        renderEpisodes();
        document.getElementById('show-continue').onclick = continueWatching;
        updateContinueLabel();
    }

    function renderSeasonTabs() {
        const tabs = document.getElementById('season-tabs');
        tabs.innerHTML = '';
        SEASONS.forEach(s => {
            const b = document.createElement('button');
            b.className = 'season-tab' + (s.season_number === CUR_SEASON ? ' active' : '');
            b.textContent = `Season ${s.season_number}`;
            b.onclick = () => { CUR_SEASON = s.season_number; renderSeasonTabs(); renderEpisodes(); };
            tabs.appendChild(b);
        });
    }

    function renderEpisodes() {
        const list = document.getElementById('episode-list');
        const season = SEASONS.find(s => s.season_number === CUR_SEASON);
        list.innerHTML = '';
        if (!season || !Array.isArray(season.episodes) || !season.episodes.length) {
            list.innerHTML = '<div style="padding:20px;opacity:0.7;font-family:var(--font-pixel)">No episodes found.</div>';
            return;
        }
        season.episodes.slice().sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0)).forEach(ep => {
            const p = PROGRESS[key(CUR_SEASON, ep.episode_number)];
            const watched = p && p.percentage >= 90;
            const pct = p ? Math.min(p.percentage, 100) : 0;
            const still = ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : '';
            const row = document.createElement('div');
            row.className = 'episode-row' + (watched ? ' watched' : '');
            row.innerHTML = `
                <div class="ep-thumb">
                    ${still ? `<img src="${still}" loading="lazy" alt="">` : ''}
                    <div class="ep-play"><i class="fa-solid fa-play"></i></div>
                    ${watched ? '<div class="ep-check"><i class="fa-solid fa-check"></i></div>' : ''}
                </div>
                <div class="ep-meta">
                    <div class="ep-title">S${CUR_SEASON}E${ep.episode_number} &middot; ${ep.title || ep.name || ('Episode ' + ep.episode_number)}</div>
                    <div class="ep-sub">${ep.runtime_minutes ? ep.runtime_minutes + 'm &middot; ' : ''}${ep.air_date || ''}</div>
                    <div class="ep-overview">${ep.overview || ''}</div>
                    ${(pct > 0 && pct < 90) ? `<div class="ep-progress"><div class="ep-progress-fill" style="width:${pct}%"></div></div>` : ''}
                </div>`;
            row.onclick = () => playEpisode(CUR_SEASON, ep.episode_number);
            list.appendChild(row);
        });
    }

    function playEpisode(season, episode) {
        if (typeof SoundManager !== 'undefined') SoundManager.play('click');
        document.getElementById('m-title').textContent = SHOW_TITLE;
        document.getElementById('modal').classList.remove('hidden');
        playVideo('tv', parseInt(SHOW_ID), season, episode);
    }

    function nextUnwatched() {
        for (const s of SEASONS) {
            const eps = (s.episodes || []).slice().sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0));
            for (const ep of eps) {
                const p = PROGRESS[key(s.season_number, ep.episode_number)];
                if (!p || p.percentage < 90) return { season: s.season_number, episode: ep.episode_number, resume: !!(p && p.percentage > 0) };
            }
        }
        return null;
    }

    function continueWatching() {
        const n = nextUnwatched();
        if (n) playEpisode(n.season, n.episode);
        else if (SEASONS[0] && (SEASONS[0].episodes || []).length) playEpisode(SEASONS[0].season_number, SEASONS[0].episodes[0].episode_number);
    }

    function updateContinueLabel() {
        const label = document.getElementById('continue-label');
        if (!label) return;
        const n = nextUnwatched();
        if (n && n.resume) label.textContent = `Resume S${n.season}E${n.episode}`;
        else if (n) label.textContent = `Play S${n.season}E${n.episode}`;
        else label.textContent = 'Rewatch from start';
    }

    // Called by closePlayer (script.js) when the player overlay closes.
    window.refreshShowProgress = async function () {
        try {
            const prog = await fetch(`/progress/${guest()}/${SHOW_ID}`).then(r => r.json());
            loadProgress(prog);
            renderEpisodes();
            updateContinueLabel();
        } catch (e) { /* ignore */ }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
    else load();
})();
