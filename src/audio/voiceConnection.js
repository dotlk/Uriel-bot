const {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const { getPlayer, processQueue, resetGuild } = require("./queueManager");

// Conexões que já têm os handlers de estado registrados
// (joinVoiceChannel devolve a mesma conexão se o bot já estiver no servidor)
const managedConnections = new WeakSet();

function attachConnectionHandlers(connection, guildId) {
    if (managedConnections.has(connection)) return;
    managedConnections.add(connection);

    connection.on("stateChange", async (oldState, newState) => {
        switch (newState.status) {
            case VoiceConnectionStatus.Disconnected:
                // Pode ser só uma troca de canal ou uma queda rápida: dá alguns segundos pra reconectar.
                // Se não voltar (ex: o bot foi expulso da call), destrói a conexão.
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
                    ]);
                } catch {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        console.log(`🔌 ${guildId}: conexão de voz perdida, desconectando.`);
                        connection.destroy();
                    }
                }
                break;

            case VoiceConnectionStatus.Ready:
                // Voltou (ou acabou de conectar): continua tocando o que estiver na fila
                processQueue(guildId);
                break;

            case VoiceConnectionStatus.Destroyed:
                await resetGuild(guildId);
                break;

            default:
                break;
        }
    });
}

// Conecta (ou move) o bot pro canal de voz e espera a conexão ficar pronta
async function connectToChannel(voiceChannel) {
    const guildId = voiceChannel.guild.id;

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    attachConnectionHandlers(connection, guildId);

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
        connection.destroy();
        throw error;
    }

    connection.subscribe(getPlayer(guildId));
    return connection;
}

module.exports = { connectToChannel };
