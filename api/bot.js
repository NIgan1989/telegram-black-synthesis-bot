const db = require('../src/db');
const bot = require('../src/bot');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const envDiag = {
    has_token: !!process.env.TELEGRAM_BOT_TOKEN,
    has_channel: !!process.env.TELEGRAM_CHANNEL_ID,
    has_db: !!process.env.DATABASE_URL,
    has_admin: !!process.env.ADMIN_TELEGRAM_ID,
    has_gemini: !!process.env.GEMINI_API_KEY,
    demo_mode: process.env.DEMO_MODE,
    update_type: req.body
      ? Object.keys(req.body).filter(k => k !== 'update_id').join(',')
      : 'empty'
  };

  try {
    await db.init();
    const botInstance = bot.initBot();

    if (!botInstance) {
      console.warn('⚠️ Webhook принят, но бот в demo/disabled режиме. Проверь env vars в Production:', JSON.stringify(envDiag));
      return res.status(200).json({
        ok: true,
        processed: false,
        reason: 'bot_disabled_demo_mode',
        diag: envDiag
      });
    }

    if (req.body) {
      console.log(`📨 Webhook: ${envDiag.update_type} | env OK: token=${envDiag.has_token} db=${envDiag.has_db} admin=${envDiag.has_admin}`);
      await botInstance.processUpdate(req.body);
    }

    res.status(200).json({ ok: true, processed: true });
  } catch (error) {
    console.error('❌ Webhook Serverless Error:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
};
