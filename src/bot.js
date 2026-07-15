import {
    Client, GatewayIntentBits, REST, Routes,
    SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    AttachmentBuilder, MessageFlags,
} from 'discord.js';
import { config } from './config.js';
import { JellyfinClient } from './jellyfin.js';
import { Player } from './player.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const jf     = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
const player = new Player(client, config.stream);

const GUID_RE = /^[0-9a-f]{32}$/i;

// ─── Comandos ────────────────────────────────────────────────────────────────

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Busca en Jellyfin y reproduce vídeo + audio en tu canal de voz')
        .addStringOption(o =>
            o.setName('nombre')
                .setDescription('Nombre de la película o serie')
                .setRequired(true)
                .setAutocomplete(true)),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Para la reproducción y desconecta el bot del canal de voz'),
    new SlashCommandBuilder()
        .setName('buscar')
        .setDescription('Busca en la biblioteca de Jellyfin sin reproducir')
        .addStringOption(o =>
            o.setName('nombre').setDescription('Nombre a buscar').setRequired(true)),
    new SlashCommandBuilder()
        .setName('estado')
        .setDescription('Muestra qué se está reproduciendo ahora mismo'),
];

// ─── Ready ───────────────────────────────────────────────────────────────────

client.once('ready', async () => {
    console.log(`✓ Bot conectado: ${client.user.tag}`);
    const rest = new REST().setToken(config.discordToken);
    await rest.put(Routes.applicationCommands(config.discordClientId), {
        body: commands.map(c => c.toJSON()),
    });
    console.log('✓ Slash commands sincronizados');
});

// ─── Interactions ────────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isAutocomplete()) {
            await handleAutocomplete(interaction);
            return;
        }

        if (interaction.isChatInputCommand()) {
            switch (interaction.commandName) {
                case 'play':   await handlePlay(interaction);   break;
                case 'stop':   await handleStop(interaction);   break;
                case 'buscar': await handleBuscar(interaction); break;
                case 'estado': await handleEstado(interaction); break;
            }
            return;
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'jf:item')             await handleItemSelect(interaction);
            else if (interaction.customId.startsWith('jf:season:')) await handleSeasonSelect(interaction);
        }
    } catch (err) {
        console.error('[interaction]', err);
        const msg = { content: 'Ocurrió un error inesperado, inténtalo de nuevo.', flags: MessageFlags.Ephemeral };
        try {
            if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
            else if (interaction.isRepliable()) await interaction.reply(msg);
        } catch {}
    }
});

// ─── Autocompletado de /play ─────────────────────────────────────────────────

async function handleAutocomplete(interaction) {
    const q = interaction.options.getFocused().trim();
    if (q.length < 2) { await interaction.respond([]); return; }

    const results = await jf.search(q, 25).catch(() => []);
    await interaction.respond(results.map(item => ({
        name: `${item.Type === 'Movie' ? '🎬' : '📺'} ${item.Name}${item.ProductionYear ? ` (${item.ProductionYear})` : ''}`.slice(0, 100),
        value: item.Id,
    }))).catch(() => {});
}

// ─── /play ───────────────────────────────────────────────────────────────────

async function handlePlay(interaction) {
    await interaction.deferReply();

    const nombre = interaction.options.getString('nombre').trim();

    // Si viene del autocompletado, el valor ya es un ID de Jellyfin
    if (GUID_RE.test(nombre)) {
        const item = await jf.getItem(nombre);
        if (item) { await resolveItem(interaction, item); return; }
    }

    const results = await jf.search(nombre, 10);

    if (!results.length) {
        await interaction.editReply(`No encontré nada con **${nombre}** en Jellyfin.`);
        return;
    }

    if (results.length === 1) {
        await resolveItem(interaction, results[0]);
        return;
    }

    // Varios resultados → selector (sin estado: el value es el ID del item)
    const select = new StringSelectMenuBuilder()
        .setCustomId('jf:item')
        .setPlaceholder('Elige qué reproducir…')
        .addOptions(results.map(item =>
            new StringSelectMenuOptionBuilder()
                .setLabel(`${item.Name}${item.ProductionYear ? ` (${item.ProductionYear})` : ''}`.slice(0, 100))
                .setValue(item.Id)
                .setDescription(item.Type === 'Movie' ? 'Película' : 'Serie'),
        ));

    await interaction.editReply({
        content: `Encontré **${results.length}** resultados para **${nombre}**:`,
        components: [new ActionRowBuilder().addComponents(select)],
    });
}

