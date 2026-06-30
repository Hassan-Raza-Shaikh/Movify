const API_BASE = "";
var nautPlayer = null;  // Our custom NautilusPlayer
var currentTmdbId = null, currentSeason = 1, currentEpisode = 1, currentType = 'movie';
let searchTimeout;
let currentHls = null;
let huntedStreams = [];  // All found stream results from hunt
let activeStreamIdx = 0; // Current stream index

// --- SOUND MANAGER ---
const SoundManager = {
    sounds: {},
    volume: 0.1,  // 10% volume
    hoverPool: [],
    hoverIdx: 0,
    hoverVolume: 0.13,  // subtle tick on each thumbnail
    hoverEnabled: (typeof localStorage !== 'undefined' && localStorage.getItem('nautilus_hover_sound') === 'off') ? false : true,
    hoverSound: (typeof localStorage !== 'undefined' && localStorage.getItem('nautilus_hover_tick')) || 'wood',  // wood | paper | type
    init() {
        // Preload sounds to reduce latency
        ['paper', 'coin', 'wood', 'click'].forEach(name => {
            const audio = new Audio(`/static/sounds/${name}.mp3`);
            audio.volume = this.volume;
            this.sounds[name] = audio;
        });
        this._buildHoverPool();
    },
    _buildHoverPool() {
        // Pool of tick instances so sweeping across many thumbnails fires many
        // overlapping ticks instead of one element cutting itself off.
        this.hoverPool = [];
        for (let i = 0; i < 6; i++) {
            const a = new Audio(`/static/sounds/tick-${this.hoverSound}.mp3`);
            a.volume = this.hoverVolume;
            this.hoverPool.push(a);
        }
    },
    play(name) {
        try {
            const audio = this.sounds[name];
            if (audio) {
                audio.volume = this.volume;
                audio.currentTime = 0.05; // Skip first 50ms to reduce silence delay
                audio.play().catch(() => {}); // Ignore autoplay errors
            } else {
                // Fallback if not preloaded
                const a = new Audio(`/static/sounds/${name}.mp3`);
                a.volume = this.volume;
                a.play().catch(() => {});
            }
        } catch (e) {
            // Ignore audio system errors
        }
    },
    // Quiet, short tick when hovering a thumbnail. Round-robins the pool so a fast
    // sweep over many cards produces many overlapping ticks.
    playHover() {
        if (!this.hoverEnabled || !this.hoverPool.length) return;
        try {
            const a = this.hoverPool[this.hoverIdx];
            this.hoverIdx = (this.hoverIdx + 1) % this.hoverPool.length;
            a.currentTime = 0;
            a.volume = this.hoverVolume;
            a.play().catch(() => {});
        } catch (e) {}
    },
    setHoverEnabled(on) {
        this.hoverEnabled = !!on;
        try { localStorage.setItem('nautilus_hover_sound', on ? 'on' : 'off'); } catch (e) {}
    },
    // Switch the hover tick: SoundManager.setHoverSound('wood' | 'paper' | 'type')
    setHoverSound(name) {
        this.hoverSound = name;
        try { localStorage.setItem('nautilus_hover_tick', name); } catch (e) {}
        this._buildHoverPool();
    }
};

// Initialize sounds on load
document.addEventListener('DOMContentLoaded', () => SoundManager.init());

// Quiet tick when the cursor enters a new thumbnail card — sweep across a row and
// it fires a little run of clicks. Delegated so it works for all dynamic cards.
document.addEventListener('DOMContentLoaded', () => {
    let _lastHoverCard = null;
    document.addEventListener('mouseover', (e) => {
        const card = e.target.closest ? e.target.closest('.card, .rec-card') : null;
        if (card) {
            if (card !== _lastHoverCard) {
                _lastHoverCard = card;
                SoundManager.playHover();
            }
        } else {
            _lastHoverCard = null;
        }
    }, { passive: true });
});

// --- SPIN THE HELM (constrained roulette) ---
function openHelm() {
    const ov = document.getElementById('helm-overlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    SoundManager.play('paper');
    document.getElementById('helm-result').textContent = '';
    // Populate genres once
    const gsel = document.getElementById('helm-genre');
    if (gsel && gsel.options.length <= 1) {
        fetch('/genres/overview').then(r => r.json()).then(gs => {
            (gs || []).forEach(g => {
                if (!g || !g.id) return;
                const o = document.createElement('option');
                o.value = g.id; o.textContent = g.name;
                gsel.appendChild(o);
            });
        }).catch(() => {});
    }
}

function closeHelm() {
    const ov = document.getElementById('helm-overlay');
    if (ov) ov.classList.add('hidden');
}

let _helmSpinning = false, _helmAngle = 0, _helmPick = null, _helmPickType = 'movie';
async function spinHelm() {
    if (_helmSpinning) return;
    _helmSpinning = true;
    const wheel = document.getElementById('helm-wheel');
    const resultEl = document.getElementById('helm-result');
    resultEl.textContent = '';
    SoundManager.play('wood'); // timber creak as the helm turns

    // Spin: several full turns + a random landing offset
    _helmAngle += 360 * 4 + Math.floor(Math.random() * 360);
    if (wheel) wheel.style.transform = `rotate(${_helmAngle}deg)`;

    // Fetch a fated pick (in parallel with the spin animation)
    const type = document.getElementById('helm-type').value;
    const genre = document.getElementById('helm-genre').value;
    let pick = null;
    try {
        let url;
        if (type === 'movie') url = genre ? `/movies/genre/${genre}?limit=40` : `/movies/random?limit=40`;
        else url = genre ? `/shows/genre/${genre}?limit=40` : `/shows?limit=120`;
        const list = await fetch(url).then(r => r.json());
        if (Array.isArray(list) && list.length) pick = list[Math.floor(Math.random() * list.length)];
    } catch (e) { /* ignore */ }

    // Reveal once the wheel settles (~2.2s matches the CSS transition).
    // Show the pick and let fate be re-rolled instead of auto-opening.
    setTimeout(() => {
        _helmSpinning = false;
        if (pick) {
            SoundManager.play('coin');
            _helmPick = pick; _helmPickType = type;
            const name = pick.title || pick.name || 'your pick';
            const yr = (pick.release_date || pick.first_air_date || '').slice(0, 4);
            const img = pick.poster_path ? `https://image.tmdb.org/t/p/w185${pick.poster_path}` : '';
            resultEl.innerHTML =
                '<div class="helm-pick">' +
                    '<div class="helm-pick-label">The helm points to&hellip;</div>' +
                    (img ? `<img class="helm-pick-poster" src="${img}" alt="${name}">` : '') +
                    `<div class="helm-pick-title">${name}${yr ? ` (${yr})` : ''}</div>` +
                    '<div class="helm-pick-actions">' +
                        '<button class="pixel-btn action" onclick="helmSetSail()"><i class="fa-solid fa-anchor"></i> Set Sail</button>' +
                        '<button class="pixel-btn" onclick="spinHelm()"><i class="fa-solid fa-arrows-rotate"></i> Spin Again</button>' +
                    '</div>' +
                '</div>';
        } else {
            resultEl.textContent = 'The seas were empty — spin again!';
        }
    }, 2250);
}

function helmSetSail() {
    if (!_helmPick) return;
    const p = _helmPick, t = _helmPickType;
    closeHelm();
    openModal(p, t);
}

// --- AUTO-NEXT EPISODE ---
async function getNextEpisode() {
    try {
        const seasons = await fetch(`/shows/${currentTmdbId}/seasons`).then(r => r.json());
        if (Array.isArray(seasons) && seasons.length) {
            const norm = seasons
                .map(s => ({ n: s.season_number, eps: (s.episodes || []).map(e => e.episode_number).filter(x => x != null) }))
                .filter(s => s.n >= 1)
                .sort((a, b) => a.n - b.n);
            const cur = norm.find(s => s.n === currentSeason);
            if (cur && cur.eps.length) {
                const maxEp = Math.max(...cur.eps);
                if (currentEpisode < maxEp) return { season: currentSeason, episode: currentEpisode + 1 };
                const next = norm.find(s => s.n > currentSeason && s.eps.length);
                if (next) return { season: next.n, episode: Math.min(...next.eps) };
                return null; // end of the series
            }
        }
    } catch (e) { /* ignore — fall through */ }
    return { season: currentSeason, episode: currentEpisode + 1 };
}

function nautilusAutoNext() {
    if (localStorage.getItem('nautilus_autoplay_next') === 'off') return;
    getNextEpisode().then(next => { if (next) showNextEpisodeCountdown(next); });
}
window.nautilusAutoNext = nautilusAutoNext;

function showNextEpisodeCountdown(next) {
    const old = document.getElementById('autonext-overlay');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'autonext-overlay';
    let secs = 10;
    ov.innerHTML =
        '<div class="autonext-card">' +
            `<div class="autonext-title">Up Next &mdash; S${next.season}E${next.episode}</div>` +
            `<div class="autonext-sub">Setting sail in <span id="autonext-count">${secs}</span>s&hellip;</div>` +
            '<div class="autonext-actions">' +
                '<button class="pixel-btn action" id="autonext-now"><i class="fa-solid fa-play"></i> Play Now</button>' +
                '<button class="pixel-btn" id="autonext-cancel">Cancel</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(ov);
    const cleanup = () => { clearInterval(timer); const e = document.getElementById('autonext-overlay'); if (e) e.remove(); };
    const go = () => { cleanup(); SoundManager.play('wood'); playVideo('tv', currentTmdbId, next.season, next.episode); };
    document.getElementById('autonext-now').onclick = go;
    document.getElementById('autonext-cancel').onclick = cleanup;
    const timer = setInterval(() => {
        secs--;
        const c = document.getElementById('autonext-count');
        if (c) c.textContent = secs;
        if (secs <= 0) go();
    }, 1000);
}

// Mobile menu toggle handler
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('mobile-menu-toggle');
    const nav = document.getElementById('mobile-nav');
    if (toggle && nav) {
        toggle.addEventListener('click', (e) => {
            const open = nav.getAttribute('aria-hidden') === 'false';
            nav.setAttribute('aria-hidden', open ? 'true' : 'false');
            nav.style.display = open ? 'none' : 'block';
            toggle.innerHTML = open ? '<i class="fa-solid fa-bars"></i>' : '<i class="fa-solid fa-xmark"></i>';
        });
    }
});

