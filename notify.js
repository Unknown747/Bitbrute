export async function notifyTelegram(config, text) {
  const t = config.telegram;
  if (!t.enabled || !t.botToken || !t.chatId) return;
  const url = `https://api.telegram.org/bot${t.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: t.chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(
        `[telegram] notify HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.log(`[telegram] notify failed: ${e.message}`);
  }
}

export function shouldNotify(config, kind) {
  const t = config.telegram;
  if (!t.enabled) return false;
  if (kind === "found") return !!t.notifyOnFound;
  if (kind === "vanity") return !!t.notifyOnVanity;
  if (kind === "bloomMatch") return !!t.notifyOnBloomMatch;
  return false;
}
