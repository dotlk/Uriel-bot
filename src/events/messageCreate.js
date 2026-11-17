const { Events } = require("discord.js");

const { getGuildConfig } = require("../../configManager");
const { formatTextForTTS } = require("../text/formatText");
const { queueSpeech, shouldAnnounceAuthor, isConnectionReady } = require("../audio/queueManager");

module.exports = function registerMessageCreateEvent(client) {
    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot || !message.guild) return;

        try {
            const config = getGuildConfig(message.guild.id);
            if (!config.channelId || message.channel.id !== config.channelId) return;

            // Sem o bot na call não há pra quem falar — não gera áudio nem acumula fila
            if (!isConnectionReady(message.guild.id)) return;

            let text = formatTextForTTS(message);

            if (config.mode === "prefix") {
                if (!config.prefix || !text.startsWith(config.prefix)) return;
                text = text.slice(config.prefix.length).trim();
            }

            if (!text) return;

            if (config.announceAuthor && shouldAnnounceAuthor(message.guild.id, message.author.id)) {
                const name = message.member?.displayName || message.author.displayName || message.author.username;
                text = `${name} disse: ${text}`;
            }

            console.log("🔊 Enviando para a fila de TTS:", text);
            queueSpeech(text, message.guild.id, message.author.id);
        } catch (error) {
            console.error("❌ Erro ao processar mensagem para TTS:", error);
        }
    });
};
