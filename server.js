const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
}

async function sendSMS(to, body) {
  return twilioClient.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: formatPhone(to),
  });
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── CLIENTS ───────────────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  const { data, error } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/api/clients', async (req, res) => {
  const { name, business_type, phone, email, google_review_link, twilio_number } = req.body;
  const { data, error } = await supabase.from('clients').insert([{
    name, business_type, phone, email, google_review_link, twilio_number, active: true
  }]).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.patch('/api/clients/:id', async (req, res) => {
  const { data, error } = await supabase.from('clients').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ── CONTACTS ──────────────────────────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
  const { client_id } = req.query;
  let query = supabase.from('contacts').select('*, clients(name)').order('created_at', { ascending: false });
  if (client_id) query = query.eq('client_id', client_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/api/contacts', async (req, res) => {
  const { client_id, name, phone, email } = req.body;
  const { data, error } = await supabase.from('contacts').insert([{
    client_id, name, phone, email,
    status: 'pending',
    sms_count: 0,
  }]).select().single();
  if (error) return res.status(500).json({ error });

  // Kick off the review request immediately
  await triggerReviewRequest(data);
  res.json(data);
});

// Bulk CSV import
app.post('/api/contacts/bulk', async (req, res) => {
  const { client_id, contacts } = req.body; // contacts: [{name, phone, email}]
  const rows = contacts.map(c => ({ ...c, client_id, status: 'pending', sms_count: 0 }));
  const { data, error } = await supabase.from('contacts').insert(rows).select();
  if (error) return res.status(500).json({ error });

  // Stagger sends — 1 per 5 seconds to avoid Twilio rate limits
  data.forEach((contact, i) => {
    setTimeout(() => triggerReviewRequest(contact), i * 5000);
  });

  res.json({ imported: data.length });
});

// ── REVIEW REQUEST LOGIC ──────────────────────────────────────────────────────
async function triggerReviewRequest(contact) {
  const { data: client } = await supabase.from('clients').select('*').eq('id', contact.client_id).single();
  if (!client || !client.active) return;

  const firstName = contact.name.split(' ')[0];
  const funnelUrl = `${BASE_URL}/funnel/${client.id}?contact=${contact.id}`;

  const message = `Hi ${firstName}! Thanks for choosing ${client.name} 😊 We'd love your feedback — it only takes 30 seconds. Tap here: ${funnelUrl}`;

  try {
    await sendSMS(contact.phone, message);
    await supabase.from('contacts').update({
      status: 'sms_sent',
      sms_count: 1,
      last_sms_at: new Date().toISOString(),
    }).eq('id', contact.id);

    await supabase.from('sms_log').insert([{
      contact_id: contact.id,
      client_id: contact.client_id,
      message,
      type: 'initial',
    }]);
  } catch (err) {
    console.error('SMS send failed FULL ERROR:', JSON.stringify(err));
  }
}

// ── FUNNEL PAGES ──────────────────────────────────────────────────────────────

// Step 1: Happy or not?
app.get('/funnel/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { contact } = req.query;
  const { data: client } = await supabase.from('clients').select('*').eq('id', clientId).single();
  if (!client) return res.status(404).send('Not found');

  // Track that they opened the funnel
  if (contact) {
    await supabase.from('contacts').update({ status: 'funnel_opened', funnel_opened_at: new Date().toISOString() }).eq('id', contact);
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>How was your experience?</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    background: #f8f6f1;
    display: flex; align-items: center; justify-content: center;
    font-family: 'DM Sans', sans-serif;
    padding: 24px;
  }
  .card {
    background: #fff;
    border-radius: 24px;
    padding: 56px 48px;
    max-width: 480px;
    width: 100%;
    text-align: center;
    box-shadow: 0 4px 40px rgba(0,0,0,0.08);
  }
  .business-name {
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9e9e9e;
    margin-bottom: 32px;
  }
  h1 {
    font-family: 'Playfair Display', serif;
    font-size: 32px;
    color: #1a1a1a;
    line-height: 1.3;
    margin-bottom: 12px;
  }
  p {
    color: #777;
    font-size: 15px;
    line-height: 1.6;
    margin-bottom: 40px;
  }
  .btn-row { display: flex; gap: 16px; justify-content: center; }
  .btn {
    flex: 1;
    padding: 18px 24px;
    border-radius: 16px;
    border: 2px solid transparent;
    font-size: 16px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    font-family: 'DM Sans', sans-serif;
  }
  .btn-good {
    background: #00c9a7;
    color: #fff;
  }
  .btn-good:hover { background: #00b396; transform: translateY(-2px); }
  .btn-bad {
    background: #fff;
    color: #555;
    border-color: #e0e0e0;
  }
  .btn-bad:hover { border-color: #999; transform: translateY(-2px); }
  .btn-emoji { font-size: 28px; }
</style>
</head>
<body>
<div class="card">
  <div class="business-name">${client.name}</div>
  <h1>How was your experience?</h1>
  <p>Your feedback means the world to us. It only takes a moment.</p>
  <div class="btn-row">
    <a href="/funnel/${clientId}/good?contact=${contact}" class="btn btn-good">
      <span class="btn-emoji">😊</span>
      <span>Great!</span>
    </a>
    <a href="/funnel/${clientId}/bad?contact=${contact}" class="btn btn-bad">
      <span class="btn-emoji">😕</span>
      <span>Not great</span>
    </a>
  </div>
</div>
</body>
</html>`);
});

// Step 2a: Good → redirect to Google review
app.get('/funnel/:clientId/good', async (req, res) => {
  const { clientId } = req.params;
  const { contact } = req.query;
  const { data: client } = await supabase.from('clients').select('*').eq('id', clientId).single();

  if (contact) {
    await supabase.from('contacts').update({
      status: 'clicked_good',
      clicked_good_at: new Date().toISOString(),
    }).eq('id', contact);
  }

  res.redirect(client.google_review_link);
});

// Step 2b: Bad → private feedback form
app.get('/funnel/:clientId/bad', async (req, res) => {
  const { clientId } = req.params;
  const { contact } = req.query;
  const { data: client } = await supabase.from('clients').select('*').eq('id', clientId).single();

  if (contact) {
    await supabase.from('contacts').update({ status: 'clicked_bad' }).eq('id', contact);
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>We're sorry to hear that</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    background: #f8f6f1;
    display: flex; align-items: center; justify-content: center;
    font-family: 'DM Sans', sans-serif;
    padding: 24px;
  }
  .card {
    background: #fff;
    border-radius: 24px;
    padding: 48px;
    max-width: 480px;
    width: 100%;
    box-shadow: 0 4px 40px rgba(0,0,0,0.08);
  }
  .business-name {
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9e9e9e;
    margin-bottom: 24px;
    text-align: center;
  }
  h1 {
    font-family: 'Playfair Display', serif;
    font-size: 28px;
    color: #1a1a1a;
    margin-bottom: 10px;
    text-align: center;
  }
  p { color: #777; font-size: 15px; line-height: 1.6; margin-bottom: 28px; text-align: center; }
  textarea, input {
    width: 100%;
    padding: 14px 16px;
    border: 1.5px solid #e8e8e8;
    border-radius: 12px;
    font-size: 14px;
    font-family: 'DM Sans', sans-serif;
    color: #333;
    margin-bottom: 14px;
    outline: none;
    transition: border-color 0.2s;
  }
  textarea:focus, input:focus { border-color: #00c9a7; }
  textarea { resize: vertical; min-height: 120px; }
  button {
    width: 100%;
    padding: 16px;
    background: #1a1a1a;
    color: #fff;
    border: none;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
  }
  button:hover { background: #333; }
</style>
</head>
<body>
<div class="card">
  <div class="business-name">${client.name}</div>
  <h1>We're sorry to hear that.</h1>
  <p>Tell us what happened and we'll make it right. This goes directly to our team — not public.</p>
  <form action="/funnel/${clientId}/feedback" method="POST">
    <input type="hidden" name="contact_id" value="${contact}">
    <input type="text" name="name" placeholder="Your name (optional)">
    <textarea name="feedback" placeholder="What could we have done better?" required></textarea>
    <button type="submit">Send Feedback</button>
  </form>
</div>
</body>
</html>`);
});

// Feedback form submission
app.post('/funnel/:clientId/feedback', async (req, res) => {
  const { contact_id, name, feedback } = req.body;
  const { clientId } = req.params;

  await supabase.from('feedback').insert([{ client_id: clientId, contact_id, name, feedback }]);
  if (contact_id) {
    await supabase.from('contacts').update({ status: 'left_feedback' }).eq('id', contact_id);
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thank you</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  body { min-height:100vh; background:#f8f6f1; display:flex; align-items:center; justify-content:center; font-family:'DM Sans',sans-serif; }
  .card { background:#fff; border-radius:24px; padding:56px 48px; max-width:440px; width:100%; text-align:center; box-shadow:0 4px 40px rgba(0,0,0,0.08); }
  h1 { font-family:'Playfair Display',serif; font-size:32px; color:#1a1a1a; margin-bottom:14px; }
  p { color:#777; font-size:15px; line-height:1.6; }
  .emoji { font-size:48px; margin-bottom:24px; }
</style>
</head>
<body>
<div class="card">
  <div class="emoji">🙏</div>
  <h1>Thank you.</h1>
  <p>Your feedback has been sent to our team. We truly appreciate you letting us know and will do better.</p>
</div>
</body>
</html>`);
});

// ── REVIEWS (AI Response) ─────────────────────────────────────────────────────
app.post('/api/reviews/respond', async (req, res) => {
  const { review_text, reviewer_name, rating, client_id } = req.body;
  const { data: client } = await supabase.from('clients').select('*').eq('id', client_id).single();

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: `You write Google review responses for ${client?.name || 'a local business'}, a ${client?.business_type || 'medical/wellness'} business.
Be warm, genuine, and professional. Sound like a real human — never robotic.
Never use: "we are thrilled", "we are so excited", "delighted to hear".
Keep it 2-4 sentences. If the reviewer's name is given, use it once naturally.
Vary your opening — don't always start with "Thank you".`,
    messages: [{
      role: 'user',
      content: `Write a response to this ${rating}-star Google review from ${reviewer_name || 'a customer'}: "${review_text}"`
    }]
  });

  const response = message.content[0].text;

  // Save to DB
  await supabase.from('reviews').insert([{
    client_id,
    reviewer_name,
    rating,
    review_text,
    ai_response: response,
    responded: false,
  }]);

  res.json({ response });
});

app.get('/api/reviews', async (req, res) => {
  const { client_id } = req.query;
  let query = supabase.from('reviews').select('*').order('created_at', { ascending: false });
  if (client_id) query = query.eq('client_id', client_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.patch('/api/reviews/:id/responded', async (req, res) => {
  const { data, error } = await supabase.from('reviews')
    .update({ responded: true })
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { client_id } = req.query;
  let q = supabase.from('contacts').select('status');
  if (client_id) q = q.eq('client_id', client_id);
  const { data: contacts } = await q;

  const total = contacts?.length || 0;
  const clicked = contacts?.filter(c => ['clicked_good', 'clicked_bad', 'left_feedback'].includes(c.status)).length || 0;
  const reviewed = contacts?.filter(c => c.status === 'clicked_good').length || 0;

  res.json({ total, clicked, reviewed, conversion: total ? Math.round((reviewed / total) * 100) : 0 });
});

// ── CRON: Follow-up SMS ───────────────────────────────────────────────────────
// Runs every hour — checks for contacts who got SMS 48h ago and haven't clicked
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Checking for follow-up candidates...');
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: candidates } = await supabase
    .from('contacts')
    .select('*, clients(*)')
    .eq('status', 'sms_sent')
    .lt('last_sms_at', cutoff);

  if (!candidates?.length) return console.log('[CRON] No follow-ups needed.');

  for (const contact of candidates) {
    const client = contact.clients;
    if (!client?.active) continue;

    const firstName = contact.name.split(' ')[0];
    const funnelUrl = `${BASE_URL}/funnel/${client.id}?contact=${contact.id}`;
    const message = `Hey ${firstName}, just wanted to check in — did you get a chance to leave us a review? It really does make a difference. Here's the link: ${funnelUrl}`;

    try {
      await sendSMS(contact.phone, message);
      await supabase.from('contacts').update({
        status: 'followup_sent',
        sms_count: 2,
        last_sms_at: new Date().toISOString(),
      }).eq('id', contact.id);
      console.log(`[CRON] Follow-up sent to ${contact.name}`);
    } catch (err) {
      console.error(`[CRON] Failed for ${contact.name}:`, err.message);
    }
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Clearview backend running on port ${PORT}`));
