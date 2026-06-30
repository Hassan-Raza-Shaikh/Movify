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
        root.innerHTML = `
            <div class="skel-hero">
                <div class="skel skel-hero-poster"></div>
                <div class="skel-hero-lines">
                    <div class="skel skel-line lg"></div>
                    <div class="skel skel-line sm"></div>
                    <div class="skel skel-line"></div>
                    <div class="skel skel-line"></div>
                    <div class="skel skel-line" style="width:78%"></div>
                </div>
            </div>
            <div style="padding:0 30px;"><div class="skel skel-title"></div></div>
            ${Array.from({ length: 6 }).map(() => '<div class="skel skel-ep"></div>').join('')}`;
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
        const _fy = (details.first_air_date || details.release_date || '').split('-')[0] || '';
        const _ly = (details.last_air_date || '').split('-')[0] || '';
        const year = _fy ? (_ly && _ly !== _fy ? `${_fy} – ${_ly}` : _fy) : '';
        const rating = (typeof details.vote_average === 'number' && details.vote_average) ? details.vote_average.toFixed(1) : '';
        root.innerHTML = `
            <div class="show-hero">
                ${poster ? `<img class="show-hero-poster" src="${poster}" alt="">` : ''}
                <div class="show-hero-info">
                    <h1 class="show-hero-title">${SHOW_TITLE}</h1>
                    <div class="m-meta" style="margin-bottom:0.6rem;">
                        ${year ? `<span class="pixel-badge">${year}</span>` : ''}
                        ${rating ? `<span class="pixel-badge"><i class="fa-solid fa-star"></i> ${rating}</span>` : ''}
                        ${SEASONS.length ? `<span class="pixel-badge">${SEASONS.length} Season${SEASONS.length === 1 ? '' : 's'}</span>` : ''}
                    </div>
                    <p class="show-hero-overview">${details.overview || ''}</p>
                    <div class="show-hero-actions" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                        <button class="pixel-btn action" id="show-continue"><i class="fa-solid fa-play"></i> <span id="continue-label">Start Watching</span></button>
                        <button class="pixel-btn" id="show-trailer"><i class="fa-solid fa-film"></i> Trailer</button>
                        <button class="pixel-btn" id="show-like" title="Like"><i class="fa-regular fa-heart"></i></button>
                        <button class="pixel-btn" id="show-list" title="Watchlist"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div id="show-trailer-box" class="hidden" style="margin-top:12px;"></div>
                </div>
            </div>
            <div class="show-seasons" id="season-tabs"></div>
            <div class="show-episodes" id="episode-list"></div>
            <div id="show-related"></div>`;
        renderSeasonTabs();
        renderEpisodes();
        document.getElementById('show-continue').onclick = continueWatching;
        document.getElementById('show-trailer').onclick = toggleTrailer;
        updateContinueLabel();
        setupInteractions(details);
        renderRelated();
    }

    function setupInteractions(details) {
        const showItem = {
            tmdb_id: parseInt(SHOW_ID), id: parseInt(SHOW_ID), media_type: 'tv',
            name: SHOW_TITLE, title: SHOW_TITLE,
            first_air_date: details.first_air_date, poster_path: details.poster_path, overview: details.overview
        };
        const likeBtn = document.getElementById('show-like');
        const listBtn = document.getElementById('show-list');
        if (likeBtn && typeof toggleInteraction === 'function') likeBtn.onclick = () => toggleInteraction('like', showItem, likeBtn);
        if (listBtn && typeof toggleInteraction === 'function') listBtn.onclick = () => toggleInteraction('watchlist', showItem, listBtn);
        if (typeof checkInteractionStatus === 'function') checkInteractionStatus(showItem, likeBtn, listBtn);
    }

    async function toggleTrailer() {
        const box = document.getElementById('show-trailer-box');
        if (!box) return;
        if (!box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; return; }
        box.classList.remove('hidden');
        box.innerHTML = '<div style="padding:10px;font-family:var(--font-pixel)">Loading trailer…</div>';
        try {
            const d = await fetch(`/media/${SHOW_ID}/trailer?media_type=tv`).then(r => r.json());
            if (d && d.key) {
                box.innerHTML = `<div style="position:relative;padding-bottom:48%;height:0;overflow:hidden;border:3px solid var(--gold);max-width:600px;"><iframe src="https://www.youtube.com/embed/${d.key}?rel=0&modestbranding=1" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
            } else {
                box.innerHTML = '<div style="padding:8px;opacity:0.7;font-family:var(--font-pixel)">No trailer found.</div>';
            }
        } catch (e) {
            box.innerHTML = '<div style="padding:8px;opacity:0.7;font-family:var(--font-pixel)">No trailer found.</div>';
        }
    }

    async function renderRelated() {
        const wrap = document.getElementById('show-related');
        if (!wrap) return;
        try {
            const list = await fetch(`/tv/${SHOW_ID}/recommendations`).then(r => r.json());
            const shows = (Array.isArray(list) ? list : []).filter(rel => rel.poster_path);
            if (!shows.length) return;
            wrap.innerHTML = `<div class="row-title" style="margin:1.6rem 0 0.4rem;">More like this</div>`;
            const row = document.createElement('div');
            row.className = 'row-scroller';
            shows.slice(0, 14).forEach(rel => {
                const id = rel.tmdb_id || rel.id;
                const name = rel.title || rel.name || '';
                const card = document.createElement('div');
                card.className = 'card';
                card.innerHTML = `<img src="https://image.tmdb.org/t/p/w300${rel.poster_path}" class="poster" loading="lazy" alt="${name}"><div class="card-overlay">${name}</div>`;
                card.onclick = () => { location.href = `/show?id=${id}`; };
                row.appendChild(card);
            });
            wrap.appendChild(row);
        } catch (e) { /* ignore */ }
    }

    function renderSeasonTabs() {
        const tabs = document.getElementById('season-tabs');
        tabs.innerHTML = '';
        SEASONS.forEach(s => {
            const b = document.createElement('button');
            b.className = 'season-tab' + (s.season_number === CUR_SEASON ? ' active' : '');
            const sy = (s.air_date || '').split('-')[0];
            b.textContent = `Season ${s.season_number}` + (sy ? ` · ${sy}` : '');
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
