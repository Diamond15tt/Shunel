const ENDPOINT = "/api/ai";
const TIMEOUT_MS = 30000;

export async function askShunelAIFull(messages, { context, signal } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("Sin conexión. Revisa tu internet.");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true;
    controller.abort(); }, TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ messages, context }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "Shunel AI no está disponible.");
    const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
    if (!reply) throw new Error("Shunel AI devolvió una respuesta vacía.");
    return {
      reply,
      actions: Array.isArray(data.actions) ? data.actions : [],
      suggestions: Array.isArray(data.suggestions) ? data.suggestions : []
    };
  } catch (error) {
    if (timedOut) throw new Error("Shunel AI tardó demasiado. Inténtalo de nuevo.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function askShunelAI(messages, options) {
  return (await askShunelAIFull(messages, options)).reply;
}