// --- GUEST ID LOGIC ---
function getGuestId() {
    let gid = localStorage.getItem('nautilus_guest_id');
    if (!gid) {
        gid = crypto.randomUUID();
        localStorage.setItem('nautilus_guest_id', gid);
    }
    return gid;
}

// --- USER PREFERENCES (localStorage) ---
function setUserPrefs(prefs) {
    try {
        localStorage.setItem('nautilus_user_prefs', JSON.stringify(prefs));
    } catch (e) {
        console.error('Failed to save prefs', e);
    }
}

function getUserPrefs() {
    try {
        const raw = localStorage.getItem('nautilus_user_prefs');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    if (!window.IS_SHOW_PAGE) loadHome();

    const input = document.getElementById('search-input');
    const dropdown = document.getElementById('live-results');
    if (!input || !dropdown) return;   // show page has no search bar

    // Search Input Logic
    input.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        
        // Toggle Clear Button
        const clearBtn = document.getElementById('search-clear');
        if(clearBtn) clearBtn.style.display = query.length > 0 ? 'block' : 'none';

        if(query.length > 2) {
            dropdown.classList.remove('hidden');
            dropdown.innerHTML = '<div style="padding:15px;color:#888;text-align:center">Hunting...</div>';
            searchTimeout = setTimeout(() => liveSearch(query), 300);
        } else {
            dropdown.classList.add('hidden');
        }
    });
    
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            dropdown.classList.add('hidden');
            runSearch();
        }
    });
    
    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
});

function clearSearch() {
    const input = document.getElementById('search-input');
    input.value = '';
    document.getElementById('live-results').classList.add('hidden');
    if(document.getElementById('search-clear')) document.getElementById('search-clear').style.display = 'none';
    // Do NOT reload home, just clear results
    // loadHome(); 
}

// --- THEME TOGGLE ---
function toggleTheme() {
    const body = document.body;
    const current = body.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', next);
    localStorage.setItem('nautilus_theme', next);
    
    // Update Icon Text
    const btn = document.querySelector('.theme-toggle');
    if(next === 'dark') {
        btn.innerHTML = '<i class="fa-solid fa-sun"></i><span class="btn-text"> Light Mode</span>';
    } else {
        btn.innerHTML = '<i class="fa-solid fa-moon"></i><span class="btn-text"> Dark Mode</span>';
    }
}

// Init Theme
const savedTheme = localStorage.getItem('nautilus_theme') || 'light';
document.body.setAttribute('data-theme', savedTheme);
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('.theme-toggle');
    if(btn) {
            if(savedTheme === 'dark') {
                btn.innerHTML = '<i class="fa-solid fa-sun"></i><span class="btn-text"> Light Mode</span>';
            } else {
                btn.innerHTML = '<i class="fa-solid fa-moon"></i><span class="btn-text"> Dark Mode</span>';
            }
    }
    
    // Show disclaimer modal on first visit
    showDisclaimerIfFirstTime();
});

// Adjust main padding dynamically so content isn't hidden under the fixed header
function adjustMainPadding() {
    try {
        const header = document.querySelector('header');
        const main = document.querySelector('main');
        if (!header || !main) return;
        const rect = header.getBoundingClientRect();
        const extra = 20; // margin below header
        main.style.paddingTop = `${Math.ceil(rect.height + extra)}px`;
    } catch (e) { /* ignore */ }
}

// Run on load and resize
document.addEventListener('DOMContentLoaded', () => {
    adjustMainPadding();
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(adjustMainPadding, 120);
    });
});

// --- DISCLAIMER POPUP (First Visit) ---
function showDisclaimerIfFirstTime() {
    if (window.IS_SHOW_PAGE) return;
    const hasSeenDisclaimer = localStorage.getItem('nautilus_disclaimer_seen');
    if (hasSeenDisclaimer) return;
    
    const modal = document.getElementById('disclaimer-modal');
    const closeBtn = document.getElementById('disclaimer-close');
    const timerText = document.getElementById('timer-text');
    const closeText = document.getElementById('close-text');
    const timerCount = document.getElementById('timer-count');
    
    modal.classList.remove('hidden');
    
    let countdown = 15;
    const interval = setInterval(() => {
        countdown--;
        timerCount.textContent = countdown;
        
        if (countdown <= 0) {
            clearInterval(interval);
            closeBtn.disabled = false;
            closeBtn.style.opacity = '1';
            closeBtn.style.cursor = 'pointer';
            timerText.style.display = 'none';
            closeText.style.display = 'inline';
        }
    }, 1000);
    
    closeBtn.onclick = () => {
        localStorage.setItem('nautilus_disclaimer_seen', 'true');
        modal.classList.add('hidden');
        SoundManager.play('paper');
    };
}

// --- SEARCH ---
async function liveSearch(query) {
    const dropdown = document.getElementById('live-results');
    try {
        const res = await fetch(`/search?query=${encodeURIComponent(query)}`);
        const items = await res.json();
        dropdown.innerHTML = '';
        
        const validItems = items.filter(i => (i.title || i.name) && i.poster_path);

        if(validItems.length > 0) {
            validItems.slice(0, 6).forEach(item => {
                const div = document.createElement('div');
                div.className = 'live-item';
                const title = item.title || item.name;
                const date = item.release_date || item.first_air_date || '';
                const year = date.split('-')[0] || 'N/A';
                const img = `https://image.tmdb.org/t/p/w92${item.poster_path}`;
                
                div.innerHTML = `
                    <img src="${img}" class="live-poster" style="width:40px;height:60px;object-fit:cover;border:1px solid #2b1d16;">
                    <div class="live-info">
                        <span class="live-title">${title}</span>
                        <span class="live-year">${year}</span>
                    </div>
                `;
                div.onclick = () => {
                    dropdown.classList.add('hidden');
                    // Preserve media type so TV results open with episodes instead of PLAY
                    let type = item.media_type;
                    if (!type) {
                        type = (item.first_air_date || item.name) ? 'tv' : 'movie';
                    }
                    openModal(item, type);
                };
                dropdown.appendChild(div);
            });
        } else {
            dropdown.innerHTML = '<div style="padding:15px;color:#888;text-align:center">No signals found.</div>';
        }
    } catch (e) { console.error(e); }
}

async function runSearch() {
    const query = document.getElementById('search-input').value;
    if (!query) return;
    const container = document.getElementById('content-area');
    container.innerHTML = '<div style="padding:40px; text-align:center">Hunting...</div>';
    try {
        const res = await fetch(`/search?query=${encodeURIComponent(query)}`);
        const items = await res.json();
        container.innerHTML = '';
        if (items.length === 0) {
            container.innerHTML = '<div style="padding:40px; text-align:center">No signals found.</div>';
            return;
        }
        // Use a temporary row-like rendering that preserves per-item media type
        const title = `Results for "${query}"`;
        const section = document.createElement('section');
        section.className = 'row-wrapper';
        section.innerHTML = `<div class="row-title">${title}</div>`;
        const scroller = document.createElement('div');
        scroller.className = 'row-scroller';

        items.forEach(item => {
            const card = document.createElement('div');
            card.className = 'card';

            let type = item.media_type;
            if (!type) {
                type = (item.first_air_date || item.name) ? 'tv' : 'movie';
            }

            card.onclick = () => openModal(item, type);

            const name = item.title || item.name;
            const imgSrc = item.poster_path
                ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                : 'https://via.placeholder.com/300x450';

            card.innerHTML = `<img src="${imgSrc}" class="poster" loading="lazy" alt="${name}">`;
            scroller.appendChild(card);
        });

        section.appendChild(scroller);
        container.appendChild(section);
    } catch (err) {
        container.innerHTML = `<div style="padding:40px;color:#f55">Error: ${err}</div>`;
    }
}

// Helper: Fisher-Yates Shuffle
function shuffle(array) {
    if (!Array.isArray(array)) return [];
    let currentIndex = array.length, randomIndex;
    while (currentIndex != 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

// --- NAVIGATION & SIDEBAR ---
function setActiveNav(title) {
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.remove('active');
        if(el.getAttribute('title') === title) el.classList.add('active');
    });
}

