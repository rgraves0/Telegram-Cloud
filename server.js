import express from 'express';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// MongoDB Setup
mongoose.connect(process.env.MONGO_URL).then(() => console.log("✅ MongoDB Connected"));

const UserSchema = new mongoose.Schema({
    phoneNumber: String,
    sessionString: String
});
const User = mongoose.model('User', UserSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
let tempClient;

// 1. Send OTP
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { phone } = req.body;
        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { 
            connectionRetries: 5,
            deviceModel: "TG Cloud Web"
        });
        await tempClient.connect();
        const { phoneCodeHash } = await tempClient.sendCode({ apiId, apiHash }, phone);
        res.json({ success: true, phoneCodeHash, phone });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP & Handle 2FA (Fixed)
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        
        try {
            // signIn function ကို အသုံးပြုခြင်းက version အသစ်တွေမှာ ပိုတည်ငြိမ်ပါတယ်
            await tempClient.signIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash,
                phoneCode: code,
                // Password မပါဘဲ အရင်စမ်းမယ်
                password: async () => { throw new Error("PASSWORD_NEEDED") }
            });
            
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });
            return res.json({ success: true });

        } catch (err) {
            // Password လိုအပ်လျှင် Client ဆီ အကြောင်းကြားမည်
            if (err.message === "PASSWORD_NEEDED" || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({ success: false, requiresPassword: true });
            }
            throw err;
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Verify Password (2FA အား ပြန်လည်ပြင်ဆင်ထားသော Logic)
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password, phone } = req.body;
        
        // GramJS version အသစ်တွင် 2FA password ကို ဤသို့ verify လုပ်ပါသည်
        await tempClient.signIn({
            phoneNumber: phone,
            password: async () => password,
        });

        const sessionString = tempClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Password မှားယွင်းနေပါသည်။ " + err.message });
    }
});

// --- File List ---
app.get('/api/files', async (req, res) => {
    try {
        const user = await User.findOne();
        if (!user) return res.status(401).json({ error: "Please login!" });
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        const messages = await client.getMessages(process.env.CHAT_ID, { limit: 50 });
        const files = messages.filter(m => m.media).map(m => ({
            id: m.id,
            text: m.message || "File",
            date: m.date
        }));
        res.json(files);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Streaming Download ---
app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        if (!messages[0] || !messages[0].media) return res.status(404).send("File not found");

        for await (const chunk of client.iterDownload({ file: messages[0].media, chunkSize: 512 * 1024 })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
