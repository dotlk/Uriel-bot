require("dotenv").config();
const {
    REST,
    Routes,
    SlashCommandBuilder,
    ChannelType,
    InteractionContextType,
    PermissionFlagsBits
} = require("discord.js");

const XTTS_LANGUAGES = require("./src/voices/languages");

// Comandos que mudam a configuração do servidor ficam restritos a quem pode gerenciá-lo.
// Os administradores podem liberar para outros cargos em Configurações do Servidor > Integrações.
const ADMIN_ONLY = PermissionFlagsBits.ManageGuild;

const commands = [
    new SlashCommandBuilder()
        .setName("join")
        .setDescription("Connects the bot to your current voice channel."),

    new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Disconnects the bot from the voice channel."),

    new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Immediately skips the current speech or audio playback."),

    new SlashCommandBuilder()
        .setName("setchannel")
        .setDescription("Sets the text channel the bot will monitor for TTS messages.")
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addChannelOption(option =>
            option
                .setName("channel")
                .setDescription("The text channel to monitor")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("mode")
        .setDescription("Changes the reading mode (all messages or prefix only).")
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription("Choose the reading mode")
                .setRequired(true)
                .addChoices(
                    { name: "All Messages", value: "all" },
                    { name: "Prefix Only", value: "prefix" }
                )
        ),

    new SlashCommandBuilder()
        .setName("prefix")
        .setDescription("Sets the prefix character used to trigger TTS (e.g., ! or .).")
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption(option =>
            option
                .setName("symbol")
                .setDescription("The prefix character")
                .setRequired(true)
                .setMaxLength(5)
        ),

    new SlashCommandBuilder()
        .setName("author")
        .setDescription("Enables or disables reading the author's name before their message.")
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addBooleanOption(option =>
            option
                .setName("enabled")
                .setDescription("Whether to read the author's name aloud")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("voice")
        .setDescription("Sets your personal TTS voice.")
        .addStringOption(option =>
            option
                .setName("voice")
                .setDescription("Search Edge TTS voices and cloned voices available on the server")
                .setRequired(true)
                .setAutocomplete(true)
        ),

    new SlashCommandBuilder()
        .setName("clonevoice")
        .setDescription("Clones a voice from a reference audio file and sets it as your voice.")
        .addAttachmentOption(option =>
            option
                .setName("audio")
                .setDescription("An .mp3 or .wav file containing 6 to 30 seconds of speech")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("name")
                .setDescription("A name to identify this voice (e.g., 'My Voice')")
                .setRequired(true)
                .setMaxLength(50)
        )
        .addBooleanOption(option =>
            option
                .setName("consent")
                .setDescription("I confirm the person in this audio gave permission to clone their voice")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("language")
                .setDescription("Language the cloned voice will speak (default: Portuguese)")
                .addChoices(...XTTS_LANGUAGES)
        ),

    new SlashCommandBuilder()
        .setName("deletevoice")
        .setDescription("Deletes one of your cloned voices from the server.")
        .addStringOption(option =>
            option
                .setName("voice")
                .setDescription("Search your cloned voices")
                .setRequired(true)
                .setAutocomplete(true)
        ),

    new SlashCommandBuilder()
        .setName("enrichvoice")
        .setDescription("Adds another audio sample to one of your cloned voices to improve its quality.")
        .addStringOption(option =>
            option
                .setName("voice")
                .setDescription("Search your cloned voices")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addAttachmentOption(option =>
            option
                .setName("audio")
                .setDescription("Another .mp3 or .wav file with 6 to 30 seconds of speech from the same person")
                .setRequired(true)
        )
].map(command => command
    // Nenhum comando funciona fora de um servidor
    .setContexts(InteractionContextType.Guild)
    .toJSON()
);

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        if (process.env.GUILD_ID) {
            console.log("🧹 Clearing old server commands (Guild ID)...");
            await rest.put(
                Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
                { body: [] }
            );
        }

        // O PUT substitui a lista inteira de comandos globais de uma vez,
        // então não precisa (nem deve) apagar tudo antes.
        console.log("🔄 Registering slash commands on Discord...");
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );

        console.log("✅ Slash commands registered and updated successfully!");
    } catch (error) {
        console.error("❌ Error registering commands:", error);
        process.exitCode = 1;
    }
})();
