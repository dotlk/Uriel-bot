const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// ⏱️ Lê a duração (em segundos) de um arquivo de áudio usando o ffmpeg.
// Retorna null se o arquivo não for um áudio válido.
function getAudioDurationSeconds(filePath) {
    return new Promise(resolve => {
        // Sem arquivo de saída o ffmpeg termina com erro, mas antes imprime as infos da mídia
        execFile(ffmpegPath, ["-hide_banner", "-i", filePath], { timeout: 15_000 }, (error, stdout, stderr) => {
            const output = String(stderr || "");
            const hasAudio = /Stream #.*Audio:/.test(output);
            const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);

            if (!hasAudio || !match) {
                return resolve(null);
            }

            const [, hours, minutes, seconds] = match;
            resolve(Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
        });
    });
}

module.exports = { getAudioDurationSeconds };
