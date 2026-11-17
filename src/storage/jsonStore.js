const fs = require("fs");
const path = require("path");

// 💾 Armazena um objeto JSON em disco com cache em memória e gravação atômica.
//
// - O arquivo é lido UMA vez (na primeira chamada de get()) e mantido em memória,
//   em vez de ser lido e parseado a cada mensagem.
// - A gravação é feita num arquivo temporário e depois renomeada por cima do original,
//   então um crash no meio da escrita nunca deixa o arquivo pela metade.
// - Se o arquivo estiver corrompido, ele é preservado como "<arquivo>.corrupt-<timestamp>"
//   em vez de ser sobrescrito por um objeto vazio (o que apagaria todos os dados).
function createJsonStore(filePath, { onLoad } = {}) {
    let data = null;

    function writeAtomic(content) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, content, "utf8");

        try {
            fs.renameSync(tmpPath, filePath);
        } catch (error) {
            // No Windows o rename pode falhar se outro processo (antivírus, OneDrive)
            // estiver segurando o arquivo — nesse caso grava direto como reserva.
            fs.writeFileSync(filePath, content, "utf8");
            fs.rmSync(tmpPath, { force: true });
        }
    }

    function load() {
        if (!fs.existsSync(filePath)) {
            return {};
        }

        const raw = fs.readFileSync(filePath, "utf8");
        if (!raw.trim()) {
            return {};
        }

        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (error) {
            const backupPath = `${filePath}.corrupt-${Date.now()}`;
            fs.copyFileSync(filePath, backupPath);
            console.error(
                `❌ ${path.basename(filePath)} está corrompido (${error.message}). ` +
                `Uma cópia foi salva em ${path.basename(backupPath)} e o bot vai começar com dados vazios.`
            );
            return {};
        }
    }

    function get() {
        if (data === null) {
            data = load();

            if (onLoad && onLoad(data)) {
                save();
            }
        }
        return data;
    }

    function save() {
        writeAtomic(JSON.stringify(get(), null, 4));
    }

    return { get, save };
}

module.exports = { createJsonStore };
