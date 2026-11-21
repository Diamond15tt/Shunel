/* Vercel Function — Shunel AI mediante Groq API */
function send(res, status, body) { res.status(status).setHeader('Cache-Control', 'no-store').json(body); }
function cleanMessages(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(-12).map(message => ({
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    content: String(message?.content || '').trim().slice(0, 3000)
  })).filter(message => message.content);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Método no permitido.' });
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return send(res, 503, { error: 'Falta configurar GROQ_API_KEY en Vercel.' });
  const messages = cleanMessages(req.body?.messages);
  if (!messages.length) return send(res, 400, { error: 'Envía al menos un mensaje.' });

  const system = 'Eres Shunel AI, un asistente musical integrado en la aplicación Shunel. Ayudas a descubrir música, hablar de artistas, álbumes y géneros, y organizar la escucha. Responde en español, de forma clara y breve. No inventes datos concretos sobre canciones o artistas cuando no estés seguro. No afirmes que puedes controlar el reproductor si no se te ha dado esa herramienta.';
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: 0.7,
        max_tokens: 700
      })
    });
    const data = await response.json();
    if (!response.ok) return send(res, response.status === 429 ? 429 : 502, { error: data.error?.message || 'El proveedor de IA no respondió.' });
    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) return send(res, 502, { error: 'Shunel AI devolvió una respuesta vacía.' });
    return send(res, 200, { reply: reply.trim() });
  } catch {
    return send(res, 500, { error: 'No se pudo conectar con Shunel AI.' });
  }
};
