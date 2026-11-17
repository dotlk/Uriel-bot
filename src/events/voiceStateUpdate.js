const { Events } = require("discord.js");
const { getVoiceConnection } = require("@discordjs/voice");

// Tempo que o bot espera numa call vazia antes de sair sozinho
const EMPTY_CHANNEL_TIMEOUT_MS = 60_000;

const leaveTimers = new Map();

function cancelLeaveTimer(guildId) {
    const timer = leaveTimers.get(guildId);
    if (timer) {
        clearTimeout(timer);
        leaveTimers.delete(guildId);
    }
}

// Conta quantas pessoas (não bots) estão no canal onde o bot está
function countHumansInBotChannel(guild) {
    const connection = getVoiceConnection(guild.id);
    if (!connection) return null;

    const channel = guild.channels.cache.get(connection.joinConfig.channelId);
    if (!channel) return 0;

    return channel.members.filter(member => !member.user.bot).size;
}

module.exports = function registerVoiceStateUpdateEvent(client) {
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        const guild = newState.guild || oldState.guild;
        const humans = countHumansInBotChannel(guild);

        if (humans === null) {
            cancelLeaveTimer(guild.id);
            return;
        }

        if (humans > 0) {
            cancelLeaveTimer(guild.id);
            return;
        }

        if (leaveTimers.has(guild.id)) return;

        leaveTimers.set(guild.id, setTimeout(() => {
            leaveTimers.delete(guild.id);

            // Confere de novo: alguém pode ter entrado nesse meio tempo
            if (countHumansInBotChannel(guild) === 0) {
                console.log(`👋 ${guild.id}: canal de voz vazio, saindo.`);
                getVoiceConnection(guild.id)?.destroy();
            }
        }, EMPTY_CHANNEL_TIMEOUT_MS));
    });
};