function focusSearch() {
    const input = document.getElementById('search-input');
    if(input) {
        input.focus();
        setActiveNav('Search');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

async function loadCollection(type, page=1, filters={}) {
    const container = document.getElementById('content-area');
    container.innerHTML = '<div style="padding:40px; text-align:center;">Navigating Charts...</div>';
    window.scrollTo(0,0);
    
    let title = '';
    let endpoint = '';
    const PAGE_SIZE = 100;
    
    // Merge with saved filter state
    const genre = filters.genre || 0;
    const sort = filters.sort || 'popularity';
    const year = filters.year || 0;
    
    if (type === 'watchlist') {
         title = 'Watchlist';
         endpoint = `/collections/watchlist/${getGuestId()}`;
         setActiveNav('Watchlist');
    } else if (type === 'movies') {
        title = 'All Movies';
        let qs = `limit=${PAGE_SIZE}&skip=${(page-1)*PAGE_SIZE}&sort=${sort}`;
        if (genre) qs += `&genre=${genre}`;
        if (year) qs += `&year=${year}`;
        endpoint = `/movies?${qs}`;
        setActiveNav('Movies');
    } else if (type === 'tv') {
        title = 'All TV Shows';
        let qs = `limit=${PAGE_SIZE}&skip=${(page-1)*PAGE_SIZE}&sort=${sort}`;
        if (genre) qs += `&genre=${genre}`;
        if (year) qs += `&year=${year}`;
        endpoint = `/shows?${qs}`;
        setActiveNav('TV Shows');
    }

    try {
        const res = await fetch(endpoint);
        let items = await res.json();
        
        if (type === 'watchlist' && Array.isArray(items)) items = items.reverse();

        container.innerHTML = '';
        
        // --- FILTER BAR (Movies & TV only) ---
        if (type === 'movies' || type === 'tv') {
            const filterBar = buildFilterBar(type, page, { genre, sort, year });
            container.appendChild(filterBar);
        }
        
        if (Array.isArray(items) && items.length > 0) {
            const wrapper = document.createElement('div');
            wrapper.className = 'row-wrapper';
            
            const hasNextPage = items.length >= PAGE_SIZE;
            // Estimate max pages (we don't know total, so allow up to page+1 if items fill)
            const maxPage = hasNextPage ? Math.max(page + 5, 10) : page;

            function makePaginationBar() {
                const bar = document.createElement('div');
                bar.className = 'filter-pagination';
                const go = (p) => loadCollection(type, p, { genre, sort, year });

                function addBtn(label, targetPage, disabled, active) {
                    const btn = document.createElement('button');
                    btn.className = 'page-btn' + (active ? ' active' : '');
                    btn.innerHTML = label;
                    btn.disabled = disabled;
                    if (!disabled && !active) btn.onclick = () => go(targetPage);
                    bar.appendChild(btn);
                    return btn;
                }

                // << First
                addBtn('&laquo;', 1, page <= 1, false);
                // < Prev
                addBtn('&lsaquo;', page - 1, page <= 1, false);

                // Page number buttons
                let startP = Math.max(1, page - 4);
                let endP = Math.min(maxPage, startP + 9);
                if (endP - startP < 9) startP = Math.max(1, endP - 9);

                if (startP > 1) {
                    addBtn('1', 1, false, page === 1);
                    if (startP > 2) {
                        const dots = document.createElement('span');
                        dots.className = 'page-ellipsis';
                        dots.textContent = '...';
                        bar.appendChild(dots);
                    }
                }

                for (let p = startP; p <= endP; p++) {
                    // Don't duplicate page 1 if already shown above
                    if (p === 1 && startP > 1) continue;
                    addBtn(String(p), p, false, p === page);
                }

                if (endP < maxPage) {
                    const dots = document.createElement('span');
                    dots.className = 'page-ellipsis';
                    dots.textContent = '...';
                    bar.appendChild(dots);
                }

                // > Next
                addBtn('&rsaquo;', page + 1, !hasNextPage, false);
                // >> Last (estimate)
                addBtn('&raquo;', maxPage, !hasNextPage, false);

                return bar;
            }

            const titleText = genre ? `${GENRE_MAP[genre] || 'Filtered'} ${type === 'tv' ? 'Series' : 'Movies'}` : title;
            wrapper.innerHTML = `<div class="row-title">${titleText}</div>`;
            wrapper.appendChild(makePaginationBar());
            
            const grid = document.createElement('div');
            grid.className = 'collection-grid';
            
            items.forEach(item => {
                if (!item.poster_path || (!item.title && !item.name)) return;
                const card = document.createElement('div');
                card.className = 'card';
                let mType = item.media_type;
                if (!mType) mType = (type === 'tv') ? 'tv' : 'movie';
                if (isUnavailable(item, mType)) return;
                card.onclick = () => openModal(item, mType);
                const name = item.title || item.name;
                const imgSrc = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
                card.innerHTML = `<img src="${imgSrc}" class="poster" loading="lazy" alt="${name}"><div class="card-overlay">${name}</div>`;
                addAvailBadge(card, item, mType);
                grid.appendChild(card);
            });
            
            wrapper.appendChild(grid);
            wrapper.appendChild(makePaginationBar());
            container.appendChild(wrapper);
        } else {
            container.innerHTML += `<div style="padding:50px; text-align:center; font-size:1.5rem; color:#888;">No results found. <button class="pixel-btn" onclick="loadCollection('${type}')">Clear Filters</button></div>`;
        }
    } catch (e) {
        console.error(e);
        container.innerHTML = '<div style="padding:40px; color:#f55">Navigation Error.</div>';
    }
}

// Genre ID → Name map
const GENRE_MAP = {
    28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
    80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
    14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
    9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie',
    53: 'Thriller', 10752: 'War', 37: 'Western',
    10759: 'Action & Adventure', 10765: 'Sci-Fi & Fantasy', 10768: 'War & Politics'
};

// --- Availability heuristics: hide unreleased movies, tag likely CAM/TS ---
function _itemType(item, fixedType) {
    let t = fixedType;
    if (!t || t === 'mixed') {
        t = (item.media_type === 'tv' || item.media_type === 'movie')
            ? item.media_type
            : ((item.name || item.first_air_date) ? 'tv' : 'movie');
    }
    return t;
}
function isUnavailable(item, fixedType) {
    // Hide movies whose release is still in the future (no digital release yet)
    if (_itemType(item, fixedType) !== 'movie') return false;
    const rd = item.release_date;
    if (!rd) return false;
    const d = new Date(rd);
    return !isNaN(d) && d.getTime() > Date.now();
}
function availabilityTag(item, fixedType) {
    if (_itemType(item, fixedType) !== 'movie') return null;
    const rd = item.release_date;
    if (!rd) return null;
    const d = new Date(rd);
    if (isNaN(d)) return null;
    const days = (Date.now() - d.getTime()) / 86400000;
    if (days < 0) return 'SOON';       // future release
    if (days < 30) return 'CAM/TS?';   // theatrical-only window — likely low quality
    return null;
}
function addAvailBadge(card, item, fixedType) {
    const tag = availabilityTag(item, fixedType);
    if (!tag) return;
    const b = document.createElement('div');
    b.className = 'avail-badge';
    b.textContent = tag;
    card.appendChild(b);
}

function buildFilterBar(type, page, current) {
    const bar = document.createElement('div');
    bar.className = 'filter-bar';

    // --- Genre dropdown ---
    const genreGroup = document.createElement('div');
    genreGroup.className = 'filter-group';
    genreGroup.innerHTML = '<label class="filter-label">Genre</label>';
    const genreSel = document.createElement('select');
    genreSel.className = 'pixel-filter-select';
    genreSel.innerHTML = '<option value="0">All Genres</option>';
    const genreIds = type === 'tv'
        ? [10759, 16, 35, 80, 99, 18, 10751, 9648, 10765, 10768, 37]
        : [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37];
    genreIds.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = GENRE_MAP[id] || id;
        if (current.genre == id) opt.selected = true;
        genreSel.appendChild(opt);
    });
    genreSel.onchange = () => loadCollection(type, 1, { genre: parseInt(genreSel.value), sort: current.sort, year: parseInt(yearSel.value) });
    genreGroup.appendChild(genreSel);

    // --- Sort dropdown ---
    const sortGroup = document.createElement('div');
    sortGroup.className = 'filter-group';
    sortGroup.innerHTML = '<label class="filter-label">Sort By</label>';
    const sortSel = document.createElement('select');
    sortSel.className = 'pixel-filter-select';
    [['popularity','Popular'], ['title','A-Z'], ['year','Newest'], ['rating','Top Rated']].forEach(([val, lab]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = lab;
        if (current.sort === val) opt.selected = true;
        sortSel.appendChild(opt);
    });
    sortSel.onchange = () => loadCollection(type, 1, { genre: parseInt(genreSel.value), sort: sortSel.value, year: parseInt(yearSel.value) });
    sortGroup.appendChild(sortSel);

    // --- Year dropdown ---
    const yearGroup = document.createElement('div');
    yearGroup.className = 'filter-group';
    yearGroup.innerHTML = '<label class="filter-label">Year</label>';
    const yearSel = document.createElement('select');
    yearSel.className = 'pixel-filter-select';
    yearSel.innerHTML = '<option value="0">All Years</option>';
    const thisYear = new Date().getFullYear();
    for (let y = thisYear; y >= 1970; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        if (current.year == y) opt.selected = true;
        yearSel.appendChild(opt);
    }
    yearSel.onchange = () => loadCollection(type, 1, { genre: parseInt(genreSel.value), sort: sortSel.value, year: parseInt(yearSel.value) });
    yearGroup.appendChild(yearSel);

    // --- Clear button ---
    const clearBtn = document.createElement('button');
    clearBtn.className = 'pixel-btn filter-clear';
    clearBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Clear';
    clearBtn.onclick = () => loadCollection(type, 1, {});

    bar.appendChild(genreGroup);
    bar.appendChild(sortGroup);
    bar.appendChild(yearGroup);
    bar.appendChild(clearBtn);
    return bar;
}

