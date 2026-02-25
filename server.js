import express from 'express';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// --- MongoDB Configuration ---
mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

const UserSchema = new mongoose.Schema({
    phoneNumber: String,
    sessionString: String
});
const User = mongoose.model('User', UserSchema);

// Env Variables
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// Global tempClient for login persistence
let tempClient;

// --- API ROUTES ---

// 1. OTP ပို့ခြင်း
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        // StringSession အသစ်ဖြင့် Client ကို စတင်ခြင်း
        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { 
            connectionRetries: 5,
            deviceModel: "TG Cloud Web",
            systemVersion: "1.0.0"
        });
        
        await tempClient.connect();
        
        const { phoneCodeHash } = await tempClient.sendCode({ apiId, apiHash }, phone);
        res.json({ success: true, phoneCodeHash, phone });
    } catch (err) {
        console.error("OTP Sending Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. OTP Verify လုပ်ခြင်း (ERROR FIXED: tempClient.signIn is not a function)
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        
        // GramJS version အသစ်များအတွက် invoke(Api.auth.SignIn) ကို သုံးရပါမည်
        await tempClient.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash,
                phoneCode: code,
            })
        );

        // Login အောင်မြင်ပါက Session ကို သိမ်းဆည်းမည်
        const sessionString = tempClient.session.save();
        
        await User.findOneAndUpdate(
            { phoneNumber: phone }, 
            { sessionString: sessionString }, 
            { upsert: true }
        );

        res.json({ success: true, message: "Logged in successfully!" });
    } catch (err) {
        console.error("Verification Failed:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. ဖိုင်စာရင်းများ ဆွဲထုတ်ခြင်း
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).json({ error: "Please login first!" });

        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        
        // CHAT_ID မှ message များကို ဆွဲယူခြင်း
        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        
        const files = messages.filter(m => m.media).map(m => ({
            id: m.id,
            text: m.message || (m.media.document ? "Document" : "Media File"),
            date: m.date,
            type: m.media.className
        }));
        
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Streaming Download (RAM ကန့်သတ်ချက်အတွက်)
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).send("Unauthorized");

        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();

        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        const message = messages[0];

        if (!message || !message.media) return res.status(404).send("File not found");

        // Download Response Headers
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="File_${msgId}"`);

        // Telegram ကနေ User ဆီ တိုက်ရိုက် Stream လုပ်ခြင်း
        for await (const chunk of client.iterDownload({
            file: message.media,
            chunkSize: 512 * 1024, // 512KB chunks
        })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) {
        console.error("Download Error:", err);
        res.status(500).send(err.message);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
