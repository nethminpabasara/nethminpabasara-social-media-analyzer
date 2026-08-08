// api/analyze.js
// Simple in-memory rate limiter (resets on cold start - fine for MVP).
// For real production scale, swap this for Vercel KV / Upstash Redis.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // per IP per minute

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

export default async function handler(req, res) {
  // 1. Enable CORS for Chrome Extension requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. Basic rate limiting so one client can't burn your daily Gemini quota
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null)
    || req.socket?.remoteAddress
    || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  try {
    const { handle, bio, recentCaptions } = req.body || {};

    // 3. Validate input before spending an AI call on it
    if (!handle || typeof handle !== 'string' || handle.length > 100) {
      return res.status(400).json({ error: 'Missing or invalid "handle" field.' });
    }
    if (bio && typeof bio !== 'string') {
      return res.status(400).json({ error: 'Invalid "bio" field.' });
    }
    if (recentCaptions && !Array.isArray(recentCaptions)) {
      return res.status(400).json({ error: 'Invalid "recentCaptions" field.' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    // Use the SERVICE ROLE key here (not anon key) so this server-side
    // function can write rows even though the public anon key is locked
    // to read-only by Row Level Security. See supabase_setup.sql.
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Missing environment variables in Vercel.' });
    }

    const safeBio = (bio || 'No bio provided').slice(0, 500);
    const safeCaptions = (recentCaptions || []).slice(0, 10).map(c => String(c).slice(0, 300));

    const prompt = `You are a world-class social media strategist. Analyze this Instagram profile.

Handle: @${handle}
Bio: ${safeBio}
Recent Post Captions: ${JSON.stringify(safeCaptions)}

IMPORTANT CONTEXT: You were only given the bio and caption text - no like counts, timestamps, follower counts, or engagement metrics were provided. Do NOT claim to know which specific posts "performed best" or invent specific engagement numbers. Base your analysis on writing style, content themes, bio quality, and general best practices for this niche. Frame posting-time/frequency advice as general industry best practice, not personalized data analysis.

Evaluate the account and output strictly valid JSON with this exact structure, no markdown fences, no extra text:
{
  "overall_score": 75,
  "content_score": 80,
  "profile_score": 70,
  "engagement_score": 75,
  "branding_score": 70,
  "strategy_score": 80,
  "main_problem": "One sentence summary of biggest issue",
  "priority_fix": "One actionable step to fix it immediately",
  "content_ideas": [
    "Idea 1 description",
    "Idea 2 description",
    "Idea 3 description"
  ]
}`;

    // 4. Call Gemini API
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );

    const geminiData = await geminiRes.json();

    if (geminiData.error) {
      return res.status(500).json({ error: `Gemini API Error: ${geminiData.error.message}` });
    }

    if (!geminiData.candidates || !geminiData.candidates[0]?.content?.parts?.[0]?.text) {
      return res.status(500).json({ error: 'Gemini returned an empty or unparseable response.' });
    }

    const rawAiText = geminiData.candidates[0].content.parts[0].text;
    const cleanJsonText = rawAiText.replace(/```json/g, '').replace(/```/g, '').trim();

    let aiReport;
    try {
      aiReport = JSON.parse(cleanJsonText);
    } catch {
      return res.status(500).json({ error: 'Gemini returned malformed JSON.' });
    }

    // 5. Basic shape check on the AI's output before trusting it downstream
    const requiredNumericFields = ['overall_score', 'content_score', 'profile_score', 'engagement_score', 'branding_score', 'strategy_score'];
    for (const field of requiredNumericFields) {
      if (typeof aiReport[field] !== 'number') {
        return res.status(500).json({ error: `Gemini response missing or invalid field: ${field}` });
      }
    }

    // 6. Save report into Supabase
    const supabaseRes = await fetch(`${SUPABASE_URL}/rest/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        social_handle: handle,
        platform: 'instagram',
        overall_score: aiReport.overall_score,
        content_score: aiReport.content_score,
        profile_score: aiReport.profile_score,
        engagement_score: aiReport.engagement_score,
        branding_score: aiReport.branding_score,
        strategy_score: aiReport.strategy_score,
        ai_analysis: aiReport
      })
    });

    const savedData = await supabaseRes.json();

    if (!supabaseRes.ok) {
      return res.status(500).json({ error: `Database Error: ${savedData.message || JSON.stringify(savedData)}` });
    }

    return res.status(200).json({
      success: true,
      data: Array.isArray(savedData) ? savedData[0] : savedData
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}