// --- HOME LOADING (Data-Driven) ---
async function loadHome() {
    setActiveNav('Home');
    const container = document.getElementById('content-area');
    container.innerHTML = '<div style="padding:40px; text-align:center;">Initializing...</div>';
    
    try {
        // Parallel fetch
        const [resTrending, resTopMovies, resNewMovies, resTopShows, resNewShows, resRecs, resCollections, resAnimated, resRandom] = await Promise.all([
            fetch(`/trending?days=7&limit=30`),
            fetch(`/movies/top_rated_alltime?limit=200`),
            fetch(`/movies/new_releases?days=90&limit=80`),
            fetch(`/shows/top_rated_alltime?limit=200`),
            fetch(`/shows/new_releases?days=90&limit=80`),
            (function(){
                const prefs = localStorage.getItem('nautilus_user_prefs');
                const headers = prefs ? { 'X-User-Prefs': prefs } : {};
                return fetch(`/recommend/guest/${getGuestId()}`, { headers });
            })(),
            fetch(`/collections/ai`),
            fetch(`/movies/genre/16?limit=20`), // animated spotlight
            fetch(`/movies/random?limit=18`)
        ]);

        const trending = await resTrending.json();
        const moviesTop = await resTopMovies.json();
        const moviesNew = await resNewMovies.json();
        const showsTop = await resTopShows.json();
        const showsNew = await resNewShows.json();
        const recs = await resRecs.json();
        const collections = await resCollections.json();
        const animated = await resAnimated.json();
        const random = await resRandom.json();
        
        const trendingMovies = (trending && trending.movies) ? trending.movies : [];
        const trendingShows = (trending && trending.shows) ? trending.shows : [];
        const curated1 = collections && collections.cluster_1 ? shuffle(collections.cluster_1) : null;
        const curated2 = collections && collections.cluster_2 ? shuffle(collections.cluster_2) : null;
        const curated3 = collections && collections.cluster_3 ? shuffle(collections.cluster_3) : null;

        container.innerHTML = '';

        // 0. Continue Watching (from localStorage progress data)
        const continueItems = getContinueWatchingItems();
        if (continueItems.length > 0) createContinueWatchingRow(continueItems);

        // 1. RecSys Row (only if user has real interactions)
        if(Array.isArray(recs) && recs.length > 0) createRow('Based on Your Taste', recs, 'mixed');

        // 2. Trending
        if(trendingMovies.length > 0) createRow('Trending Now', trendingMovies, 'movie');
        if(trendingShows.length > 0) createRow('Trending Series', trendingShows, 'tv');

        // 3. Top Rated then New
        if (moviesTop && moviesTop.length > 0) createRow('Top Rated', moviesTop, 'movie');
        if (moviesNew && moviesNew.length > 0) createRow('New Releases', moviesNew, 'movie');
        if (showsTop && showsTop.length > 0) createRow('Top Rated (Series)', showsTop, 'tv');
        if (showsNew && showsNew.length > 0) createRow('New Releases (Series)', showsNew, 'tv');
        
        // 4. Curated Collections
        if(curated2 && curated2.items && curated2.items.length > 0) createRow(curated2.name || 'Critics\' Picks', curated2.items, 'movie');
        if(curated3 && curated3.items && curated3.items.length > 0) createRow(curated3.name || 'Hidden Gems', curated3.items, 'movie');
        if(curated1 && curated1.items && curated1.items.length > 0 && trendingMovies.length === 0) createRow(curated1.name || 'Trending Now', curated1.items, 'movie');

        // 5. Spotlight Genres
        if(animated.length > 0) createRow('Animated Worlds', shuffle(animated), 'movie');

        // 6. Random Row with Regen
        if(random.length > 0) createRow('Random Picks', shuffle(random), 'movie', true);

    } catch (err) {
        console.error(err);
        container.innerHTML = `<div style="padding:40px;color:#f55">System Error. Check console.</div>`;
    }
}

function createRow(title, items, fixedType=null, hasRegen=false) {
    const container = document.getElementById('content-area');
    const section = document.createElement('section');
    section.className = 'row-wrapper';
    
    let titleHtml = `<div class="row-title">${title}`;
    if (hasRegen) {
        titleHtml += ` <button onclick="refreshRandom(this)" class="regen-btn">Regenerate</button>`;
    }
    titleHtml += `</div>`;
    
    section.innerHTML = titleHtml;
    const scroller = document.createElement('div');
    scroller.className = 'row-scroller';
    if (hasRegen) scroller.id = 'random-scroller';

    // Filter out obviously-empty or malformed items (no title/name or missing/invalid poster)
    const filtered = items.filter(item => {
        const hasTitle = !!(item && (item.title || item.name));
        let poster = item && item.poster_path;
        // Treat literal strings 'undefined'/'null' and empty as missing
        const badPoster = poster === undefined || poster === null || String(poster).trim() === '' || String(poster).toLowerCase() === 'undefined' || String(poster).toLowerCase() === 'null';
        const hasPoster = !badPoster;
        return hasTitle && hasPoster && !isUnavailable(item, fixedType);
    });

    if (filtered.length === 0) {
        // Nothing valid to show in this row; skip rendering it
        return;
    }

    filtered.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card';
        
        // LOGIC FIX: If fixedType is passed (e.g. 'tv'), use it. 
        // Otherwise try to guess from item properties.
        let type = fixedType;
        if (!type || type === 'mixed') {
             // Check explicit media_type first (from recommend endpoint)
             if (item.media_type === 'tv' || item.media_type === 'movie') {
                 type = item.media_type;
             } else {
                 type = (item.name || item.first_air_date) ? 'tv' : 'movie';
             }
        }

        // Pass the determined type to openModal
        card.onclick = () => openModal(item, type);
        
    const name = item.title || item.name;
    const imgSrc = item.poster_path && String(item.poster_path).toLowerCase() !== 'undefined' ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : 'https://via.placeholder.com/300x450';
        
        card.innerHTML = `<img src="${imgSrc}" class="poster" loading="lazy" alt="${name}"><div class="card-overlay">${name}</div>`;
        addAvailBadge(card, item, type);
        scroller.appendChild(card);
    });

    // Arrows (pirate compass style, scroll-aware visibility)
    const prevBtn = document.createElement('button');
    prevBtn.className = 'row-arrow prev';
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    prevBtn.title = 'Sail Back';
    prevBtn.onclick = () => { SoundManager.play('wood'); scroller.scrollBy({ left: -800, behavior: 'smooth' }); };
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'row-arrow next';
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    nextBtn.title = 'Sail Forward';
    nextBtn.onclick = () => { SoundManager.play('wood'); scroller.scrollBy({ left: 800, behavior: 'smooth' }); };

    // Hide arrows when at start/end of scroll
    function updateArrowVisibility() {
        const atStart = scroller.scrollLeft <= 5;
        const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 5;
        prevBtn.style.opacity = atStart ? '0' : '1';
        prevBtn.style.pointerEvents = atStart ? 'none' : 'auto';
        nextBtn.style.opacity = atEnd ? '0' : '1';
        nextBtn.style.pointerEvents = atEnd ? 'none' : 'auto';
    }
    scroller.addEventListener('scroll', updateArrowVisibility);
    // Also check after images load
    setTimeout(updateArrowVisibility, 100);
    setTimeout(updateArrowVisibility, 500);

    section.appendChild(prevBtn);
    section.appendChild(nextBtn);
    section.appendChild(scroller);
    container.appendChild(section);
}

