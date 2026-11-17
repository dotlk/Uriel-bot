const fs = require("fs");
const path = require("path");

const { createJsonStore } = require("../storage/jsonStore");

// Pasta onde ficam os arquivos de áudio de referência de cada voz clonada
const VOICES_DIR = path.join(__dirname, "..", "..", "voices");

// Os arquivos de áudio seguem a organização em disco: voices/<guildId>/<voiceId>/*.mp3
const VOICES_FILE = path.join(VOICES_DIR, "voices.json");

// Migra o formato ANTIGO (voiceId como chave de topo, com guildId dentro de cada voz)
// pro formato NOVO (guildId como chave de topo). Detecta o formato antigo verificando
// se alguma entrada de topo tem uma propriedade "guildId" (só voz tem isso, guild não).
// Retorna true se os dados foram alterados.
function migrateIfNeeded(data) {
    const oldEntries = Object.entries(data).filter(([, meta]) => meta && typeof meta.guildId === "string");
    if (oldEntries.length === 0) return false;

    for (const [voiceId, meta] of oldEntries) {
        const { guildId, ...rest } = meta;
        delete data[voiceId];
        if (!data[guildId]) data[guildId] = {};
        data[guildId][voiceId] = rest;
    }

    console.log("🔄 voices.json migrado pro novo formato (organizado por servidor).");
    return true;
}

const store = createJsonStore(VOICES_FILE, { onLoad: migrateIfNeeded });

// 🔄 Vozes criadas antes do suporte a múltiplas amostras guardavam um único
// "referencePath" (string). Essa função devolve sempre uma lista.
function getReferencePaths(meta) {
    if (!meta) return [];
    if (Array.isArray(meta.referencePaths) && meta.referencePaths.length > 0) {
        return meta.referencePaths;
    }
    if (meta.referencePath) {
        return [meta.referencePath];
    }
    return [];
}

// Acha em qual servidor um voiceId está registrado. Retorna { guildId, meta } ou null.
function findVoiceOwner(voices, voiceId) {
    for (const [guildId, guildVoices] of Object.entries(voices)) {
        if (guildVoices[voiceId]) {
            return { guildId, meta: guildVoices[voiceId] };
        }
    }
    return null;
}

// Retorna os metadados de uma voz clonada específica (ou null se não existir).
// Busca em todos os servidores — voiceId é um UUID único, não há ambiguidade.
// Quem usa deve conferir o guildId retornado antes de permitir o uso da voz.
function getVoice(voiceId) {
    const found = findVoiceOwner(store.get(), voiceId);
    return found ? { voiceId, ...found.meta, guildId: found.guildId } : null;
}

// Lista todas as vozes clonadas de um servidor (opcionalmente filtrando por dono)
function listVoices(guildId, ownerId = null) {
    const guildVoices = store.get()[guildId] || {};

    return Object.entries(guildVoices)
        .filter(([, meta]) => !ownerId || meta.ownerId === ownerId)
        .map(([voiceId, meta]) => ({ voiceId, ...meta, guildId }));
}

// Registra uma nova voz clonada (com a primeira amostra). Retorna o voiceId gerado.
function registerVoice({ voiceId, label, ownerId, guildId, referencePath, language }) {
    const voices = store.get();

    if (!voices[guildId]) voices[guildId] = {};

    voices[guildId][voiceId] = {
        label,
        ownerId,
        language,
        referencePaths: [referencePath],
        createdAt: new Date().toISOString()
    };

    store.save();
    return voiceId;
}

// ✨ Adiciona mais uma amostra de referência numa voz já existente (comando /enrichvoice).
// Retorna o total de amostras que a voz passa a ter, ou null se a voz não existir.
function addVoiceSample(voiceId, newReferencePath) {
    const voices = store.get();
    const found = findVoiceOwner(voices, voiceId);
    if (!found) return null;

    const { guildId, meta } = found;
    const updatedPaths = [...getReferencePaths(meta), newReferencePath];

    voices[guildId][voiceId] = {
        ...meta,
        referencePaths: updatedPaths
    };
    delete voices[guildId][voiceId].referencePath; // limpa o campo antigo, se existia

    store.save();
    return updatedPaths.length;
}

// Remove uma voz clonada (metadados + pasta inteira com todos os arquivos de referência)
function deleteVoice(voiceId) {
    const voices = store.get();
    const found = findVoiceOwner(voices, voiceId);
    if (!found) return false;

    const { guildId, meta } = found;
    const paths = getReferencePaths(meta);
    if (paths.length > 0) {
        fs.rmSync(path.dirname(paths[0]), { recursive: true, force: true });
    }

    delete voices[guildId][voiceId];

    // Se o servidor ficou sem nenhuma voz, remove a chave do servidor E a pasta vazia em disco
    if (Object.keys(voices[guildId]).length === 0) {
        delete voices[guildId];
        fs.rmSync(path.join(VOICES_DIR, guildId), { recursive: true, force: true });
    }

    store.save();
    return true;
}

module.exports = {
    VOICES_DIR,
    getVoice,
    listVoices,
    registerVoice,
    addVoiceSample,
    getReferencePaths,
    deleteVoice
};
