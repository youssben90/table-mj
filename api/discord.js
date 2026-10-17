// GM Table — reads the latest messages of the Discord channel chosen in the admin view.
// Runs on Vercel. The bot token lives ONLY in Vercel's environment variables (DISCORD_BOT_TOKEN).
//
// Access check:
//   - players call  /api/discord?code=<player code>   → checked by the Supabase function lire_table
//   - the GM calls   /api/discord with "Authorization: Bearer <Supabase session token>"

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uvnnszxvvrxdfhrshfxw.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bm5zenh2dnJ4ZGZocnNoZnh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwMDMzMTYsImV4cCI6MjEwNzU3OTMxNn0.KGZd72nlM4Sskc2T5b0kR7W40-VT3jYZJ-pAf-T1qYc';

const channelNames = new Map(); // small in-memory cache: channel id → name

async function readPublicState(req) {
  const code = (req.query && req.query.code) || '';
  const auth = req.headers.authorization || '';
  if (code) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/lire_table`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!r.ok) return null;
    return await r.json(); // null when the code is wrong
  }
  if (auth.startsWith('Bearer ')) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/etat?id=eq.public&select=data`, {
      headers: { apikey: SUPABASE_ANON, Authorization: auth }
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows[0] ? rows[0].data : null; // empty unless signed in as the GM
  }
  return null;
}

function avatarUrl(u) {
  if (!u) return '';
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`;
  const idx = Number((BigInt(u.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function slimEmbed(e) {
  return {
    title: e.title || '',
    description: e.description || '',
    color: typeof e.color === 'number' ? '#' + e.color.toString(16).padStart(6, '0') : '',
    author: e.author ? e.author.name || '' : '',
    footer: e.footer ? e.footer.text || '' : '',
    thumbnail: e.thumbnail ? e.thumbnail.proxy_url || e.thumbnail.url || '' : '',
    image: e.image ? e.image.proxy_url || e.image.url || '' : '',
    fields: (e.fields || []).map(f => ({ name: f.name || '', value: f.value || '', inline: !!f.inline }))
  };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (status, body, cache) => {
    res.setHeader('Cache-Control', cache || 'no-store');
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return send(500, { error: 'no_token', message: 'The bot token is not set in Vercel yet.' });

  let state;
  try { state = await readPublicState(req); } catch (e) { state = null; }
  if (!state) return send(403, { error: 'forbidden', message: 'Access denied.' });

  const channel = state.discord && state.discord.channel;
  if (!channel) return send(200, { channel: null, messages: [] }, 'public, s-maxage=1');

  const headers = { Authorization: `Bot ${token}` };
  const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages?limit=40`, { headers });
  if (!r.ok) {
    const map = {
      401: ['bad_token', 'The bot token is wrong. Reset it in Discord and update it in Vercel.'],
      403: ['no_access', "The bot can't read this channel. Check its permissions on the channel."],
      404: ['unknown_channel', "This channel doesn't exist or the bot isn't on that server."],
      429: ['rate_limited', 'Discord asked to slow down. Retrying shortly.']
    };
    const [error, message] = map[r.status] || ['discord_error', `Discord error ${r.status}.`];
    return send(r.status === 429 ? 200 : 502, { error, message }, 'public, s-maxage=2');
  }
  const raw = await r.json();

  let name = channelNames.get(channel);
  if (!name) {
    try {
      const c = await fetch(`https://discord.com/api/v10/channels/${channel}`, { headers });
      if (c.ok) { name = (await c.json()).name || ''; channelNames.set(channel, name); }
    } catch (e) { /* name is optional */ }
  }

  const messages = raw.reverse().map(m => ({
    id: m.id,
    at: m.timestamp,
    author: (m.author && (m.author.global_name || m.author.username)) || 'Unknown',
    bot: !!(m.author && m.author.bot),
    avatar: avatarUrl(m.author),
    content: m.content || '',
    mentions: (m.mentions || []).map(u => ({ id: u.id, name: u.global_name || u.username })),
    embeds: (m.embeds || []).filter(e => e.type === 'rich' || e.title || e.description || (e.fields || []).length).map(slimEmbed),
    images: (m.attachments || []).filter(a => (a.content_type || '').startsWith('image/')).map(a => a.proxy_url || a.url)
  }));

  // Shared by every player for a few seconds: keeps Discord happy whatever the number of players.
  send(200, { channel: name || null, messages }, 'public, s-maxage=1, stale-while-revalidate=2');
};