// --- MODAL ---
function openModal(item, typeOverride=null) {
    // TV shows have their own dedicated page now
    if (_itemType(item, typeOverride) === 'tv') {
        window.location.href = `/show?id=${item.tmdb_id || item.id}`;
        return;
    }
    SoundManager.play('paper');
    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content-wrapper');
    
    // Reset UI
    document.querySelector('.modal-header').classList.remove('hidden');
    document.getElementById('player-wrapper').classList.add('hidden');
    
    // Force show modal immediately
    modal.classList.remove('hidden');

    // Smart Type Detection
    let type = typeOverride;
    if (!type) {
        if (item.media_type) type = item.media_type;
        else if (item.first_air_date || item.name) type = 'tv';
        else type = 'movie';
    }
    const isMovie = (type === 'movie');

    // Populate Info
    document.getElementById('m-title').textContent = item.title || item.name;
    document.getElementById('m-desc').textContent = item.overview || 'No description available.';
    document.getElementById('m-poster').src = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : 'https://via.placeholder.com/360x540';
    
    const date = item.release_date || item.first_air_date || '';
    document.getElementById('m-year').textContent = date.split('-')[0];


    // Score Normalization (UI Bug Fix)
    let score = '';
    if (typeof item.popularity_score === 'number') {
        let val = item.popularity_score;
        if (val > 100) val = 98; // Cap raw scores
        else if (val <= 1) val = val * 100;
        score = `${Math.round(val)}% Loot Value`; // Changed from "Match" to "Loot Value"
    }
    document.getElementById('m-score').textContent = score;

    // AI Badges (Regression & Classification)
    const badgeRow = document.getElementById('ai-badges-row');
    badgeRow.innerHTML = ''; // Clear previous badges
    
    if (isMovie) {
        const tmdbId = item.tmdb_id || item.id;
        // 1. Genre (multi-label aware, comma-separated)
        fetch(`/predict/genre/${tmdbId}`)
            .then(r => r.json())
            .then(d => {
                try {
                    if (d && Array.isArray(d.genres) && d.genres.length > 0) {
                        const sorted = [...d.genres].sort((a, b) => (b.score || 0) - (a.score || 0));
                        const names = sorted.map(g => g.name).filter(Boolean);
                        if (names.length > 0) {
                            const text = `Genres: ${names.join(', ')}`;
                            addBadgeToRow(text);
                        }
                    } else if (d && d.genre) {
                        // Legacy single-genre response
                        addBadgeToRow(`Genre: ${d.genre}`);
                    }
                } catch (err) {
                    console.error('Error rendering genre badges', err);
                }
            })
            .catch(err => console.error('Genre prediction failed', err));
    }

    // Related (Association + fallback) for both movies and TV
    const tmdbIdForRelated = item.tmdb_id || item.id;
    fetch(`/related/${tmdbIdForRelated}`)
        .then(r => r.json())
        .then(list => {
            try {
                const relatedContainerId = 'related-strip';
                let existing = document.getElementById(relatedContainerId);
                if (existing) existing.remove();

                if (!Array.isArray(list) || list.length === 0) return;

                const panel = document.createElement('div');
                panel.id = relatedContainerId;
                panel.style.cssText = 'margin-top:18px; padding-top:14px; border-top:1px solid rgba(139,115,85,0.3); max-width:100%; overflow:hidden;';

                const heading = document.createElement('div');
                heading.textContent = 'More like this';
                heading.style.cssText = 'font-family:var(--font-header); font-size:1.4rem; margin-bottom:10px; color:var(--ink);';
                panel.appendChild(heading);

                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;max-width:100%;';

                list.slice(0, 8).forEach(rel => {
                    const card = document.createElement('div');
                    card.className = 'card rec-card';   // reuse main card styling + hover animation

                    const rType = rel.media_type || ((rel.first_air_date || rel.name) ? 'tv' : 'movie');
                    card.onclick = () => openModal(rel, rType);

                    const rName = rel.title || rel.name;
                    const rImg = rel.poster_path
                        ? `https://image.tmdb.org/t/p/w185${rel.poster_path}`
                        : 'https://via.placeholder.com/185x278';

                    card.innerHTML = `
                        <img src="${rImg}" class="poster" loading="lazy" alt="${rName}">
                        <div class="card-overlay">${rName}</div>
                    `;
                    row.appendChild(card);
                });

                panel.appendChild(row);
                // Append below the modal info section
                const modalInfo = document.querySelector('.modal-info');
                if (modalInfo) modalInfo.appendChild(panel);
            } catch (err) {
                console.error('Error rendering related strip', err);
            }
        })
        .catch(err => console.error('Related fetch failed', err));

    // State & Buttons
    currentTmdbId = item.tmdb_id || item.id;
    currentType = type;
    currentSeason = 1;
    currentEpisode = 1;
    
    // --- Interaction Buttons (Like & Watchlist) ---
    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'inline-flex';
    btnGroup.style.gap = '10px';
    btnGroup.style.marginLeft = '10px';
    btnGroup.id = 'modal-actions';

    // Helper: Create Button
    const createActionBtn = (iconClass, action) => {
        const btn = document.createElement('button');
        btn.className = 'pixel-btn';
        btn.innerHTML = `<i class="${iconClass}"></i>`;
        btn.dataset.action = action;
        btn.style.cssText = "font-size:1.6rem; padding: 12px 18px;";
        return btn;
    };

    const likeBtn = createActionBtn('fa-regular fa-heart', 'like'); // empty heart
    const listBtn = createActionBtn('fa-solid fa-plus', 'watchlist'); // plus

    likeBtn.onclick = () => toggleInteraction('like', item, likeBtn);
    listBtn.onclick = () => toggleInteraction('watchlist', item, listBtn);

    btnGroup.appendChild(likeBtn);
    btnGroup.appendChild(listBtn);
    
    const playBtn = document.querySelector('#play-btn');
    if (playBtn) {
        // Cleanup old buttons/groups
        const oldGroup = document.getElementById('modal-actions');
        if(oldGroup) oldGroup.remove();
        
        playBtn.parentNode.insertBefore(btnGroup, playBtn.nextSibling);
    }

    // Check Status
    checkInteractionStatus(item, likeBtn, listBtn);

    if (playBtn) {
        playBtn.style.display = isMovie ? 'block' : 'none';
        playBtn.onclick = () => playVideo(currentType, currentTmdbId);
        playBtn.innerText = '▶ PLAY';
    }

    const epSection = document.getElementById('m-episodes');
    if (isMovie) {
        epSection.classList.add('hidden');
    } else {
        epSection.classList.remove('hidden');
        // For TV, show seasons/episodes list and hook clicks into playVideo
        // Prefer tmdb_id when available (some rows come from ML cache with only tmdb_id)
        const seasonTarget = item.tmdb_id || item.id;
        loadSeasons(seasonTarget);
    }

    // Lazy-fill missing overview/year without blocking modal open
    (function(){
        const tmdbId = item.tmdb_id || item.id;
        if (!tmdbId) return;
        const descEl = document.getElementById('m-desc');
        const yearEl = document.getElementById('m-year');
        const missingOverview = !(item.overview && item.overview.trim());
        const missingYear = !(item.release_date || item.first_air_date);
        if (!missingOverview && !missingYear) return;
        // Fetch lightweight media details; don't block UI
        fetch(`/media/${tmdbId}`).then(r => r.json()).then(d => {
            try {
                if (d && d.overview && missingOverview) descEl.textContent = d.overview;
                const date = d.release_date || d.first_air_date || '';
                if (date && missingYear) yearEl.textContent = date.split('-')[0];
            } catch (e) { /* ignore */ }
        }).catch(() => {});
    })();
    
    // Load trailer preview
    loadTrailerPreview(currentTmdbId, type);
    
    modal.classList.add('active');
}

function addBadge(text) {
    const metaDiv = document.querySelector('.m-meta');
    const badge = document.createElement('span');
    badge.className = 'ai-badge';
    badge.style.cssText = "margin-left:10px; color:#ff0055; font-weight:700; border:1px solid #ff0055; padding:2px 6px; border-radius:4px; font-size:0.75rem;";
    badge.textContent = text;
    metaDiv.appendChild(badge);
}

function addBadgeToRow(text) {
    const badgeRow = document.getElementById('ai-badges-row');
    const span = document.createElement('span');
    span.className = 'ai-badge';
    span.textContent = text;
    badgeRow.appendChild(span);
}

function closeModal() { 
    document.getElementById('modal').classList.add('hidden'); 
    closePlayer();
    // Clean up trailer
    const tp = document.getElementById('trailer-preview');
    if (tp) { tp.classList.add('hidden'); document.getElementById('trailer-iframe').src = 'about:blank'; }
}
function backdropClose(e) { if (e.target.id === 'modal') closeModal(); }
/* demo video commit */
async function loadSeasons(showId) {
    const list = document.getElementById('ep-list');
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#888">Accessing Archives...</div>';
    
    try {
        const res = await fetch(`/shows/${showId}/seasons`);
        const seasons = await res.json();
        list.innerHTML = '';
        
        if (!seasons || seasons.length === 0) {
             list.innerHTML = '<div style="padding:20px;text-align:center;color:#f55">No episodes indexed.</div>';
             return;
        }
        
        seasons.forEach(season => {
            const label = season.season_number === 0 ? "Specials" : `Season ${season.season_number}`;
            const div = document.createElement('div');
            div.innerHTML = `<div style="font-weight:bold; margin:20px 0 10px; color:#fff; border-bottom:1px solid #333; padding-bottom:5px;">${label}</div>`;
            
            if (season.episodes && season.episodes.length > 0) {
                season.episodes.forEach(ep => {
                    const row = document.createElement('div');
                    row.className = 'ep-item';
                    // FIX: Use runtime_minutes if available
                    const runtime = ep.runtime_minutes ? `${ep.runtime_minutes}m` : '45m';
                    
                    row.innerHTML = `
                        <div style="display:flex; gap:15px; align-items:center; width:100%">
                            <span style="color:var(--accent); font-weight:bold; width:30px">${ep.episode_number}</span>
                            <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ep.title || 'Episode ' + ep.episode_number}</span>
                            <span style="color:#666; font-size:0.8rem; margin-right:10px;">${runtime}</span>
                            <span style="font-size:1.2rem; opacity:0.7">▶</span>
                        </div>
                    `;
                    row.onclick = () => playVideo('tv', currentTmdbId, season.season_number, ep.episode_number);
                    div.appendChild(row);
                });
            } else {
                div.innerHTML += '<div style="padding:10px; color:#666; font-style:italic">Episodes missing.</div>';
            }
            list.appendChild(div);
        });
    } catch (err) {
        console.error(err);
        list.innerHTML = '<div style="padding:20px; color:#f55">Signal scrambled.</div>';
    }
}

