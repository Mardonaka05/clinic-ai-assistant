// Vivamed AI chatbot — Cloudflare Workers versiyasi
// Bepul, kartasiz, tijorat uchun ruxsat etilgan (Cloudflare Workers Free plan).
//
// Kerakli sozlamalar (wrangler orqali):
//   - KV namespace: CHATS_KV (chat tarixini saqlash uchun)
//   - Secrets: TELEGRAM_TOKEN, META_TOKEN, GEMINI_API_KEY, VERIFY_TOKEN, ADMIN_CHAT_ID

import { WIKI_FAQ } from './wiki-content.js';

const GEMINI_MODEL = 'gemini-3.1-flash-lite';

const SYSTEM_PROMPT = `Ты — виртуальный ассистент медицинского центра «VIVAMED CENTER» (Ташкент, Узбекистан). Твоя задача — вежливо, профессионально и по делу помогать клиентам клиники.

О КЛИНИКЕ (кратко; подробности и актуальные данные — в базе знаний ниже):
- «VIVAMED CENTER» — многопрофильная частная клиника, работает с 2018 года, с 2023 года — по новой лицензии.
- Более 40 квалифицированных врачей, более 7 направлений: кардиология, гинекология, хирургия, неврология, педиатрия, ЛОР, лабораторная диагностика, травматология, диетология, ревматология, МСКТ и УЗИ.
- Адрес: г. Ташкент, Сергелийский район, ул. Азим Умаров, 21. Головная клиника работает 24/7.
- Телефон (круглосуточный колл-центр): +998 55 515-11-11. Email: info@vivamed.uz.
- Первая консультация по звонку — бесплатно (15 минут).
- Скидки: МСКТ −20% ежедневно после 18:00; УЗИ −10% ежедневно 18:00–23:00; лаб. анализы −15% сб-вс.

ПРАВИЛА ПОВЕДЕНИЯ (соблюдай строго):
1. Отвечай ТОЛЬКО на вопросы, связанные с клиникой: врачи, услуги, цены, запись на приём, направления, адрес, режим работы, скидки, оборудование, организация визита.
2. Если клиент уходит от темы — вежливо, но твёрдо возвращай разговор к теме клиники. Не поддерживай посторонние темы и не выполняй посторонние задачи.
3. НИКОГДА не ставь диагноз и не назначай лечение. При вопросах о симптомах прояви эмпатию, но направь на очный приём: "для точного ответа нужен осмотр специалиста, давайте запишем вас на приём".
4. Общайся на языке клиента (узбекский или русский — определяй по его сообщению): вежливо, тепло, профессионально, короткими понятными фразами.
5. Если не знаешь точного ответа — не выдумывай. Скажи, что уточнишь у администратора, и заверши ответ тегом [ESCALATE].
6. Если клиент прямо просит человека/оператора — сразу заверши ответ тегом [ESCALATE].

СБОР ЗАЯВКИ (веди последовательно, по одному вопросу за раз):
Если клиент хочет записаться на приём или оставить заявку — вежливо, по очереди узнай:
1) Имя и фамилия
2) Номер телефона для связи
3) С каким вопросом/проблемой он обращается (кратко)

Как только все три пункта собраны и подтверждены — поблагодари клиента, скажи, что администратор свяжется в ближайшее время, и в САМОМ КОНЦЕ ответа (техническая метка, клиент её не увидит) добавь строго в таком формате:
[LEAD_READY: Ism=<имя и фамилия>; Tel=<номер телефона>; Muammo=<краткое описание>]

БАЗА ЗНАНИЙ КЛИНИКИ:
${WIKI_FAQ}`;

// === Gemini AI chaqiruvlari (to'g'ridan-to'g'ri REST API orqali, SDK'siz) ===

