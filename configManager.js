const path = require("path");
const { createJsonStore } = require("./src/storage/jsonStore");

// Arquivo de configuração (por servidor)
const store = createJsonStore(path.join(__dirname, "config.json"));

// Voz padrão do Edge TTS usada quando o usuário nunca configurou nada
const DEFAULT_VOICE = { type: "edge", value: "es-MX-DaliaNeural" };

function createDefaultGuildConfig() {
    return {
        channelId: null,
        mode: "all",
        announceAuthor: true,
        userVoices: {}
    };
}

// Retorna a configuração de um servidor (cria uma padrão se ainda não existir)
function getGuildConfig(guildId) {
    const config = store.get();
    let changed = false;

    if (!config[guildId]) {
        config[guildId] = createDefaultGuildConfig();
        changed = true;
    }

    // Garante que a propriedade userVoices exista mesmo em servidores antigos
    if (!config[guildId].userVoices) {
        config[guildId].userVoices = {};
        changed = true;
    }

    if (changed) {
        store.save();
    }

    return config[guildId];
}

// Atualiza configurações
function updateGuildConfig(guildId, data) {
    const config = store.get();

    config[guildId] = {
        ...getGuildConfig(guildId),
        ...data
    };

    store.save();
}

// Retorna a voz do usuário no formato { type: "edge" | "clone", value: string }
function getUserVoice(guildId, userId) {
    const voice = getGuildConfig(guildId).userVoices[userId];

    if (!voice) {
        return DEFAULT_VOICE;
    }

    // Formato antigo: só o nome da voz do Edge
    if (typeof voice === "string") {
        return { type: "edge", value: voice };
    }

    return voice;
}

// Salva a voz escolhida pelo usuário
function setUserVoice(guildId, userId, voice) {
    getGuildConfig(guildId).userVoices[userId] = voice;
    store.save();
}

// Remove de todos os usuários do servidor uma voz clonada que foi apagada
function clearClonedVoiceSelections(guildId, voiceId) {
    const { userVoices } = getGuildConfig(guildId);
    let changed = false;

    for (const [userId, voice] of Object.entries(userVoices)) {
        if (voice && voice.type === "clone" && voice.value === voiceId) {
            delete userVoices[userId];
            changed = true;
        }
    }

    if (changed) {
        store.save();
    }
}

module.exports = {
    DEFAULT_VOICE,
    getGuildConfig,
    updateGuildConfig,
    getUserVoice,
    setUserVoice,
    clearClonedVoiceSelections
};
