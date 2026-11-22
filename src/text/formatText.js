// O gemoji 8 exporta { emojiToName, nameToEmoji, gemoji } (não existe "unicodeToEmoji")
const { emojiToName } = require("gemoji");

const { getEmojiDictionary } = require("./emojiDictionary");

// Limite de caracteres falados por mensagem (evita que um textão trave a call por minutos)
const MAX_TTS_CHARS = 300;

// Pega emojis completos: bandeiras, keycaps (1️⃣) e sequências com tom de pele / ZWJ (👨‍👩‍👧)
const EMOJI_REGEX = /[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}]|‍\p{Extended_Pictographic}️?)*/gu;

const URL_REGEX = /\bhttps?:\/\/\S+/gi;

// Procura o nome de um emoji no emojis.json e, como reserva, no gemoji (nome em inglês)
function lookupEmojiName(emoji) {
    const customEmojiDictionary = getEmojiDictionary() || {};

    // Tenta o emoji como veio, sem o seletor de variação e sem o tom de pele
    const candidates = [
        emoji,
        emoji.replace(/️/g, ""),
        emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    ];

    for (const candidate of candidates) {
        if (customEmojiDictionary[candidate]) {
            return customEmojiDictionary[candidate];
        }
    }

    for (const candidate of candidates) {
        const englishName = emojiToName[candidate] || emojiToName[`${candidate}️`];
        if (englishName) {
            // Checa se o nome em inglês está mapeado no emojis.json
            return customEmojiDictionary[englishName] || englishName.replace(/[-_]/g, " ");
        }
    }

    return null;
}

// 🔤 Converte qualquer emoji Unicode para o seu nome correspondente
function replaceUnicodeEmojisWithNames(text) {
    return text.replace(EMOJI_REGEX, (match) => {
        // Keycap (1️⃣): fala só o caractere
        if (match.includes("⃣")) {
            return ` ${match[0]} `;
        }

        try {
            const name = lookupEmojiName(match);
            return name ? ` ${name} ` : "";
        } catch (err) {
            console.error(`⚠️ Erro ao processar o emoji "${match}":`, err.message);
            return ""; // Em caso de qualquer imprevisto, ignora o emoji e previne o crash do bot
        }
    });
}

// Corta o texto no limite sem partir palavras no meio
function truncateAtWord(text, maxChars) {
    if (text.length <= maxChars) return text;

    const candidate = text.slice(0, maxChars);
    const lastSpace = candidate.lastIndexOf(" ");
    return (lastSpace > 0 ? candidate.slice(0, lastSpace) : candidate).trim();
}

// 📝 Prepara o texto de uma mensagem do Discord para ser falado pelo TTS
function formatTextForTTS(message) {
    const customEmojiDictionary = getEmojiDictionary() || {};

    const rawText = message.content.trim();

    const onlyMentionsRegex = /^(?:<[a-z@#!&]?:?\w+:?\d+>|\s+)+$/i;
    if (onlyMentionsRegex.test(rawText)) {
        return "";
    }

    let text = rawText;

    // Menções: usa os dados que já vêm junto da mensagem (não depende do cache de membros)
    text = text.replace(/<@(&?|!?)(\d+)>/g, (match, prefix, id) => {
        if (prefix === "&") {
            const role = message.mentions.roles.get(id) || message.guild.roles.cache.get(id);
            return role ? `@${role.name}` : "";
        }

        const member = message.mentions.members?.get(id) || message.guild.members.cache.get(id);
        if (member) return `@${member.displayName}`;

        const user = message.mentions.users.get(id);
        return user ? `@${user.displayName || user.username}` : "";
    });

    text = text.replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = message.guild.channels.cache.get(channelId);
        return channel ? `#${channel.name}` : "";
    });

    // Links não são lidos letra por letra
    text = text.replace(URL_REGEX, " link ");

    // Trata emojis customizados do Discord (<:nome:id> ou <a:nome:id>)
    text = text.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, (match, emojiName) => {
        const mappedName = customEmojiDictionary[emojiName] || emojiName.replace(/[-_]/g, " ");
        return ` ${mappedName} `;
    });

    text = replaceUnicodeEmojisWithNames(text);
    text = text.replace(/\s+/g, " ").trim();

    return truncateAtWord(text, MAX_TTS_CHARS);
}

module.exports = {
    MAX_TTS_CHARS,
    formatTextForTTS,
    replaceUnicodeEmojisWithNames
};
