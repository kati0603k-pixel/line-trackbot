const express = require('express');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// 1. ตั้งค่า Credentials
const THAILAND_POST_TOKEN = 'X-DeC1RDUTTvJhCAADR?WYDoGoLCZ7JrZOM6HfEsNZR&CgX&PGClGYWNLRIXI8XxSMMpWwEjE8V2SGAXZcSyOUX?X#RvE-DtX.B$';
const LINE_ACCESS_TOKEN = 'MXPvr8APX1+2YYEEvqN/AdiQcZTRmxu9LYs0k9yQmRePxvNeT6ZsVQR5nGGVAa9h9FyqaBiwUzulrbA3vuQRrzT8w/osCDH3L6nkm4WYEQxPyIHSw6Wnb/b5PA9rpPlK+nbXt7JhapUyVT0wcOUQqwdB04t89/1O/w1cDnyilFU=';

// รายการพัสดุทั้งหมดในระบบ
let trackedParcels = [];

// Cache Token เพื่อไม่ให้ยิงขอ Token ใหม่ทุกๆ ครั้ง
let cachedPostToken = null;
let tokenExpireTime = 0;

async function getPostToken() {
  const now = Date.now();
  if (cachedPostToken && now < tokenExpireTime) {
    return cachedPostToken;
  }

  try {
    const tokenResponse = await fetch('https://trackapi.thailandpost.co.th/post/api/v1/authenticate/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${THAILAND_POST_TOKEN}`
      }
    });
    const tokenData = await tokenResponse.json();
    cachedPostToken = tokenData.token;
    tokenExpireTime = now + (23 * 60 * 60 * 1000); // ตั้งหมดอายุไว้ที่ 23 ชั่วโมง
    return cachedPostToken;
  } catch (err) {
    console.error('❌ ขอ Token ไปรษณีย์ไทยล้มเหลว:', err);
    return null;
  }
}

// ฟังก์ชันสำหรับส่งข้อความกลับไปยัง LINE
async function sendLineNotification(userId, messageText) {
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: messageText }]
      })
    });
    console.log(`🔔 ส่ง LINE แจ้งเตือนไปยัง ${userId} สำเร็จ!`);
  } catch (err) {
    console.error('❌ ส่ง LINE ล้มเหลว:', err);
  }
}

// ฟังก์ชันเช็กสถานะพัสดุ
async function checkSingleParcel(barcode) {
  const token = await getPostToken();
  if (!token) return null;

  const trackResponse = await fetch('https://trackapi.thailandpost.co.th/post/api/v1/track', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${token}`
    },
    body: JSON.stringify({
      status: 'all',
      language: 'TH',
      barcode: [barcode]
    })
  });
  const trackData = await trackResponse.json();
  return trackData.response?.items?.[barcode] || null;
}

// ----------------------------------------------------
// Webhook Route สำหรับรับข้อความจาก LINE Chat
// ----------------------------------------------------
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events;
  if (!events || events.length === 0) return;

  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userMessage = event.message.text.trim();
      const userId = event.source.userId;

      const parcelRegex = /^[A-Za-z0-9]{13}$/;

      if (parcelRegex.test(userMessage)) {
        const barcode = userMessage.toUpperCase();

        const existing = trackedParcels.find(p => p.barcode === barcode && p.userId === userId);
        if (existing) {
          await sendLineNotification(userId, `ℹ️ เลขพัสดุ ${barcode} อยู่ในระบบติดตามอยู่แล้วครับ`);
          continue;
        }

        const items = await checkSingleParcel(barcode);

        if (items && items.length > 0) {
          const latest = items[items.length - 1];
          const isDelivered = latest.status === '501' || latest.status_description.includes('นำจ่ายสำเร็จ');

          trackedParcels.push({
            barcode: barcode,
            userId: userId,
            lastStatus: `${latest.status_description}_${latest.status_date}`,
            isDelivered: isDelivered
          });

          let replyMsg = `✅ เพิ่มเลขพัสดุ ${barcode} เข้าสู่ระบบติดตามแล้ว!\n\n` +
                         `📍 สถานะล่าสุด: ${latest.status_description}\n` +
                         `🏢 สถานที่: ${latest.location}\n` +
                         `🕒 วัน/เวลา: ${latest.status_date}`;

          if (isDelivered) {
            replyMsg += `\n\n🎉 พัสดุรายการนี้นำจ่ายสำเร็จแล้ว`;
          } else {
            replyMsg += `\n\nระบบจะคอยแจ้งเตือนให้อัตโนมัติเมื่อมีการอัปเดตครับ`;
          }

          await sendLineNotification(userId, replyMsg);
        } else {
          await sendLineNotification(userId, `❌ ไม่พบข้อมูลสำหรับเลขพัสดุ ${barcode} ในระบบไปรษณีย์ไทย กรุณาตรวจสอบความถูกต้องอีกครั้งครับ`);
        }

      } else {
        await sendLineNotification(userId, `🤖 สวัสดีครับ! พิมพ์ส่ง "เลขพัสดุ 13 หลัก" (เช่น EF123456789TH) มาในแชตนี้ได้เลย เพื่อให้ระบบคอยติดตามสถานะให้อัตโนมัติครับ`);
      }
    }
  }
});

// ----------------------------------------------------
// Cron Job เช็กพัสดุค้างจ่ายทุกๆ 15 นาที
// ----------------------------------------------------
cron.schedule('*/15 * * * *', async () => {
  const activeParcels = trackedParcels.filter(p => !p.isDelivered);
  if (activeParcels.length === 0) return;

  console.log(`\n🕒 [${new Date().toLocaleTimeString()}] กำลังเช็กพัสดุในคิวติดตาม (${activeParcels.length} รายการ)...`);

  for (let item of activeParcels) {
    try {
      const items = await checkSingleParcel(item.barcode);
      if (items && items.length > 0) {
        const latest = items[items.length - 1];
        const currentStatusKey = `${latest.status_description}_${latest.status_date}`;

        if (item.lastStatus !== currentStatusKey) {
          item.lastStatus = currentStatusKey;

          const msg = `🚨 พัสดุมีการอัปเดตสถานะใหม่!\n` +
                      `📦 เลขพัสดุ: ${item.barcode}\n` +
                      `📍 สถานะ: ${latest.status_description}\n` +
                      `🏢 สถานที่: ${latest.location}\n` +
                      `🕒 วัน/เวลา: ${latest.status_date}`;

          await sendLineNotification(item.userId, msg);

          if (latest.status === '501' || latest.status_description.includes('นำจ่ายสำเร็จ')) {
            item.isDelivered = true;
            console.log(`✅ ${item.barcode} นำจ่ายสำเร็จแล้ว ปลดออกจากคิวเช็กอัตโนมัติ`);
          }
        }
      }
    } catch (err) {
      console.error(`Error checking ${item.barcode}:`, err);
    }
  }
});

// รองรับทั้ง Port ของ Render (process.env.PORT) และ Localhost (3000)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Webhook Server ทำงานที่พอร์ต ${PORT}...`);
});