// --- PLAYER LOGIC ---
// (huntedStreams, activeStreamIdx declared at top)

async function playVideo(type, tmdbId, season=1, episode=1) {
    SoundManager.play('click');
    currentTmdbId = tmdbId; currentType = type; currentSeason = season; currentEpisode = episode;
    sendInteraction('watch', tmdbId, type);

    const btn = document.querySelector('#play-btn');
    if(btn) btn.innerText = "HUNTING...";

    // Hide Info, Show Player
    document.querySelector('.modal-header').classList.add('hidden');
    const tp = document.getElementById('trailer-preview');
    if (tp) { tp.classList.add('hidden'); document.getElementById('trailer-iframe').src = 'about:blank'; }
    document.getElementById('player-wrapper').classList.remove('hidden');
    const modal = document.getElementById('modal');
    if (modal) modal.classList.add('player-open');

    // Init or reset our custom player
    const playerContainer = document.getElementById('nautilus-player');
    const iframe = document.getElementById('embed-frame');
    iframe.classList.add('hidden');
    iframe.src = "about:blank";

    if (nautPlayer) { nautPlayer.destroy(); }
    nautPlayer = new NautilusPlayer(playerContainer);
    nautPlayer.setTitle(document.getElementById('m-title')?.textContent || 'Nautilus');
    nautPlayer.onClose(() => closePlayer());
    nautPlayer.setMediaContext(currentType, currentTmdbId, currentSeason, currentEpisode);

    huntedStreams = [];
    activeStreamIdx = 0;

    // Show hunt overlay
    showHuntOverlay();

    // Fetch all providers list for the grid
    try {
        const provRes = await fetch('/stream/providers');
        const provData = await provRes.json();
        populateHuntGrid(provData.sources || []);
    } catch(e) {
        console.warn('[Nautilus] Failed to fetch providers', e);
    }

    // Run the hunt — try fast single first, then full scan in background
    let gotFirst = false;
    try {
        const streamUrl = `/stream/${currentType}/${currentTmdbId}?season=${currentSeason}&episode=${currentEpisode}`;
        const res = await fetch(streamUrl);
        const data = await res.json();
        if (data.stream) {
            huntedStreams.push(data);
            gotFirst = true;
            markHuntSource(data.source, 'found');
            hideHuntOverlay();
            nautPlayer.loadStream(data, huntedStreams);
        }
    } catch(e) {
        console.warn('[Nautilus] Fast stream failed:', e);
    }

    // Full hunt scan in background for more sources
    huntAllStreams().then(allResults => {
        if (allResults.length > 0) {
            const existingKeys = new Set(huntedStreams.map(s => `${s.source}-${s.embed||''}`));
            for (const r of allResults) {
                const key = `${r.source}-${r.embed||''}`;
                if (!existingKeys.has(key)) {
                    huntedStreams.push(r);
                    existingKeys.add(key);
                }
            }
            // Update the player's source list
            if (nautPlayer) nautPlayer.allSources = huntedStreams;
            if (!gotFirst && huntedStreams.length > 0) {
                hideHuntOverlay();
                nautPlayer.loadStream(huntedStreams[0], huntedStreams);
            }
        }
        if (!gotFirst && huntedStreams.length === 0) {
            hideHuntOverlay();
            if (nautPlayer) nautPlayer._showError('No streams found — try again later');
        }
    });

    if(btn) btn.innerText = "▶ PLAY";

    startProgressTracking();
    const saved = getStoredProgress(type, tmdbId);
    if (saved && saved.time > 10) {
        setTimeout(() => {
            if (nautPlayer && nautPlayer.duration) {
                nautPlayer.currentTime = saved.time;
            }
        }, 2500);
    }
}

async function huntAllStreams() {
    try {
        const url = `/stream/hunt/${currentType}/${currentTmdbId}?season=${currentSeason}&episode=${currentEpisode}`;
        const res = await fetch(url);
        const data = await res.json();
        const results = (data.streams || []).map(s => s);
        // Mark all found sources in hunt grid
        results.forEach(r => markHuntSource(r.source, 'found'));
        return results;
    } catch(e) {
        console.warn('[Nautilus] Hunt scan failed:', e);
        return [];
    }
}

/* ─── Stream Playback (delegated to NautilusPlayer) ──── */
function playStream(data) {
    if (!data || !data.stream) return;
    if (!nautPlayer) return;
    nautPlayer.loadStream(data, huntedStreams);
    console.log(`[Nautilus] ▶ ${data.stream.type} from: ${data.source}${data.embed ? ' → ' + data.embed : ''}`);
}

function switchStream(value) {
    const idx = parseInt(value);
    if (!isNaN(idx) && huntedStreams[idx]) {
        activeStreamIdx = idx;
        playStream(huntedStreams[idx]);
        return;
    }
    if (value === 'auto' && huntedStreams.length > 0) {
        playStream(huntedStreams[0]);
        return;
    }
    // Try this source via the provider engine (no embed iframes)
    if (nautPlayer && value) {
        fetch(`/stream/${currentType}/${currentTmdbId}?season=${currentSeason}&episode=${currentEpisode}&source=${value}`)
            .then(r => r.json())
            .then(data => { if (data.stream) playStream(data); })
            .catch(e => console.warn('Source switch failed:', e));
    }
}

// ─── Hunt Overlay ─────────────────────────────────
function showHuntOverlay() {
    const overlay = document.getElementById('hunt-overlay');
    overlay.classList.remove('hidden');
    document.getElementById('hunt-status').textContent = 'Scanning the seven seas...';
}

function hideHuntOverlay() {
    const overlay = document.getElementById('hunt-overlay');
    overlay.classList.add('hunt-fade-out');
    setTimeout(() => {
        overlay.classList.add('hidden');
        overlay.classList.remove('hunt-fade-out');
    }, 500);
}

function populateHuntGrid(sources) {
    const grid = document.getElementById('hunt-grid');
    grid.innerHTML = '';
    sources.filter(src => !src.disabled).forEach(src => {
        const cell = document.createElement('div');
        cell.className = 'hunt-cell scanning';
        cell.id = `hunt-${src.id}`;
        cell.innerHTML = `<span class="hunt-name">${src.name}</span><span class="hunt-dot">●</span>`;
        grid.appendChild(cell);
    });
    // Stagger animation
    const cells = grid.querySelectorAll('.hunt-cell');
    cells.forEach((cell, i) => {
        cell.style.animationDelay = `${i * 0.08}s`;
    });
}

function markHuntSource(sourceId, status) {
    const cell = document.getElementById(`hunt-${sourceId}`);
    if (!cell) return;
    cell.classList.remove('scanning');
    cell.classList.add(status); // 'found' or 'failed'
    const dot = cell.querySelector('.hunt-dot');
    if (dot) dot.textContent = status === 'found' ? '✓' : '✗';
}

async function loadDirectStream() {
    // Legacy wrapper — redirects to new flow
    await playVideo(currentType, currentTmdbId, currentSeason, currentEpisode);
}

function changeSource(provider) {
    switchStream(provider);
}

async function loadLegacySource(provider) {
    const iframe = document.getElementById('embed-frame');
    iframe.classList.add('hidden'); iframe.src = "about:blank";
    // Destroy NautilusPlayer so we don't get double players
    if (nautPlayer) { nautPlayer.destroy(); nautPlayer = null; }

    try {
        const apiUrl = `/play/${currentType}/${currentTmdbId}?season=${currentSeason}&episode=${currentEpisode}&provider=${provider}`;
        const res = await fetch(apiUrl);
        const data = await res.json();

        if (data.type === 'embed') {
            iframe.classList.remove('hidden');
            iframe.src = data.url;
        } else if (data.url) {
            // Wrap in a stream-like object for NautilusPlayer
            if (!nautPlayer) {
                const cont = document.getElementById('nautilus-player');
                nautPlayer = new NautilusPlayer(cont);
            }
            nautPlayer.loadStream({ source: provider, stream: { type: 'hls', playlist: data.url, captions: [] } }, huntedStreams);
        }
    } catch (e) {
        console.error('[Nautilus] Legacy source failed:', e);
    }
}

function closePlayer() {
    if (nautPlayer) { nautPlayer.destroy(); nautPlayer = null; }
    if (currentHls) { currentHls.destroy(); currentHls = null; }

    // Exit Fullscreen if active
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log(err));
    }

    document.getElementById('embed-frame').src = "about:blank";
    document.getElementById('player-wrapper').classList.add('hidden');
    // Show Info Again
    document.querySelector('.modal-header').classList.remove('hidden');
    const closeBtn = document.querySelector('.close-btn');
    if (closeBtn) closeBtn.classList.remove('hidden');
    const modal = document.getElementById('modal');
    if (modal) modal.classList.remove('player-open');

    // On the dedicated show page, closing the player hides the overlay and
    // refreshes the episode watched-state instead of showing a movie modal.
    if (window.IS_SHOW_PAGE) {
        if (modal) modal.classList.add('hidden');
        document.querySelector('.modal-header')?.classList.add('hidden');
        if (typeof refreshShowProgress === 'function') refreshShowProgress();
        return;
    }

    // Re-load the trailer preview so it reappears
    if (currentTmdbId && currentType) {
        loadTrailerPreview(currentTmdbId, currentType);
    }
}

