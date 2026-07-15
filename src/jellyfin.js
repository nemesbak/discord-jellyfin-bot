import fetch from 'node-fetch';

const FIELDS = 'Overview,ProductionYear,RunTimeTicks,SeriesName';

export class JellyfinClient {
    constructor(url, apiKey) {
        this.url = url.replace(/\/$/, '');
        this.apiKey = apiKey;
        this.headers = {
            'X-Emby-Authorization':
                `MediaBrowser Client="DiscordBot", Device="Server", DeviceId="discordbot001", Version="2.0.0", Token="${apiKey}"`,
        };
    }

    async #get(path, params = {}) {
        const qs  = new URLSearchParams(params);
        const res = await fetch(`${this.url}${path}?${qs}`, { headers: this.headers });
        if (!res.ok) throw new Error(`Jellyfin ${res.status} en ${path}`);
        return res.json();
    }

    async search(query, limit = 5) {
        const data = await this.#get('/Items', {
            searchTerm: query,
            IncludeItemTypes: 'Movie,Series',
            Recursive: 'true',
            Limit: String(limit),
            Fields: FIELDS,
        });
        return data.Items ?? [];
    }

    async getItem(itemId) {
        try {
            return await this.#get(`/Items/${itemId}`, { Fields: FIELDS });
        } catch {
            return null;
        }
    }

    async getSeasons(seriesId) {
        const data = await this.#get(`/Shows/${seriesId}/Seasons`, {});
        return data.Items ?? [];
    }

    async getEpisodes(seriesId, seasonId) {
        const data = await this.#get(`/Shows/${seriesId}/Episodes`, {
            SeasonId: seasonId ?? '',
            Fields: FIELDS,
        });
        return data.Items ?? [];
    }

    getStreamUrl(itemId) {
        return `${this.url}/Videos/${itemId}/stream?static=true&api_key=${this.apiKey}`;
    }

    async getImageBuffer(itemId) {
        try {
            const res = await fetch(
                `${this.url}/Items/${itemId}/Images/Primary?maxWidth=300`,
                { headers: this.headers },
            );
            if (res.ok) return Buffer.from(await res.arrayBuffer());
        } catch {}
        return null;
    }

    getWebUrl(itemId) {
        return `${this.url}/web/index.html#!/details?id=${itemId}`;
    }

    formatRuntime(ticks) {
        if (!ticks) return '';
        const s = ticks / 10_000_000;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }
}