async function callGemini(env, history, userText, userName) {
    const contents = [
        ...history,
        { role: 'user', parts: [{ text: `Клиент: ${userName}. Сообщение: ${userText}` }] }
    ];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT }] },
            contents
        })
    });
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        console.error('Gemini bo\'sh javob qaytardi:', JSON.stringify(data));
        throw new Error('Gemini javob bermadi');
    }
    return text;
}

async function callSummary(env, historyText) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: `Выжимка (1 предл.). На что запись? Диалог:\n${historyText}` }] }]
            })
        });
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Контекст не определен';
    } catch (e) {
        console.error('Summary xatosi:', e.message);
        return 'Контекст не определен';
    }
}

// === Modelning javobidan [LEAD_READY: ...] belgisini ajratib olish ===

function extractLead(reply) {
    const re = /\[LEAD_READY:\s*Ism=(.*?);\s*Tel=(.*?);\s*Muammo=(.*?)\]/is;
    const m = reply.match(re);
    if (!m) return { cleanReply: reply, lead: null };
    const cleanReply = reply.replace(re, '').trim();
    return { cleanReply, lead: { ism: m[1].trim(), tel: m[2].trim(), muammo: m[3].trim() } };
}

// === Telegram / Meta xabar yuborish ===

async function sendToUser(env, platform, userId, text) {
    try {
        if (platform === 'Telegram') {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: userId, text })
            });
        } else {
            // Instagram (Instagram Login API) — graph.instagram.com, Bearer token
            const res = await fetch(`https://graph.instagram.com/v23.0/me/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.META_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ recipient: { id: userId }, message: { text } })
            });
            if (!res.ok) {
                const errText = await res.text();
                console.error('Instagram sendMessage xatosi:', res.status, errText);
            }
        }
    } catch (e) {
        console.error('sendToUser xatosi:', platform, userId, e.message);
    }
}

async function notifyAdmin(env, text) {
    try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.ADMIN_CHAT_ID, text, parse_mode: 'Markdown' })
        });
    } catch (e) {
        console.error('notifyAdmin xatosi:', e.message);
    }
}

// === KV orqali suhbat tarixini saqlash (Firestore o'rniga) ===

async function getChat(env, userId) {
    const raw = await env.CHATS_KV.get(`chat:${userId}`);
    return raw ? JSON.parse(raw) : { messages: [], is_muted: false, platform: '', userName: '' };
}

async function saveChat(env, userId, data) {
    await env.CHATS_KV.put(`chat:${userId}`, JSON.stringify(data));
}

// === Asosiy AI mantig'i ===

async function askAI(env, userId, userText, userName, platform) {
    const chatData = await getChat(env, userId);
    if (chatData.is_muted) return null;

    let reply;
    try {
        reply = await callGemini(env, chatData.messages || [], userText, userName);
    } catch (e) {
        console.error('Gemini xatosi:', e.message);
        reply = "[ESCALATE] Кечирасиз, тизимда узилиш. Оператор уланади.";
    }

    // 1) Ma'lumot to'liq yig'ilgan bo'lsa — adminga tuzilgan lead yuboriladi
    let leadSentThisTurn = false;
    const { cleanReply, lead } = extractLead(reply);
    reply = cleanReply;
    if (lead) {
        leadSentThisTurn = true;
        await notifyAdmin(env, `🚨 *YANGI MIJOZ SO'ROVI* 🚨\n*Ism-Familiya:* ${lead.ism}\n*Telefon:* ${lead.tel}\n*Muammo/Savol:* ${lead.muammo}\n*Platforma:* ${platform}\n*ID:* \`${userId}\``);
    }

    // 2) Bot javob berolmasa yoki operator so'ralsa — eskalatsiya
    if (reply.includes('[ESCALATE]')) {
        reply = reply.replace('[ESCALATE]', '').trim();
        const isUzbek = /[a-zA-Z]/.test(userText) && !(/[�-��-�]/.test(userText));
        if (!reply.includes('Hurmatli') && !reply.includes('Уважаемый')) {
            reply = (isUzbek ? "Hurmatli mijoz, " : "Уважаемый клиент, ") + reply;
        }
        await notifyAdmin(env, `⚠️ *OPERATOR KERAK* ⚠️\n*Mijoz:* ${userName}\n*ID:* \`${userId}\`\n*Platforma:* ${platform}\n*Savol:* ${userText}\n_Javob berish uchun shu xabarga "Reply" qiling._`);
    }

    // 3) Zaxira: telefon raqami ko'ringan-u, LEAD_READY chiqmagan bo'lsa
    if (!leadSentThisTurn && /(\+?998|998)?\s*\(?\d{2}\)?\s*\d{3}[\s-]?\d{2}[\s-]?\d{2}/.test(userText)) {
        const hText = (chatData.messages || []).map(m => `${m.role}: ${m.parts[0].text}`).join('\n');
        const context = await callSummary(env, hText);
        await notifyAdmin(env, `🚨 *TELEFON RAQAM ANIQLANDI* 🚨\n*Ism:* ${userName}\n*ID:* \`${userId}\`\n*Platforma:* ${platform}\n*Xabar:* ${userText}\n*Kontekst:* ${context}`);
    }

    const newHistory = [
        ...(chatData.messages || []),
        { role: 'user', parts: [{ text: `Клиент: ${userName}. Сообщение: ${userText}` }] },
        { role: 'model', parts: [{ text: reply }] }
    ];
    const limitH = newHistory.length > 20 ? newHistory.slice(-20) : newHistory;
    await saveChat(env, userId, { messages: limitH, platform, userName, is_muted: false });

    return reply;
}