async function refreshRandom(btn) {
    btn.disabled = true;
    btn.innerText = "Loading...";
    try {
        const res = await fetch(`/movies/random?limit=15`);
        const items = await res.json();
        const scroller = document.getElementById('random-scroller');
        scroller.innerHTML = '';
        
        items.forEach(item => {
            const card = document.createElement('div');
            card.className = 'card';
            let type = 'movie';
            
            const poster = item.poster_path 
                ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                : 'https://via.placeholder.com/200x300?text=No+Image';
                
            card.innerHTML = `
                <img src="${poster}" alt="${item.title || item.name}" loading="lazy" class="poster">
            `;
            card.onclick = () => openModal(item, type);
            scroller.appendChild(card);
        });
    } catch (e) {
        console.error("Regen failed", e);
    } finally {
        btn.disabled = false;
        btn.innerText = "Regenerate";
    }
}

// --- INTERACTIONS ---
async function checkInteractionStatus(item, likeBtn, listBtn) {
    const tmdbId = item.tmdb_id || item.id;
    let type = item.media_type;
    if (!type) type = (item.first_air_date || item.name) ? 'tv' : 'movie';
    const gid = getGuestId();

    const updateBtn = (btn, active, iconActive, iconInactive, color) => {
        if(active) {
            btn.innerHTML = `<i class="${iconActive}" style="color:${color}"></i>`;
            btn.dataset.active = "true";
        } else {
            btn.innerHTML = `<i class="${iconInactive}"></i>`;
            btn.dataset.active = "false";
        }
    };

    // Check Like
    fetch(`/interactions/status?guest_id=${gid}&tmdb_id=${tmdbId}&media_type=${type}&action=like`)
        .then(r=>r.json())
        .then(d => updateBtn(likeBtn, d.active, 'fa-solid fa-heart', 'fa-regular fa-heart', '#ff0055'))
        .catch(()=>{});

    // Check Watchlist
    fetch(`/interactions/status?guest_id=${gid}&tmdb_id=${tmdbId}&media_type=${type}&action=watchlist`)
        .then(r=>r.json())
        .then(d => updateBtn(listBtn, d.active, 'fa-solid fa-check', 'fa-solid fa-plus', '#00ffaa'))
        .catch(()=>{});
}

async function toggleInteraction(actionType, item, btn) {
    SoundManager.play('coin');
    const tmdbId = item.tmdb_id || item.id;
    let type = item.media_type;
    if (!type) type = (item.first_air_date || item.name) ? 'tv' : 'movie';
    const isActive = btn.dataset.active === "true";

    let apiAction = actionType;
    if (actionType === 'like' && isActive) apiAction = 'dislike';
    if (actionType === 'watchlist' && isActive) apiAction = 'remove_watchlist';
    
    // Optimistic
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    await sendInteraction(apiAction, tmdbId, type);
    
    // Re-render based on toggled state
    if (actionType === 'like') {
        if (apiAction === 'like') {
            btn.innerHTML = '<i class="fa-solid fa-heart" style="color:#ff0055"></i>';
            btn.dataset.active = "true";
        } else {
            btn.innerHTML = '<i class="fa-regular fa-heart"></i>';
            btn.dataset.active = "false";
        }
    } else if (actionType === 'watchlist') {
        if (apiAction === 'watchlist') {
             btn.innerHTML = '<i class="fa-solid fa-check" style="color:#00ffaa"></i>';
             btn.dataset.active = "true";
        } else {
             btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
             btn.dataset.active = "false";
        }
    }
}

async function sendInteraction(action, tmdbId, type) {
    const guestId = getGuestId();
    try {
        await fetch('/interact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                guest_id: guestId,
                item_id: tmdbId,
                media_type: type,
                action: action
            })
        });
    } catch (e) {
        console.error("Interaction failed", e);
    }
}

// --- RANDOM MOVIE (Header Button) ---
async function playRandomMovie() {
    try {
        const res = await fetch('/movies/random?limit=1');
        const items = await res.json();
        if (items.length > 0 && items[0].poster_path) {
            openModal(items[0], 'movie');
        } else {
            // Try again
            const res2 = await fetch('/movies/random?limit=5');
            const items2 = await res2.json();
            const valid = items2.find(i => i.poster_path);
            if (valid) openModal(valid, 'movie');
        }
    } catch(e) {
        console.error('Random movie failed', e);
    }
}

// --- KEYBOARD SHORTCUTS (Sudoflix-Inspired) ---
document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in search
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
    
    const modal = document.getElementById('modal');
    const playerWrapper = document.getElementById('player-wrapper');
    const isPlayerOpen = modal && !modal.classList.contains('hidden') && playerWrapper && !playerWrapper.classList.contains('hidden');
    
    // Player-specific shortcuts (only when player is visible)
    // NautilusPlayer handles its own keyboard shortcuts internally,
    // but we keep Escape to close the player from the main page
    if (isPlayerOpen && nautPlayer) {
        // NautilusPlayer's own listener handles space/k/f/m/arrows/j/l/c
        // We only handle Escape here at the page level
        if (e.key === 'Escape') {
            e.preventDefault();
            closePlayer();
        }
        return;
    }
    
    // Global shortcuts
    switch(e.key) {
        case '/':
            e.preventDefault();
            document.getElementById('search-input').focus();
            break;
        case 'Escape':
            if (modal && !modal.classList.contains('hidden')) {
                closeModal();
            }
            break;
    }
});

// --- WATCH PROGRESS PERSISTENCE (Sudoflix-Inspired) ---
let progressSaveInterval = null;

function startProgressTracking() {
    if (progressSaveInterval) clearInterval(progressSaveInterval);
    progressSaveInterval = setInterval(() => {
        if (!nautPlayer || !nautPlayer.playing || !currentTmdbId) return;
        const progress = {
            time: nautPlayer.currentTime,
            duration: nautPlayer.duration,
            percentage: nautPlayer.duration ? (nautPlayer.currentTime / nautPlayer.duration * 100) : 0,
            updatedAt: Date.now()
        };
        const key = `nautilus_progress_${currentType}_${currentTmdbId}`;
        if (currentType === 'tv') {
            progress.season = currentSeason;
            progress.episode = currentEpisode;
        }
        try { localStorage.setItem(key, JSON.stringify(progress)); } catch(e) {}
    }, 3000);
}

function getStoredProgress(type, tmdbId) {
    try {
        const key = `nautilus_progress_${type}_${tmdbId}`;
        const data = localStorage.getItem(key);
        if (!data) return null;
        const p = JSON.parse(data);
        // Only resume if not near end (>95% = finished)
        if (p.percentage && p.percentage > 95) return null;
        return p;
    } catch(e) { return null; }
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- CONTINUE WATCHING ---
function getContinueWatchingItems() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('nautilus_progress_')) continue;
        try {
            const data = JSON.parse(localStorage.getItem(key));
            if (!data || !data.time || data.time < 30) continue; // Skip if <30s watched
            if (data.percentage && data.percentage > 95) continue; // Already finished
            // Parse type and tmdbId from key: nautilus_progress_{type}_{tmdbId}
            const parts = key.replace('nautilus_progress_', '').split('_');
            const type = parts[0]; // 'movie' or 'tv'
            const tmdbId = parseInt(parts.slice(1).join('_'));
            if (!tmdbId) continue;
            items.push({ type, tmdbId, ...data });
        } catch(e) { continue; }
    }
    // Sort by most recently updated first
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items.slice(0, 15);
}

async function createContinueWatchingRow(progressItems) {
    const container = document.getElementById('content-area');
    const section = document.createElement('section');
    section.className = 'row-wrapper';
    section.innerHTML = '<div class="row-title">Continue Watching</div>';
    const scroller = document.createElement('div');
    scroller.className = 'row-scroller';

    // Fetch metadata for each item in parallel
    const fetches = progressItems.map(p => 
        fetch(`/media/${p.tmdbId}`).then(r => r.ok ? r.json() : null).catch(() => null)
    );
    const metaResults = await Promise.all(fetches);

    let added = 0;
    metaResults.forEach((meta, i) => {
        if (!meta) return;
        const p = progressItems[i];
        const name = meta.title || meta.name || '?';
        const poster = meta.poster_path;
        if (!poster) return;
        const imgSrc = `https://image.tmdb.org/t/p/w500${poster}`;
        const pct = Math.min(Math.round(p.percentage || 0), 100);

        const card = document.createElement('div');
        card.className = 'card continue-card';
        card.onclick = () => {
            openModal(meta, p.type);
            // Auto-play after a brief moment
            setTimeout(() => {
                if (p.type === 'tv' && p.season && p.episode) {
                    playVideo('tv', p.tmdbId, p.season, p.episode);
                } else {
                    playVideo(p.type, p.tmdbId);
                }
            }, 600);
        };

        let epLabel = '';
        if (p.type === 'tv' && p.season && p.episode) {
            epLabel = `<div class="continue-ep">S${p.season} E${p.episode}</div>`;
        }

        card.innerHTML = `
            <img src="${imgSrc}" class="poster" loading="lazy" alt="${name}">
            <div class="card-overlay" style="opacity:1;transform:none;">
                ${name}${epLabel}
            </div>
            <div class="continue-bar"><div class="continue-fill" style="width:${pct}%"></div></div>
        `;
        scroller.appendChild(card);
        added++;
    });

    if (added === 0) return;
    section.appendChild(scroller);
    container.insertBefore(section, container.firstChild);
}

