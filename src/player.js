import { Streamer, Utils } from '@dank074/discord-video-stream';

/**
 * Envuelve el Streamer de discord-video-stream con el estado de la
 * reproducción actual. Solo puede haber una emisión activa a la vez
 * (una conexión de voz por cliente).
 */
export class Player {
    constructor(client, streamSettings) {
        this.streamer = new Streamer(client);
        this.settings = streamSettings;
        this.current  = null;   // { guildId, channelId, channelName, name, startedAt }
        this.session  = null;   // token para ignorar el fin de streams antiguos
    }

    get isActive() { return this.current !== null; }

    /**
     * Se une al canal de voz y emite `url` por Go Live.
     * Si había otra emisión activa, la detiene primero.
     */
    async play({ guildId, channelId, channelName, name, url }) {
        if (this.current) await this.stop();

        await this.streamer.joinVoice(guildId, channelId);

        const udpConn = await this.streamer.createStream({
            width:                       this.settings.width,
            height:                      this.settings.height,
            fps:                         this.settings.fps,
            bitrateKbps:                 this.settings.bitrateKbps,
            maxBitrateKbps:              this.settings.maxBitrateKbps,
            hardwareAcceleratedDecoding: this.settings.hwAccel,
            videoCodec:                  this.settings.videoCodec,
            rtcpSenderReportEnabled:     true,
        });

        const session = Symbol('stream');
        this.session  = session;
        this.current  = { guildId, channelId, channelName, name, startedAt: Date.now() };

        // No bloqueante: cuando el vídeo termina (o falla), salimos del canal
        Utils.streamLivestreamVideo(url, udpConn, { includeAudio: true })
            .catch(err => console.error('[stream]', err.message))
            .finally(() => {
                if (this.session === session) this.stop().catch(() => {});
            });
    }

    async stop() {
        this.session = null;
        this.current = null;
        try { this.streamer.stopStream(); } catch {}
        try { await this.streamer.leaveVoice(); } catch {}
    }
}
