import 'dotenv/config';

const missing = [];

function env(name, { required = false, fallback = undefined } = {}) {
    const v = process.env[name]?.trim();
    // Los placeholders del .env.example empiezan por "TU_"
    if (v && !v.startsWith('TU_')) return v;
    if (required) missing.push(name);
    return fallback;
}

function int(name, fallback) {
    const v = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(v) ? v : fallback;
}

export const config = {
    discordToken:    env('DISCORD_TOKEN',    { required: true }),
    discordClientId: env('DISCORD_CLIENT_ID', { required: true }),
    jellyfinUrl:     env('JELLYFIN_URL',      { required: true }),
    jellyfinApiKey:  env('JELLYFIN_API_KEY',  { required: true }),

    // Calidad del stream de Go Live, ajustable por variables de entorno
    stream: {
        width:          int('STREAM_WIDTH', 1280),
        height:         int('STREAM_HEIGHT', 720),
        fps:            int('STREAM_FPS', 30),
        bitrateKbps:    int('STREAM_BITRATE_KBPS', 3000),
        maxBitrateKbps: int('STREAM_MAX_BITRATE_KBPS', 5000),
        hwAccel:        process.env.STREAM_HWACCEL === 'true',
        videoCodec:     env('STREAM_VIDEO_CODEC', { fallback: 'H264' }),
    },
};

if (missing.length) {
    console.error(`✗ Faltan variables de entorno: ${missing.join(', ')}`);
    console.error('  Copia .env.example a .env y rellena los valores.');
    process.exit(1);
}