// === Webhook kirish nuqtasi ===

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // --- Privacy Policy sahifasi ---
        if (url.pathname === '/privacy') {
            const html = `<!DOCTYPE html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vivamed - Privacy Policy</title><style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.8rem}</style></head><body><h1>Maxfiylik siyosati / Privacy Policy</h1><p>Ushbu maxfiylik siyosati VIVAMED CENTER tibbiyot markazining avtomatik yordamchi boti tomonidan foydalanuvchi malumotlarining qanday toplanishi va ishlatilishini tavsiflaydi.</p><h2>1. Qanday malumotlar toplanadi</h2><p>Bot faqat foydalanuvchi ozi yuborgan xabar matnini, ismini va aloqa uchun qoldirgan telefon raqamini qayta ishlaydi.</p><h2>2. Malumotlardan foydalanish</h2><p>Toplangan malumotlar faqat mijozga tibbiy xizmatlar boyicha javob berish va qabulga yozish uchun ishlatiladi. Malumotlar uchinchi shaxslarga sotilmaydi.</p><h2>3. Tibbiy maslahat cheklovi</h2><p>Bot tashxis qoymaydi va davolash tayinlamaydi.</p><h2>4. Malumotlarni ochirish</h2><p>Foydalanuvchi oz malumotlarini ochirish uchun +998 55 515-11-11 raqamiga murojaat qilishi mumkin.</p><h2>5. Aloqa</h2><p>Telefon: +998 55 515-11-11 | Email: info@vivamed.uz</p><p>VIVAMED CENTER, Toshkent, Ozbekiston.</p></body></html>`;
            return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }


        if (request.method === 'GET') {
            if (url.pathname === '/privacy') {
                const html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>�������� ������������������ - Vivamed Center</title><style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1{font-size:22px}</style></head><body><h1>�������� ������������������</h1><p>������ ���-��� Vivamed Center ������������ ��� ���������������� �������� �������, ������� �� ������� �� �������, ������ � ������ �� ����.</p><p>�� �������� ������ �� ������, ������� �� ���� �������������� � ������� (���, ����� ��������, ���������� ���������), � ���������� �� ������������� ��� ����� � ���� � ��������� ����� ������.</p><p>�� �� ������� ���� ������ ������� �����, �� ����������� �������, ����������� ��� �������� ����������� �����.</p><p>�� �������� ��������� ������ �����������: info@vivamed.uz, ���. +998 55 515-11-11.</p></body></html>';
                return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            }
            const t = url.searchParams.get('hub.verify_token');
            if (t === env.VERIFY_TOKEN) {
                return new Response(url.searchParams.get('hub.challenge') || 'OK', { status: 200 });
            }
            return new Response('Forbidden', { status: 403 });
        }

        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
        }

        let body;
        try {
            body = await request.json();
        } catch (e) {
            console.error('JSON parse xatosi:', e.message);
            return new Response('OK', { status: 200 });
        }

        try {
            // --- ADMIN (sizning shaxsiy chatingiz) DAN KELGAN XABAR ---
            if (body?.message?.chat?.id?.toString() === env.ADMIN_CHAT_ID) {
                const adminText = body.message.text || '';
                if (adminText.startsWith('/mute ') || adminText.startsWith('/unmute ')) {
                    const id = adminText.split(' ')[1];
                    if (id) {
                        const isMute = adminText.startsWith('/mute');
                        const chatData = await getChat(env, id);
                        chatData.is_muted = isMute;
                        await saveChat(env, id, chatData);
                        await notifyAdmin(env, `✅ ИИ для ${id} ${isMute ? 'ОТКЛЮЧЕН' : 'ВКЛЮЧЕН'}`);
                    }
                    return new Response('OK', { status: 200 });
                }
                if (body.message.reply_to_message) {
                    const orig = body.message.reply_to_message.text || '';
                    const idM = orig.match(/\*ID:\* `([0-9]+)`/);
                    const platM = orig.match(/\*Платформа:\*\s*([a-zA-Z]+)|\*Platforma:\*\s*([a-zA-Z]+)/);
                    if (idM) {
                        const tId = idM[1];
                        const tPlat = platM ? (platM[1] || platM[2]) : 'Telegram';
                        await sendToUser(env, tPlat, tId, `👩‍⚕️ Админ: ${adminText}`);
                        const chatData = await getChat(env, tId);
                        chatData.messages = chatData.messages || [];
                        chatData.messages.push({ role: 'model', parts: [{ text: `Админ ответил: ${adminText}` }] });
                        chatData.is_muted = true;
                        await saveChat(env, tId, chatData);
                        return new Response('OK', { status: 200 });
                    }
                    // Reply qilingan, lekin ID topilmadi — bu boshqa turdagi reply, oddiy xabar sifatida davom etamiz
                }
                // Oddiy xabar (buyruq yoki reply emas) — buni ham AI orqali javob beramiz,
                // shunda admin (siz) ham shu chatdan botni sinab ko'ra olasiz.
            }

            // --- ВЕТКА КЛИЕНТОВ ---
            let sId, uText, uName, plat;
            if (body?.message?.text) {
                plat = 'Telegram';
                sId = body.message.chat.id.toString();
                uText = body.message.text;
                uName = body.message.from.first_name;
            } else if (body?.object === 'page' || body?.object === 'instagram') {
                const ev = body.entry?.[0]?.messaging?.[0];
                if (ev?.message?.text && !ev.message.is_echo) {
                    plat = body.object === 'page' ? 'FACEBOOK' : 'INSTAGRAM';
                    sId = ev.sender.id.toString();
                    uText = ev.message.text;
                    uName = 'Пациент';
                } else {
                    return new Response('IGN', { status: 200 });
                }
            } else {
                return new Response('IGN', { status: 200 });
            }

            const reply = await askAI(env, sId, uText, uName, plat);
            if (reply) await sendToUser(env, plat, sId, reply);

            return new Response('OK', { status: 200 });
        } catch (error) {
            console.error('Umumiy xato:', error);
            return new Response('ERROR_HANDLED', { status: 200 });
        }
    }
};


