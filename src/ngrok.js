require("dotenv").config();

const ngrok = require("@ngrok/ngrok");

const PORT = Number(process.env.PORT || 3000);

async function startNgrok() {
    try {
        const token = process.env.NGROK_AUTHTOKEN;

        if (!token) {
            throw new Error("Missing NGROK_AUTHTOKEN in .env");
        }

        const listener = await ngrok.forward({
            addr: PORT,
            authtoken: token,
        });

        console.log("=================================");
        console.log("Ngrok is running!");
        console.log(`Local:  http://localhost:${PORT}`);
        console.log(`Public: ${listener.url()}`);
        console.log("=================================");

        // Giữ tiến trình Node.js hoạt động
        const keepAlive = setInterval(() => { }, 60000);

        // Dừng ngrok khi tắt ứng dụng
        async function shutdown() {
            clearInterval(keepAlive);

            try {
                await listener.close();
            } catch (error) {
                console.error("Error closing ngrok:", error);
            }

            process.exit(0);
        }

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);

    } catch (error) {
        console.error("Ngrok error:", error);
        process.exit(1);
    }
}

startNgrok();