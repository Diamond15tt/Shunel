/* SHUNEL — AI client. La clave del proveedor nunca se guarda en el navegador. */
export async function askShunelAI(messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new TypeError('Escribe un mensaje para Shunel AI.');
  const safeMessages = messages.slice(-12).map(message => ({
    role: ['user', 'assistant'].includes(message?.role) ? message.role : 'user',
    content: String(message?.content || '').trim().slice(0, 3000)
  })).filter(message => message.content);
  const response = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ messages: safeMessages, context: options.context || null }),
    signal: options.signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Shunel AI no está disponible.');
  return data.reply || '';
}
