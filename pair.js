import express from 'express';
import fs from 'fs';
import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser
} from 'baileys';
import { upload } from './mega.js';

const router = express.Router();

// Keep track of the current session directory for cleanup
let activeSessionDir = null;

// Utility to remove a file or directory
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

  // Clean up any previous files
  removePath(sessionDir);

  let retryCount = 0;
  const MAX_RETRIES = 5;

  async function initiateSession() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    try {
      const logger = pino({ level: 'info' }).child({ level: 'info' });
      const sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        logger,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
      });

      // If not yet registered, request pairing code
      if (!sock.authState.creds.registered) {
        await delay(2000);
        const code = await sock.requestPairingCode(sessionId);
        if (!res.headersSent) {
          console.log({ sessionId, code });
          res.send({ code });
        }
      }

      // Save credentials on updates
      sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          console.log('Connection opened successfully');
          await delay(10000);

          // Read the saved credentials
          const credsJSON = fs.readFileSync(`${sessionDir}/creds.json`);

          // Generate a random Mega filename
          function generateRandomId(len = 6, numLen = 4) {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let result = '';
            for (let i = 0; i < len; i++) {
              result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            const number = Math.floor(Math.random() * 10 ** numLen);
            return `${result}${number}`;
          }

          // Upload to Mega and extract file ID
          const megaUrl = await upload(fs.createReadStream(`${sessionDir}/creds.json`), `${generateRandomId()}.json`);
          const sessionToken = megaUrl.replace('https://mega.nz/file/', '');

          // Send the session token
          const targetJid = jidNormalizedUser(`${sessionId}@s.whatsapp.net`);
          const mergeSid = "HANS-BYTE~"+sessionToken;
          await sock.sendMessage(targetJid, { text: mergeSid });

          // Send confirmation message
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
            ` });

          // Clean up and exit
          await delay(100);
          removePath(sessionDir);
          process.exit(0);
        } else if (connection === 'close' && lastDisconnect && lastDisconnect.error?.output?.statusCode !== 401) {
          console.log('Connection closed unexpectedly:', lastDisconnect.error);
          retryCount++;
          if (retryCount < MAX_RETRIES) {
            console.log(`Retrying... (${retryCount}/${MAX_RETRIES})`);
            await delay(10000);
            initiateSession();
          } else {
            console.log('Max retries reached.');
            if (!res.headersSent) {
              res.status(500).send({ message: 'Unable to reconnect after multiple attempts.' });
            }
          }
        }
      });
    } catch (err) {
      console.error('Error initializing session:', err);
      if (!res.headersSent) {
        res.status(503).send({ code: 'Service Unavailable' });
      }
    }
  }

  await initiateSession();
});

// Cleanup on exit
process.on('exit', () => {
  if (activeSessionDir) removePath(activeSessionDir);
  console.log('Cleanup complete.');
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (activeSessionDir) removePath(activeSessionDir);
  process.exit(1);
});

export default router;