// Decide qué hacer con un item: película/episodio → reproducir, serie → temporadas
async function resolveItem(interaction, item) {
    if (item.Type === 'Series') {
        await showSeasons(interaction, item);
    } else {
        await streamItem(interaction, item);
    }
}

async function handleItemSelect(interaction) {
    await interaction.deferUpdate();
    const item = await jf.getItem(interaction.values[0]);
    if (!item) {
        await interaction.editReply({ content: 'No se encontró el item, prueba /play de nuevo.', components: [] });
        return;
    }
    await resolveItem(interaction, item);
}

// ─── Series: temporadas y episodios ──────────────────────────────────────────

async function showSeasons(interaction, series) {
    const seasons = await jf.getSeasons(series.Id);

    if (!seasons.length) {
        await interaction.editReply({ content: `**${series.Name}** no tiene temporadas disponibles.`, components: [] });
        return;
    }

    if (seasons.length === 1) {
        await showEpisodes(interaction, series.Id, seasons[0], series.Name);
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(`jf:season:${series.Id}`)
        .setPlaceholder('Elige temporada…')
        .addOptions(seasons.slice(0, 25).map(s =>
            new StringSelectMenuOptionBuilder()
                .setLabel(s.Name.slice(0, 100))
                .setValue(s.Id)
                .setDescription(s.ChildCount ? `${s.ChildCount} episodios` : ' '),
        ));

    await interaction.editReply({
        content: `📺 **${series.Name}** — elige temporada:`,
        components: [new ActionRowBuilder().addComponents(select)],
    });
}

async function handleSeasonSelect(interaction) {
    await interaction.deferUpdate();
    const seriesId = interaction.customId.split(':')[2];
    const season   = { Id: interaction.values[0], Name: '' };
    await showEpisodes(interaction, seriesId, season, null);
}

async function showEpisodes(interaction, seriesId, season, seriesName) {
    const episodes = await jf.getEpisodes(seriesId, season.Id);

    if (!episodes.length) {
        await interaction.editReply({ content: 'Esa temporada no tiene episodios disponibles.', components: [] });
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('jf:item')
        .setPlaceholder('Elige episodio…')
        .addOptions(episodes.slice(0, 25).map(ep => {
            const num     = ep.IndexNumber != null ? `E${String(ep.IndexNumber).padStart(2, '0')} · ` : '';
            const runtime = jf.formatRuntime(ep.RunTimeTicks);
            return new StringSelectMenuOptionBuilder()
                .setLabel(`${num}${ep.Name}`.slice(0, 100))
                .setValue(ep.Id)
                .setDescription(runtime || ' ');
        }));

    const title = seriesName ?? episodes[0].SeriesName ?? 'Serie';
    const extra = episodes.length > 25 ? ` (mostrando los primeros 25 de ${episodes.length})` : '';

    await interaction.editReply({
        content: `📺 **${title}** — elige episodio${extra}:`,
        components: [new ActionRowBuilder().addComponents(select)],
    });
}

// ─── Streaming ───────────────────────────────────────────────────────────────

async function streamItem(interaction, item) {
    // Embed + imagen (descarga local para que Discord la muestre aunque Jellyfin sea LAN)
    const imgBuffer = await jf.getImageBuffer(item.Id);
    const embed     = buildEmbed(item);
    const files     = [];

    if (imgBuffer) {
        files.push(new AttachmentBuilder(imgBuffer, { name: 'poster.jpg' }));
        embed.setThumbnail('attachment://poster.jpg');
    }

    // Canal de voz del usuario
    const voiceState   = interaction.guild.voiceStates.cache.get(interaction.user.id);
    const voiceChannel = voiceState?.channel;

    if (!voiceChannel) {
        embed.setFooter({ text: 'Únete a un canal de voz para ver el vídeo' });
        await interaction.editReply({ content: '', embeds: [embed], files, components: [] });
        return;
    }

    const displayName = item.Type === 'Episode' && item.SeriesName
        ? `${item.SeriesName} — ${item.Name}`
        : item.Name;

    try {
        await player.play({
            guildId:     interaction.guildId,
            channelId:   voiceChannel.id,
            channelName: voiceChannel.name,
            name:        displayName,
            url:         jf.getStreamUrl(item.Id),
        });
        embed.setFooter({ text: `🎬 Streaming en #${voiceChannel.name}  •  /stop para detener` });
    } catch (err) {
        console.error('[joinVoice]', err);
        embed.setFooter({ text: `Error al iniciar el stream: ${err.message}` });
    }

    await interaction.editReply({ content: '', embeds: [embed], files, components: [] });
}

// ─── /stop ───────────────────────────────────────────────────────────────────

async function handleStop(interaction) {
    if (player.isActive) {
        const { name } = player.current;
        await player.stop();
        await interaction.reply(`⏹ Detenido: **${name}**`);
    } else {
        await interaction.reply({ content: 'No hay nada reproduciéndose ahora mismo.', flags: MessageFlags.Ephemeral });
    }
}

// ─── /estado ─────────────────────────────────────────────────────────────────

async function handleEstado(interaction) {
    if (!player.isActive) {
        await interaction.reply({ content: 'No hay nada reproduciéndose ahora mismo.', flags: MessageFlags.Ephemeral });
        return;
    }
    const { name, channelName, startedAt } = player.current;
    const mins = Math.floor((Date.now() - startedAt) / 60_000);
    await interaction.reply(`🎬 Reproduciendo **${name}** en **#${channelName}** desde hace ${mins} min.`);
}

// ─── /buscar ─────────────────────────────────────────────────────────────────

async function handleBuscar(interaction) {
    await interaction.deferReply();
    const nombre  = interaction.options.getString('nombre');
    const results = await jf.search(nombre, 8);

    if (!results.length) {
        await interaction.editReply(`No encontré nada con **${nombre}**.`);
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`Resultados para: ${nombre}`)
        .setColor(0x48CAE4)
        .setFooter({ text: 'Usa /play <nombre> para reproducir' });

    for (const item of results) {
        const year    = item.ProductionYear ? ` (${item.ProductionYear})` : '';
        const tipo    = item.Type === 'Movie' ? '🎬 Película' : '📺 Serie';
        const runtime = jf.formatRuntime(item.RunTimeTicks);
        embed.addFields({ name: item.Name + year, value: tipo + (runtime ? ` • ${runtime}` : ''), inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildEmbed(item) {
    const year     = item.ProductionYear ? ` (${item.ProductionYear})` : '';
    const overview = item.Overview
        ? (item.Overview.length > 350 ? item.Overview.slice(0, 350) + '…' : item.Overview)
        : 'Sin descripción';
    const tipos   = { Movie: '🎬 Película', Series: '📺 Serie', Episode: '📺 Episodio' };
    const runtime = jf.formatRuntime(item.RunTimeTicks);

    const title = item.Type === 'Episode' && item.SeriesName
        ? `${item.SeriesName} — ${item.Name}`
        : item.Name + year;

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(overview)
        .setColor(0x00B4D8)
        .addFields({ name: 'Tipo', value: tipos[item.Type] ?? item.Type, inline: true });

    if (runtime) embed.addFields({ name: 'Duración', value: runtime, inline: true });
    embed.addFields({ name: 'Ver en Jellyfin', value: `[Abrir](${jf.getWebUrl(item.Id)})`, inline: false });

    return embed;
}

// ─── Cierre limpio ───────────────────────────────────────────────────────────

async function shutdown() {
    console.log('Cerrando…');
    await player.stop().catch(() => {});
    client.destroy();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.discordToken);
