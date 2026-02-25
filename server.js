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
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP & Handle 2FA
app.post('/api/auth/verify-code', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        
        try {
            await tempClient.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code,
                })
            );
            
            // Success without 2FA
            const sessionString = tempClient.session.save();
            await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });
            return res.json({ success: true, message: "Logged in!" });

        } catch (signInErr) {
            // Password လိုအပ်နေလျှင် (2FA)
            if (signInErr.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                return res.json({ success: false, requiresPassword: true });
            }
            throw signInErr;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Verify Password (New Route for 2FA)
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password, phone } = req.body;
        
        // Telegram password check
        await tempClient.signInUserPassword(password);

        const sessionString = tempClient.session.save();
        await User.findOneAndUpdate({ phoneNumber: phone }, { sessionString }, { upsert: true });

        res.json({ success: true, message: "Logged in with 2FA!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- File List & Download Route များ အရင်အတိုင်း ထားနိုင်ပါသည် ---
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
            date: m.date,
            type: m.media.className
        }));
        res.json(files);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/download/:msgId', async (req, res) => {
    try {
        const user = await User.findOne();
        const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, {});
        await client.connect();
        const msgId = parseInt(req.params.msgId);
        const messages = await client.getMessages(process.env.CHAT_ID, { ids: [msgId] });
        for await (const chunk of client.iterDownload({ file: messages[0].media, chunkSize: 512 * 1024 })) {
            res.write(chunk);
        }
        res.end();
    } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
