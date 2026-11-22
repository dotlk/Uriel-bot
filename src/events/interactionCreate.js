const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { randomUUID } = require("crypto");

const { Events, MessageFlags, PermissionFlagsBits } = require("discord.js");
const { getVoiceConnection } = require("@discordjs/voice");

const { getExistingPlayer, isGuildPlaying } = require("../audio/queueManager");
const { connectToChannel } = require("../audio/voiceConnection");
const { getAudioDurationSeconds } = require("../audio/audioProbe");

const { getGuildConfig, updateGuildConfig, setUserVoice, clearClonedVoiceSelections } = require("../../configManager");
const { registerVoice, getVoice, listVoices, deleteVoice, addVoiceSample, getReferencePaths, VOICES_DIR } = require("../voices/voiceRegistry");
const EDGE_VOICES = require("../tts/edgeVoices");

// Extensões aceitas para os áudios de referência
const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".wav"];
// Limite de tamanho do arquivo de referência (a voz é clonada com poucos segundos, não precisa de mais que isso)
const MAX_AUDIO_SIZE = 15 * 1024 * 1024; // 15 MB
// Duração aceita para cada amostra (com meio segundo de tolerância)
const MIN_SAMPLE_SECONDS = 6;
const MAX_SAMPLE_SECONDS = 30;
const DURATION_TOLERANCE_SECONDS = 0.5;
// Limites para evitar que o disco seja lotado de vozes
const MAX_VOICES_PER_USER = 5;
const MAX_VOICES_PER_GUILD = 50;
const MAX_SAMPLES_PER_VOICE = 5;
// O Discord só aceita nomes de até 100 caracteres nas sugestões do autocomplete
const MAX_LABEL_LENGTH = 50;

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// Quem pode apagar/alterar uma voz: o dono dela ou quem pode gerenciar o servidor
function canManageVoice(interaction, voiceMeta) {
    return voiceMeta.ownerId === interaction.user.id ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

// Valida o anexo antes de baixar. Retorna a extensão a usar ou uma mensagem de erro.
function validateAttachment(attachment) {
    const contentType = (attachment.contentType || "").split(";")[0].trim().toLowerCase();
    const extension = path.extname(attachment.name || "").toLowerCase();

    if (!contentType.startsWith("audio/") && !ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
        return { error: "❌ The file must be an audio file (.mp3 or .wav)." };
    }

    if (attachment.size > MAX_AUDIO_SIZE) {
        return { error: "❌ Audio file is too large. Upload a 6–30 second clip up to 15 MB." };
    }

    // Nunca usa a extensão enviada pelo usuário se ela não for uma das permitidas
    if (ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
        return { extension };
    }
    return { extension: contentType.includes("wav") ? ".wav" : ".mp3" };
}

// Baixa o anexo e confere se é mesmo um áudio com a duração certa.
// Em caso de problema apaga o arquivo e retorna uma mensagem de erro.
async function downloadSample(attachment, destinationPath) {
    const response = await axios.get(attachment.url, {
        responseType: "arraybuffer",
        maxContentLength: MAX_AUDIO_SIZE,
        timeout: 30_000
    });
    fs.writeFileSync(destinationPath, response.data);

    const duration = await getAudioDurationSeconds(destinationPath);

    if (duration === null) {
        fs.rmSync(destinationPath, { force: true });
        return "❌ Could not read this file as audio. Please upload a valid .mp3 or .wav file.";
    }

    if (duration < MIN_SAMPLE_SECONDS - DURATION_TOLERANCE_SECONDS ||
        duration > MAX_SAMPLE_SECONDS + DURATION_TOLERANCE_SECONDS) {
        fs.rmSync(destinationPath, { force: true });
        return `❌ The audio is ${duration.toFixed(1)} seconds long. Please upload a clip between ` +
            `${MIN_SAMPLE_SECONDS} and ${MAX_SAMPLE_SECONDS} seconds.`;
    }

    return null;
}

// 🔎 Responde ao autocomplete do /voice (vozes clonadas + Edge) e do /deletevoice e /enrichvoice
async function handleAutocomplete(interaction) {
    if (!interaction.inGuild()) return interaction.respond([]).catch(() => {});

    const focused = interaction.options.getFocused().toLowerCase();

    if (interaction.commandName === "voice") {
        const clonedChoices = listVoices(interaction.guildId)
            .filter(v => v.label.toLowerCase().includes(focused))
            .map(v => ({
                name: `🗣️ ${v.label} (cloned)`.slice(0, 100),
                value: `clone:${v.voiceId}`
            }));

        const edgeChoices = EDGE_VOICES
            .filter(v => v.name.toLowerCase().includes(focused))
            .map(v => ({
                name: v.name,
                value: `edge:${v.value}`
            }));

        // Vozes clonadas aparecem primeiro na lista de sugestões
        const choices = [...clonedChoices, ...edgeChoices].slice(0, 25); // Discord só aceita até 25 opções
        return interaction.respond(choices).catch(() => {});
    }

    if (interaction.commandName === "deletevoice" || interaction.commandName === "enrichvoice") {
        // Só sugere as vozes que o usuário pode alterar (as dele, ou todas se for admin)
        const choices = listVoices(interaction.guildId)
            .filter(v => canManageVoice(interaction, v))
            .filter(v => v.label.toLowerCase().includes(focused))
            .map(v => ({
                name: `${interaction.commandName === "deletevoice" ? "🗑️" : "🎙️"} ${v.label}`.slice(0, 100),
                value: v.voiceId
            }))
            .slice(0, 25);

        return interaction.respond(choices).catch(() => {});
    }
}

async function handleCommand(interaction) {
    switch (interaction.commandName) {
        case "join": {
            const voiceChannel = interaction.member.voice.channel;

            if (!voiceChannel) {
                return interaction.reply({
                    content: "❌ You need to join a voice channel first.",
                    ...EPHEMERAL
                });
            }

            await interaction.deferReply();

            try {
                await connectToChannel(voiceChannel);
                console.log("🔌 Connection status: READY");
                await interaction.editReply(`✅ Joined **${voiceChannel.name}**!`);
            } catch (error) {
                console.error("❌ Voice connection error:", error);
                await interaction.editReply("❌ Failed to connect to the voice channel.");
            }
            return;
        }

        case "skip": {
            const player = getExistingPlayer(interaction.guildId);

            if (!player || !isGuildPlaying(interaction.guildId)) {
                return interaction.reply({
                    content: "⚠️ There is no audio currently playing to skip.",
                    ...EPHEMERAL
                });
            }

            player.stop();
            return interaction.reply("⏭️ Audio skipped!");
        }

        case "voice": {
            await interaction.deferReply(EPHEMERAL);

            const raw = interaction.options.getString("voice");
            const separatorIndex = raw.indexOf(":");
            const type = raw.slice(0, separatorIndex);
            const value = raw.slice(separatorIndex + 1);

            if (type !== "edge" && type !== "clone") {
                return interaction.editReply(
                    "❌ Invalid voice. Type to search and select one of the suggested options."
                );
            }

            let label;
            if (type === "clone") {
                const voiceMeta = getVoice(value);
                // Só aceita vozes clonadas deste servidor
                if (!voiceMeta || voiceMeta.guildId !== interaction.guildId) {
                    return interaction.editReply("❌ This cloned voice no longer exists. Please select another one.");
                }
                label = voiceMeta.label;
            } else {
                const edgeVoice = EDGE_VOICES.find(v => v.value === value);
                if (!edgeVoice) {
                    return interaction.editReply(
                        "❌ Invalid voice. Type to search and select one of the suggested options."
                    );
                }
                label = edgeVoice.name;
            }

            setUserVoice(interaction.guildId, interaction.user.id, { type, value });

            return interaction.editReply(`✅ Your personal voice has been set to **${label}**!`);
        }

        case "setchannel": {
            await interaction.deferReply();

            const channel = interaction.options.getChannel("channel");

            updateGuildConfig(interaction.guildId, { channelId: channel.id, mode: "all" });

            return interaction.editReply(
                `✅ TTS channel set to: ${channel}\n` +
                `✅ TTS mode set to **All Messages**.`
            );
        }

        case "mode": {
            const mode = interaction.options.getString("type");
            const config = getGuildConfig(interaction.guildId);

            // O modo "prefix" só pode ser ativado se já houver um prefixo cadastrado
            if (mode === "prefix" && !config.prefix) {
                return interaction.reply({
                    content: "❌ You must set a prefix before switching to prefix mode!",
                    ...EPHEMERAL
                });
            }

            updateGuildConfig(interaction.guildId, { mode });

            return interaction.reply(`✅ Mode changed to **${mode}**`);
        }

        case "prefix": {
            const prefix = interaction.options.getString("symbol").trim();

            if (!prefix) {
                return interaction.reply({ content: "❌ The prefix cannot be empty.", ...EPHEMERAL });
            }

            updateGuildConfig(interaction.guildId, { prefix });

            return interaction.reply(`✅ Prefix set to **${prefix}**`);
        }

        case "author": {
            const enabled = interaction.options.getBoolean("enabled");
            updateGuildConfig(interaction.guildId, { announceAuthor: enabled });

            return interaction.reply(`✅ Announce author: **${enabled ? "enabled" : "disabled"}**`);
        }

        case "clonevoice": {
            await interaction.deferReply(EPHEMERAL);

            const attachment = interaction.options.getAttachment("audio");
            const label = interaction.options.getString("name").trim().slice(0, MAX_LABEL_LENGTH);
            const consent = interaction.options.getBoolean("consent");
            const language = interaction.options.getString("language") || "pt";

            if (!consent) {
                return interaction.editReply(
                    "❌ You can only clone a voice with the speaker's permission. " +
                    "Set **consent** to True to confirm you have it."
                );
            }

            if (!label) {
                return interaction.editReply("❌ The voice name cannot be empty.");
            }

            if (listVoices(interaction.guildId, interaction.user.id).length >= MAX_VOICES_PER_USER) {
                return interaction.editReply(
                    `❌ You already have ${MAX_VOICES_PER_USER} cloned voices. Delete one with \`/deletevoice\` first.`
                );
            }

            if (listVoices(interaction.guildId).length >= MAX_VOICES_PER_GUILD) {
                return interaction.editReply(
                    `❌ This server already has ${MAX_VOICES_PER_GUILD} cloned voices. Delete some with \`/deletevoice\` first.`
                );
            }

            const { extension, error } = validateAttachment(attachment);
            if (error) return interaction.editReply(error);

            const voiceId = randomUUID();
            const voiceDir = path.join(VOICES_DIR, interaction.guildId, voiceId);

            try {
                fs.mkdirSync(voiceDir, { recursive: true });
                const referencePath = path.join(voiceDir, `reference${extension}`);

                // Baixa o áudio anexado no Discord e salva como referência da voz
                const sampleError = await downloadSample(attachment, referencePath);
                if (sampleError) {
                    fs.rmSync(voiceDir, { recursive: true, force: true });
                    return interaction.editReply(sampleError);
                }

                registerVoice({
                    voiceId,
                    label,
                    ownerId: interaction.user.id,
                    guildId: interaction.guildId,
                    referencePath,
                    language
                });

                setUserVoice(interaction.guildId, interaction.user.id, { type: "clone", value: voiceId });

                return interaction.editReply(
                    `✅ Voice **${label}** cloned, saved and set as your voice!\n` +
                    `Use \`/voice\` to switch voices whenever you want.`
                );
            } catch (error) {
                console.error("❌ Voice cloning error:", error);
                fs.rmSync(voiceDir, { recursive: true, force: true });
                return interaction.editReply("❌ Failed to process the uploaded audio. Please try again.");
            }
        }

        case "deletevoice": {
            await interaction.deferReply(EPHEMERAL);

            const voiceId = interaction.options.getString("voice");
            const voiceMeta = getVoice(voiceId);

            if (!voiceMeta || voiceMeta.guildId !== interaction.guildId) {
                return interaction.editReply("❌ This voice does not exist or has already been deleted.");
            }

            if (!canManageVoice(interaction, voiceMeta)) {
                return interaction.editReply("❌ You can only delete voices you created.");
            }

            deleteVoice(voiceId);
            clearClonedVoiceSelections(interaction.guildId, voiceId);

            return interaction.editReply(`🗑️ Voice **${voiceMeta.label}** deleted successfully.`);
        }

        case "enrichvoice": {
            await interaction.deferReply(EPHEMERAL);

            const voiceId = interaction.options.getString("voice");
            const attachment = interaction.options.getAttachment("audio");

            const voiceMeta = getVoice(voiceId);
            if (!voiceMeta || voiceMeta.guildId !== interaction.guildId) {
                return interaction.editReply("❌ This voice does not exist or has already been deleted. Select one of the suggested options.");
            }

            if (!canManageVoice(interaction, voiceMeta)) {
                return interaction.editReply("❌ You can only add samples to voices you created.");
            }

            const referencePaths = getReferencePaths(voiceMeta);
            if (referencePaths.length >= MAX_SAMPLES_PER_VOICE) {
                return interaction.editReply(`❌ This voice already has the maximum of ${MAX_SAMPLES_PER_VOICE} samples.`);
            }

            const { extension, error } = validateAttachment(attachment);
            if (error) return interaction.editReply(error);

            // Usa a mesma pasta das amostras existentes (vozes antigas podem estar em outro layout)
            const voiceDir = referencePaths.length > 0
                ? path.dirname(referencePaths[0])
                : path.join(VOICES_DIR, interaction.guildId, voiceId);
            // UUID no nome evita sobrescrever uma amostra existente
            const newSamplePath = path.join(voiceDir, `sample_${randomUUID()}${extension}`);

            try {
                fs.mkdirSync(voiceDir, { recursive: true });

                const sampleError = await downloadSample(attachment, newSamplePath);
                if (sampleError) return interaction.editReply(sampleError);

                const totalSamples = addVoiceSample(voiceId, newSamplePath);

                return interaction.editReply(
                    `✅ Voice **${voiceMeta.label}** enhanced! It now has **${totalSamples}** reference sample(s).`
                );
            } catch (error) {
                console.error("❌ Voice enhancement error:", error);
                fs.rmSync(newSamplePath, { force: true });
                return interaction.editReply("❌ Failed to process the uploaded audio. Please try again.");
            }
        }

        case "leave": {
            const connection = getVoiceConnection(interaction.guildId);

            if (!connection) {
                return interaction.reply({
                    content: "❌ I am not connected to a voice channel.",
                    ...EPHEMERAL
                });
            }

            // A fila, os áudios pendentes e o estado são limpos pelo handler de "Destroyed"
            connection.destroy();
            return interaction.reply("👋 Left the voice channel!");
        }

        default:
            return;
    }
}

module.exports = function registerInteractionCreateEvent(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            if (interaction.isAutocomplete()) {
                return await handleAutocomplete(interaction);
            }

            if (!interaction.isChatInputCommand()) return;

            // Todos os comandos dependem de um servidor (canal de voz, config, vozes)
            if (!interaction.inGuild()) {
                return await interaction.reply({
                    content: "❌ This command can only be used inside a server.",
                    ...EPHEMERAL
                });
            }

            await handleCommand(interaction);
        } catch (error) {
            console.error(`❌ Error handling /${interaction.commandName}:`, error);

            if (!interaction.isRepliable()) return;

            const content = "❌ Something went wrong while running this command.";
            const reply = interaction.deferred || interaction.replied
                ? interaction.editReply(content)
                : interaction.reply({ content, ...EPHEMERAL });

            await reply.catch(() => {});
        }
    });
};
