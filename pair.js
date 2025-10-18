// pair.js
import express from 'express';
import fs from 'fs';
import pino from 'pino';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  jidNormalizedUser,
  fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';
import { upload } from './mega.js';

const router = express.Router();

// Track active session directory for cleanup
let activeSessionDir = null;

// Utility to safely remove files/directories
function removePath(path) {
  try {
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Error removing path:', e);
  }
}

router.get('/', async (req, res) => {
  const numParam = req.query.number;
  const sessionId = numParam ? numParam.replace(/[^0-9]/g, '') : 'session';
  const sessionDir = `./${sessionId}`;
  activeSessionDir = sessionDir;

  // Cleanup any previous session files
  removePath(sessionDir);

  let retryCount = 0;
  const MAX_RETRIES = 5;

  async function initiateSession() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    try {
      // ✅ Fetch latest WhatsApp Web version (avoids 405/503)
      const { version, isLatest } = await fetchLatestWaWebVersion();
      console.log(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

      const logger = pino({ level: 'info' }).child({ level: 'info' });

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS('Chrome')
      });

      // Request pairing code if not registered
      if (!state?.creds?.registered) {
        await delay(2000);
        try {
          const code = await sock.requestPairingCode(sessionId);
          console.log({ sessionId, code });
          if (!res.headersSent) res.send({ code });
        } catch (pairErr) {
          console.error('Error requesting pairing code:', pairErr);
          if (!res.headersSent) {
            res.status(500).send({
              message: 'Pairing request failed',
              error: pairErr?.toString?.() || pairErr
            });
          }
          return;
        }
      }

      // Listen for credentials update
      sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          console.log('✅ Connection opened successfully');
          await delay(10000); // wait to stabilize connection

          const credsPath = `${sessionDir}/creds.json`;
          if (!fs.existsSync(credsPath)) {
            console.error('❌ creds.json not found');
            if (!res.headersSent) res.status(500).send({ message: 'No credentials file' });
            return;
          }

          // 🔹 Generate a random file name
          function generateRandomId(len = 6, numLen = 4) {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let result = '';
            for (let i = 0; i < len; i++) {
              result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            const number = Math.floor(Math.random() * 10 ** numLen);
            return `${result}${number}`;
          }

          try {
            // 🔹 Upload credentials to Mega
            const megaUrl = await upload(fs.createReadStream(credsPath), `${generateRandomId()}.json`);
            const sessionToken = megaUrl.replace('https://mega.nz/file/', '');

            // 🔹 Send confirmation messages
            const targetJid = jidNormalizedUser(`${sessionId}@s.whatsapp.net`);
            const mergeSid = 'HANS-BYTE~' + sessionToken;

            await sock.sendMessage(targetJid, { text: mergeSid });
            console.log('✅ Session ID sent to WhatsApp user.');

            await sock.sendMessage(targetJid, {
              text: `
┌──『 HANS PAIR 』──✵
 ❏ YOU HAVE SUCCESSFULLY PAIRED
 ❏ YOUR DEVICE WITH THE BOT
 ❏ THANK YOU FOR USING
 ❏ PLEASE FOLLOW OUR CHANNEL
 ❏ https://whatsapp.com/channel/0029VaZDIdxDTkKB4JSWUk1O
❏ FOR MORE UPDATES
└──────────────✸
𝙱𝚈 𝙷𝙰𝙽𝚂 𝚃𝙴𝙲𝙷 
▬▭▬▭▬▭▬▭▬▬▭▬▭▬
              `
            });
            console.log('✅ Confirmation message sent successfully.');

            // 🕒 Allow time for message delivery before cleanup
            await delay(5000);

            removePath(sessionDir);
            console.log('🧹 Session directory cleaned.');
          } catch (upErr) {
            console.error('❌ Mega upload or send failed:', upErr);
            if (!res.headersSent) {
              res.status(500).send({
                message: 'Upload or send failed',
                error: upErr?.toString?.() || upErr
              });
            }
            removePath(sessionDir);
            return;
          }
        } else if (connection === 'close') {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode ??
            lastDisconnect?.error?.statusCode ??
            null;

          console.log('⚠️ Connection closed:', statusCode || 'unknown');

          if (statusCode !== 401) {
            retryCount++;
            if (retryCount < MAX_RETRIES) {
              console.log('🔁 Reconnecting...');
              await delay(10000);
              initiateSession();
            } else {
              console.log('❌ Max retries reached.');
              if (!res.headersSent) {
                res.status(500).send({
                  message: 'Unable to reconnect after multiple attempts.'
                });
              }
            }
          } else {
            console.log('🔒 Logged out or unauthorized (401).');
            if (!res.headersSent) {
              res.status(401).send({
                message: 'Logged out or unauthorized. New pairing required.'
              });
            }
          }
        }
      });
    } catch (err) {
      console.error('❌ Error initializing session:', err);
      if (!res.headersSent) {
        res.status(503).send({
          code: 'Service Unavailable',
          error: err?.toString?.() || err
        });
      }
    }
  }

  await initiateSession();
});

// ✅ Cleanup on exit or crash
process.on('exit', () => {
  if (activeSessionDir) removePath(activeSessionDir);
  console.log('🧹 Cleanup complete.');
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err);
  if (activeSessionDir) removePath(activeSessionDir);
  process.exit(1);
});

export default router;