// --- TRAILER PREVIEW ---
function loadTrailerPreview(tmdbId, mediaType) {
    const container = document.getElementById('trailer-preview');
    const iframe = document.getElementById('trailer-iframe');
    container.classList.add('hidden');
    iframe.src = 'about:blank';

    fetch(`/media/${tmdbId}/trailer?media_type=${mediaType}`)
        .then(r => r.json())
        .then(data => {
            if (data.key) {
                iframe.src = `https://www.youtube.com/embed/${data.key}?rel=0&modestbranding=1`;
                container.classList.remove('hidden');
            }
        })
        .catch(() => {});
}

// --- DOWNLOAD (auto-pick best source, download in-place) ---
async function startAutoDownload() {
    // Open the download modal
    const dlModal = document.getElementById('download-modal');
    const dlLoading = document.getElementById('dl-loading');
    const dlContent = document.getElementById('dl-content');
    const dlError = document.getElementById('dl-error');

    dlModal.classList.remove('hidden');
    dlLoading.classList.remove('hidden');
    dlContent.classList.add('hidden');
    dlError.classList.add('hidden');

    try {
        // Hunt for streams if we don't have any
        let streams = huntedStreams;
        if (!streams || streams.length === 0) {
            const res = await fetch(`/stream/hunt/${currentType}/${currentTmdbId}?season=${currentSeason}&episode=${currentEpisode}`);
            const data = await res.json();
            streams = (data.streams || []).map(s => ({
                source: s.source,
                embed: s.embed,
                stream: s.stream,
            }));
        }

        // Find best downloadable stream (prefer file type with qualities, then HLS)
        const downloadable = streams.filter(s => s.stream && (s.stream.type === 'file' || s.stream.type === 'hls'));
        if (downloadable.length === 0) {
            dlLoading.classList.add('hidden');
            dlError.classList.remove('hidden');
            return;
        }

        // Pick first stream with file qualities, else first HLS
        let picked = downloadable.find(s => s.stream.type === 'file' && s.stream.qualities?.length > 0) || downloadable[0];
        const stream = picked.stream;

        // Populate source label
        document.getElementById('dl-source').textContent = picked.embed ? `${picked.source} → ${picked.embed}` : picked.source;

        // Populate quality options
        const qualContainer = document.getElementById('dl-qualities');
        qualContainer.innerHTML = '';
        let selectedUrl = '';
        let selectedHeaders = stream.headers || {};

        if (stream.type === 'file' && stream.qualities?.length > 0) {
            const sorted = [...stream.qualities].sort((a, b) => {
                const qA = parseInt(a.quality) || 0;
                const qB = parseInt(b.quality) || 0;
                return qB - qA;
            });
            sorted.forEach((q, idx) => {
                const pill = document.createElement('button');
                pill.className = 'dl-quality-pill' + (idx === 0 ? ' active' : '');
                pill.textContent = q.quality === 'unknown' ? 'Auto' : q.quality + 'p';
                pill.onclick = () => {
                    qualContainer.querySelectorAll('.dl-quality-pill').forEach(p => p.classList.remove('active'));
                    pill.classList.add('active');
                    selectedUrl = q.url;
                };
                qualContainer.appendChild(pill);
            });
            selectedUrl = sorted[0].url;
        } else if (stream.type === 'hls' && stream.playlist) {
            const pill = document.createElement('button');
            pill.className = 'dl-quality-pill active';
            pill.textContent = 'HLS Stream';
            qualContainer.appendChild(pill);
            selectedUrl = stream.playlist;
        }

        // Populate subtitles
        const subSelect = document.getElementById('dl-subs');
        subSelect.innerHTML = '<option value="">None</option>';
        const captions = stream.captions || [];
        captions.forEach((c, idx) => {
            const opt = document.createElement('option');
            opt.value = c.url;
            opt.textContent = (c.lang || 'Sub').toUpperCase() + (c.format ? ` (${c.format})` : '');
            subSelect.appendChild(opt);
        });

        // Download button
        const dlBtn = document.getElementById('dl-start');
        dlBtn.onclick = () => {
            const title = document.getElementById('m-title')?.textContent || 'download';
            const safeName = title.replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_');

            // Download video
            let videoUrl = selectedUrl;
            if (selectedHeaders && Object.keys(selectedHeaders).length) {
                const params = new URLSearchParams({ url: selectedUrl });
                if (selectedHeaders.Referer) params.append('referer', selectedHeaders.Referer);
                if (selectedHeaders.Origin) params.append('origin', selectedHeaders.Origin);
                videoUrl = `/proxy_stream?${params}`;
            }

            const a = document.createElement('a');
            a.href = videoUrl;
            a.download = safeName;
            a.target = '_blank';
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Download subtitle if selected
            const subUrl = subSelect.value;
            if (subUrl) {
                setTimeout(() => {
                    const sa = document.createElement('a');
                    sa.href = subUrl;
                    sa.download = safeName + '.srt';
                    sa.target = '_blank';
                    document.body.appendChild(sa);
                    sa.click();
                    document.body.removeChild(sa);
                }, 500);
            }

            closeDownloadModal();
        };

        dlLoading.classList.add('hidden');
        dlContent.classList.remove('hidden');

    } catch (e) {
        console.error('[Nautilus] Download error:', e);
        dlLoading.classList.add('hidden');
        dlError.classList.remove('hidden');
    }
}

function closeDownloadModal() {
    document.getElementById('download-modal').classList.add('hidden');
}

// --- SETTINGS PANEL ---
function openSettings() {
    const overlay = document.getElementById('settings-overlay');
    overlay.classList.remove('hidden');
    // Populate current values
    const defaultSrc = localStorage.getItem('nautilus_default_source') || 'VidSrc.to';
    const sel = document.getElementById('settings-default-source');
    if (sel) sel.value = defaultSrc;
    const gidEl = document.getElementById('settings-guest-id');
    if (gidEl) gidEl.textContent = getGuestId();
    // Save on change
    if (sel) sel.onchange = () => {
        localStorage.setItem('nautilus_default_source', sel.value);
    };

    // --- Player Preferences ---
    const prefs = (typeof getPlayerPrefs === 'function')
        ? getPlayerPrefs()
        : JSON.parse(localStorage.getItem('nautilus_player_prefs') || '{}');

    const qualSel = document.getElementById('settings-quality');
    if (qualSel) {
        qualSel.value = prefs.preferredQuality || 'auto';
        qualSel.onchange = () => {
            const p = JSON.parse(localStorage.getItem('nautilus_player_prefs') || '{}');
            p.preferredQuality = qualSel.value;
            localStorage.setItem('nautilus_player_prefs', JSON.stringify(p));
        };
    }

    const autoCcBtn = document.getElementById('settings-autocc');
    if (autoCcBtn) {
        const isOn = prefs.autoplaySubtitles || false;
        autoCcBtn.textContent = isOn ? 'ON' : 'OFF';
        autoCcBtn.style.background = isOn ? 'var(--gold)' : '#333';
        autoCcBtn.style.color = isOn ? '#000' : '#ccc';
        autoCcBtn.onclick = () => {
            const p = JSON.parse(localStorage.getItem('nautilus_player_prefs') || '{}');
            p.autoplaySubtitles = !p.autoplaySubtitles;
            localStorage.setItem('nautilus_player_prefs', JSON.stringify(p));
            autoCcBtn.textContent = p.autoplaySubtitles ? 'ON' : 'OFF';
            autoCcBtn.style.background = p.autoplaySubtitles ? 'var(--gold)' : '#333';
            autoCcBtn.style.color = p.autoplaySubtitles ? '#000' : '#ccc';
        };
    }

    const subSizeRange = document.getElementById('settings-subsize');
    if (subSizeRange) {
        subSizeRange.value = prefs.subtitleSize || 1;
        subSizeRange.oninput = () => {
            const p = JSON.parse(localStorage.getItem('nautilus_player_prefs') || '{}');
            p.subtitleSize = parseFloat(subSizeRange.value);
            localStorage.setItem('nautilus_player_prefs', JSON.stringify(p));
        };
    }
}

function closeSettings() {
    document.getElementById('settings-overlay').classList.add('hidden');
}

function clearWatchProgress() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('nautilus_progress_')) keys.push(key);
    }
    keys.forEach(k => localStorage.removeItem(k));
    alert(`Cleared ${keys.length} watch progress entries.`);
}

function resetPreferences() {
    if (!confirm('This will clear all your likes, watchlist, and viewing preferences. Continue?')) return;
    // Clear local prefs
    localStorage.removeItem('nautilus_user_prefs');
    // Clear server-side interactions
    fetch(`/interactions/reset/${getGuestId()}`, { method: 'POST' }).catch(() => {});
    alert('Preferences reset. Reload to see changes.');
    location.reload();
}