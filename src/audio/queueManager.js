const fs = require("fs");
const path = require("path");

const {
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const { generateSpeech } = require("../tts/ttsRouter");
const { getUserVoice } = require("../../configManager");

// Pasta onde os áudios temporários são salvos
const AUDIO_DIR = path.join(__dirname, "..", "..", "audio");

// Limites anti-spam: quantas falas podem esperar na fila
const MAX_QUEUE_SIZE = 20;
const MAX_PENDING_PER_USER = 3;

// Tempo sem falar depois do qual o nome do autor volta a ser anunciado
const AUTHOR_ANNOUNCE_TIMEOUT_MS = 60_000;

const players = new Map();

// Estado de cada servidor:
// { queue: Array<{ text, userId, audioPromise }>, processing: boolean, lastSpeaker: { userId, at } | null }
// Quando o bot sai da call o estado é descartado; um loop de reprodução que ainda estava
// rodando percebe que o objeto mudou e para sozinho.
const guildStates = new Map();

function getState(guildId) {
    if (!guildStates.has(guildId)) {
        guildStates.set(guildId, { queue: [], processing: false, lastSpeaker: null });
    }
    return guildStates.get(guildId);
}

function safeUnlink(filePath) {
    if (!filePath) return;
    fs.rm(filePath, { force: true }, (err) => {
        if (err) console.error(`❌ Erro ao deletar o arquivo ${filePath}:`, err.message);
    });
}

// 🧹 Limpa áudios temporários que sobraram de execuções passadas
function cleanAudioFolder() {
    if (!fs.existsSync(AUDIO_DIR)) return;

    fs.readdir(AUDIO_DIR, (err, files) => {
        if (err) return console.error("❌ Erro ao ler pasta de áudios:", err);

        for (const file of files) {
            if (file.endsWith(".mp3") || file.endsWith(".wav")) {
                safeUnlink(path.join(AUDIO_DIR, file));
                console.log(`🧹 Áudio antigo/órfão removido: ${file}`);
            }
        }
    });
}

// 🧹 Descarta a fila de um servidor e apaga os áudios que ainda não foram tocados
async function clearGuildQueue(guildId) {
    const state = guildStates.get(guildId);
    if (!state) return;

    const pending = state.queue.splice(0);
    await Promise.all(pending.map(async (item) => safeUnlink(await item.audioPromise)));
}

function getPlayer(guildId) {
    if (!players.has(guildId)) {
        const player = createAudioPlayer();

        player.on("stateChange", (oldState, newState) => {
            console.log(`🎵 ${guildId}: ${oldState.status} -> ${newState.status}`);
        });

        // O erro sempre vem seguido de uma transição pra Idle, que é quem libera a fila.
        player.on("error", error => {
            console.error("❌ Player error:", error.message);
        });

        players.set(guildId, player);
    }

    return players.get(guildId);
}

// Retorna o player existente sem criar um novo (útil para comandos como /skip)
function getExistingPlayer(guildId) {
    return players.get(guildId);
}

function isConnectionReady(guildId) {
    const connection = getVoiceConnection(guildId);
    return !!connection && connection.state.status === VoiceConnectionStatus.Ready;
}

// Coloca uma fala na fila. O áudio começa a ser gerado na hora (em paralelo com o que
// estiver tocando), mas a reprodução respeita a ordem de chegada das mensagens.
// Retorna false se a fala foi descartada pelos limites anti-spam.
function queueSpeech(text, guildId, userId) {
    const state = getState(guildId);

    if (state.queue.length >= MAX_QUEUE_SIZE) {
        console.log(`⚠️ Fila do servidor ${guildId} cheia, mensagem ignorada.`);
        return false;
    }

    if (state.queue.filter(item => item.userId === userId).length >= MAX_PENDING_PER_USER) {
        console.log(`⚠️ Usuário ${userId} já tem ${MAX_PENDING_PER_USER} falas na fila, mensagem ignorada.`);
        return false;
    }

    // userVoice é um objeto: { type: "edge" | "clone", value: string }
    const userVoice = getUserVoice(guildId, userId);
    console.log(`⚡ [${userVoice.type}:${userVoice.value}] Pré-gerando áudio para o usuário ${userId}: "${text}"`);

    const audioPromise = generateSpeech(text, userVoice).catch(err => {
        console.error("❌ Erro ao gerar áudio:", err.message || err);
        return null;
    });

    state.queue.push({ text, userId, audioPromise });
    processQueue(guildId);
    return true;
}

// Toca um arquivo e resolve quando o player volta pra Idle (fim, /skip ou erro)
function playFile(player, audioPath) {
    return new Promise(resolve => {
        const onStateChange = (oldState, newState) => {
            if (newState.status === AudioPlayerStatus.Idle) {
                player.off("stateChange", onStateChange);
                resolve();
            }
        };

        player.on("stateChange", onStateChange);

        try {
            const resource = createAudioResource(fs.createReadStream(audioPath), {
                inputType: StreamType.Arbitrary
            });
            player.play(resource);
        } catch (error) {
            console.error("❌ Erro ao reproduzir o TTS:", error.message);
            player.off("stateChange", onStateChange);
            resolve();
        }
    });
}

async function processQueue(guildId) {
    const state = guildStates.get(guildId);
    if (!state || state.processing) return;

    state.processing = true;

    try {
        while (state.queue.length > 0) {
            // Se a conexão caiu, os itens esperam; ela chama processQueue de novo quando voltar
            if (!isConnectionReady(guildId)) return;

            const item = state.queue[0];
            const audioPath = await item.audioPromise;

            // O bot saiu da call (ou a fila foi limpa) enquanto o áudio era gerado
            if (guildStates.get(guildId) !== state || state.queue[0] !== item) {
                safeUnlink(audioPath);
                return;
            }

            state.queue.shift();

            if (!audioPath || !fs.existsSync(audioPath)) {
                console.error("❌ Arquivo de áudio inválido ou não encontrado, pulando.");
                continue;
            }

            const connection = getVoiceConnection(guildId);
            if (!connection) {
                safeUnlink(audioPath);
                return;
            }

            const player = getPlayer(guildId);
            connection.subscribe(player);

            await playFile(player, audioPath);
            safeUnlink(audioPath);
        }
    } finally {
        state.processing = false;
    }
}

function isGuildPlaying(guildId) {
    const player = players.get(guildId);
    return !!player && player.state.status !== AudioPlayerStatus.Idle;
}

// Diz se o nome do autor deve ser anunciado antes da mensagem e registra o autor atual
function shouldAnnounceAuthor(guildId, userId) {
    const state = getState(guildId);
    const now = Date.now();
    const last = state.lastSpeaker;

    const announce = !last || last.userId !== userId || now - last.at > AUTHOR_ANNOUNCE_TIMEOUT_MS;
    state.lastSpeaker = { userId, at: now };

    return announce;
}

// Descarta fila, estado e player de um servidor (usado quando o bot sai da call)
async function resetGuild(guildId) {
    await clearGuildQueue(guildId);
    guildStates.delete(guildId);

    const player = players.get(guildId);
    if (player) {
        player.stop(true);
        players.delete(guildId);
    }
}

module.exports = {
    AUDIO_DIR,
    cleanAudioFolder,
    clearGuildQueue,
    getPlayer,
    getExistingPlayer,
    isConnectionReady,
    queueSpeech,
    processQueue,
    isGuildPlaying,
    shouldAnnounceAuthor,
    resetGuild
};
