import jsQR from "jsqr";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import QRCode from "qrcode";

interface Env {
  BOT_TOKEN: string;
  SITE_URL: string;
  STATE: KVNamespace;
  DEFAULT_LOGO_DATA_URL?: string;
}

type DotStyle = "square" | "round" | "soft";
type Flow = "need_key" | "ready" | "need_name" | "need_amount" | "need_style" | "need_color" | "need_logo";

interface Session {
  authorized: boolean;
  flow: Flow;
  payload?: string;
  name?: string;
  amount?: string;
  dotStyle?: DotStyle;
  qrColor?: string;
  logoDataUrl?: string;
}

interface TelegramMessage {
  chat?: { id: number };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string };
}

interface TelegramUpdate {
  message?: TelegramMessage;
}

const SESSION_TTL = 24 * 60 * 60;
const TUTORIAL_URL = "https://t.me/Auretttee/86";
const WELCOME = `Welcome to QrCustomPh Bot!

Send your QR image and I can customize the design with:
• Name
• Amount
• QR dot style
• QR dot color
• Optional logo

Before customizing, please send your QrCustomPh access key first.

About the Displayed Name When Someone Scans

Personal / Regular QR Code

If the payer uses the same app as your QR (e.g. GCash to GCash), the app may show your original registered name from the payment provider's records — this is normal and cannot be changed by us.

Merchant QR Code

Merchant QRs do not show your personal name to the payer — they show a merchant/business name instead. This is ideal for stores that want a professional look.

Video tutorial:
${TUTORIAL_URL}

Commands:
/start - Start over
/help - Show instructions
/guide - Open the QR customization video
/logo - Add or replace a logo
/skip - Generate without a logo
/cancel - Cancel the current QR`;

const STYLE_HELP = `Choose the QR dot style:
1 - Square
2 - Round
3 - Soft

Reply with 1, 2, or 3.`;

const COLOR_HELP = `Choose the QR dot color.

You can reply with a hex color, for example:
#111827 (black)
#D81B60 (pink)
#2563EB (blue)
#15803D (green)
#7C3AED (purple)

You may also reply with: black, pink, blue, green, purple, orange, or gold.`;

function sessionKey(chatId: number): string {
  return `telegram-session:${chatId}`;
}

async function getSession(env: Env, chatId: number): Promise<Session> {
  return (await env.STATE.get<Session>(sessionKey(chatId), "json")) ?? {
    authorized: false,
    flow: "need_key",
  };
}

async function saveSession(env: Env, chatId: number, session: Session): Promise<void> {
  await env.STATE.put(sessionKey(chatId), JSON.stringify(session), { expirationTtl: SESSION_TTL });
}

async function telegram(env: Env, method: string, body: unknown): Promise<any> {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json<any>();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram ${method} failed`);
  }
  return result.result;
}

async function sendMessage(env: Env, chatId: number, text: string): Promise<void> {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendDocument(env: Env, chatId: number, svg: string, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("document", new Blob([svg], { type: "image/svg+xml" }), "custom-qr.svg");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const result = await response.json<any>();
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram could not send the QR");
}

async function validateSiteKey(env: Env, key: string): Promise<boolean> {
  const siteUrl = env.SITE_URL.replace(/\/+$/, "");
  const response = await fetch(`${siteUrl}/api/auth/validate-access-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key.trim() }),
  });
  return response.ok;
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

async function decodeQrPayload(bytes: Uint8Array): Promise<string | null> {
  let decoded: { data: Uint8Array; width: number; height: number };
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    const png = PNG.sync.read(bytes);
    decoded = { data: png.data, width: png.width, height: png.height };
  } else if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) {
    const jpg = jpeg.decode(bytes, { useTArray: true });
    decoded = { data: jpg.data, width: jpg.width, height: jpg.height };
  } else {
    return null;
  }

  const pixels = new Uint8ClampedArray(decoded.data);
  const result = jsQR(pixels, decoded.width, decoded.height, {
    inversionAttempts: "attemptBoth",
  });
  return result?.data ?? null;
}

async function downloadTelegramFile(env: Env, fileId: string): Promise<Uint8Array> {
  const file = await telegram(env, "getFile", { file_id: fileId }) as { file_path?: string };
  if (!file.file_path) throw new Error("Telegram did not return the image path.");
  const response = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new Error("Could not download the QR image from Telegram.");
  return new Uint8Array(await response.arrayBuffer());
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character] ?? character);
}

function normalizeAmount(value: string): string | null {
  const clean = value.trim().replace(/^₱\s*/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const number = Number(clean);
  if (!Number.isFinite(number) || number < 0 || number > 999999999) return null;
  return number.toFixed(2);
}

function normalizeQrColor(value: string): string | null {
  const presets: Record<string, string> = {
    black: "#111827",
    pink: "#D81B60",
    blue: "#2563EB",
    green: "#15803D",
    purple: "#7C3AED",
    orange: "#C2410C",
    gold: "#B45309",
  };
  const clean = value.trim().toLowerCase();
  const candidate = presets[clean] || clean;
  const withHash = candidate.startsWith("#") ? candidate : `#${candidate}`;
  if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(withHash)) return null;

  const expanded = withHash.length === 4
    ? `#${withHash[1]}${withHash[1]}${withHash[2]}${withHash[2]}${withHash[3]}${withHash[3]}`
    : withHash;
  const red = Number.parseInt(expanded.slice(1, 3), 16);
  const green = Number.parseInt(expanded.slice(3, 5), 16);
  const blue = Number.parseInt(expanded.slice(5, 7), 16);
  const perceivedBrightness = (red * 299 + green * 587 + blue * 114) / 1000;
  if (perceivedBrightness > 220) return null;
  return expanded.toUpperCase();
}

function parseTopLevelTlv(payload: string): { tag: string; length: number; value: string }[] | null {
  const fields: { tag: string; length: number; value: string }[] = [];
  let position = 0;
  while (position + 4 <= payload.length) {
    const tag = payload.slice(position, position + 2);
    const length = Number(payload.slice(position + 2, position + 4));
    if (!/^\d{2}$/.test(tag) || !Number.isInteger(length) || length < 0) return null;
    const start = position + 4;
    const end = start + length;
    if (end > payload.length) return null;
    fields.push({ tag, length, value: payload.slice(start, end) });
    position = end;
  }
  return position === payload.length ? fields : null;
}

function crc16Ccitt(value: string): string {
  let crc = 0xffff;
  for (let index = 0; index < value.length; index += 1) {
    crc ^= value.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Update an existing EMVCo amount field when one is present. If the original
 * QR has no amount field, the amount remains a visual label only; its provider
 * payload is never guessed or rewritten.
 */
function patchEmvAmount(payload: string, amount: string): string {
  const crcPosition = payload.lastIndexOf("6304");
  if (crcPosition < 0) return payload;
  const withoutCrc = payload.slice(0, crcPosition);
  const fields = parseTopLevelTlv(withoutCrc);
  if (!fields || !fields.some((field) => field.tag === "54")) return payload;

  const next = fields.map((field) => field.tag === "54"
    ? { ...field, value: amount, length: amount.length }
    : field);
  const body = next.map((field) => `${field.tag}${String(field.length).padStart(2, "0")}${field.value}`).join("");
  return `${body}6304${crc16Ccitt(`${body}6304`)}`;
}

function isFinderModule(row: number, column: number, size: number): boolean {
  return (row < 7 && column < 7)
    || (row < 7 && column >= size - 7)
    || (row >= size - 7 && column < 7);
}

function renderModules(
  qr: any,
  dotStyle: DotStyle,
  x: number,
  y: number,
  qrSize: number,
  color: string,
): string {
  const count = Number(qr.modules.size);
  const margin = 4;
  const cell = qrSize / (count + margin * 2);
  const getModule = (row: number, column: number): boolean => Boolean(qr.modules.get(row, column));
  const pieces: string[] = [];

  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!getModule(row, column)) continue;
      const px = x + (margin + column) * cell;
      const py = y + (margin + row) * cell;
      const finder = isFinderModule(row, column, count);
      if (finder || dotStyle === "square") {
        pieces.push(`<rect x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="${color}"/>`);
      } else {
        const radius = dotStyle === "round" ? cell / 2 : cell * 0.28;
        const inset = dotStyle === "round" ? 0 : cell * 0.08;
        pieces.push(`<rect x="${(px + inset).toFixed(2)}" y="${(py + inset).toFixed(2)}" width="${(cell - inset * 2).toFixed(2)}" height="${(cell - inset * 2).toFixed(2)}" rx="${radius.toFixed(2)}" fill="${color}"/>`);
      }
    }
  }
  return pieces.join("");
}

function renderQrSvg(
  payload: string,
  name: string,
  amount: string,
  dotStyle: DotStyle,
  qrColor: string,
  logoDataUrl?: string,
): string {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "H" });
  const width = 1080;
  const height = 1350;
  const qrX = 110;
  const qrY = 215;
  const qrSize = 860;
  const safeName = escapeXml(name);
  const amountLabel = amount ? `₱${amount}` : "Amount not set";
  const safeAmount = escapeXml(amountLabel);
  const logo = logoDataUrl
    ? `<circle cx="540" cy="645" r="82" fill="white"/><image href="${logoDataUrl}" x="475" y="580" width="130" height="130" preserveAspectRatio="xMidYMid meet"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="48" fill="#fdf2f8"/>
  <rect x="36" y="36" width="${width - 72}" height="${height - 72}" rx="36" fill="white" stroke="#f9a8d4" stroke-width="4"/>
  <text x="540" y="130" text-anchor="middle" font-family="Arial, sans-serif" font-size="52" font-weight="700" fill="#9d174d">${safeName}</text>
  <rect x="80" y="180" width="920" height="920" rx="38" fill="white" stroke="#fbcfe8" stroke-width="5"/>
  ${renderModules(qr, dotStyle, qrX, qrY, qrSize, qrColor)}
  ${logo}
  <text x="540" y="1190" text-anchor="middle" font-family="Arial, sans-serif" font-size="64" font-weight="800" fill="#111827">${safeAmount}</text>
   <text x="540" y="1260" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="${qrColor}">Generated by QrCustomPh</text>
</svg>`;
}

async function processQrImage(env: Env, chatId: number, imageFileId: string, session: Session): Promise<void> {
  try {
    const bytes = await downloadTelegramFile(env, imageFileId);
    const payload = await decodeQrPayload(bytes);
    if (!payload) {
      await sendMessage(env, chatId, "Hindi ko mabasa ang QR image. Mag-send ng malinaw na JPG/PNG na kita ang buong QR code, o gamitin ang QR-only image.");
      return;
    }
    await saveSession(env, chatId, { ...session, payload, flow: "need_name" });
    await sendMessage(env, chatId, "Nabasa ko ang QR. Anong name ang ilalagay sa design?");
  } catch (error) {
    console.error("QR image processing failed", error);
    await sendMessage(env, chatId, "Hindi ko ma-process ang image ngayon. Siguraduhing JPG/PNG ito at subukan ulit.");
  }
}

async function finishQr(env: Env, chatId: number, session: Session): Promise<void> {
  if (!session.payload || !session.name || session.amount === undefined || !session.dotStyle || !session.qrColor) {
    await sendMessage(env, chatId, "Kulang ang details. Gamitin ang /start para ulitin.");
    return;
  }
  const payload = session.amount ? patchEmvAmount(session.payload, session.amount) : session.payload;
  const svg = renderQrSvg(
    payload,
    session.name,
    session.amount,
    session.dotStyle,
    session.qrColor,
    session.logoDataUrl || env.DEFAULT_LOGO_DATA_URL,
  );
  await sendDocument(
    env,
    chatId,
    svg,
    `✅ Custom QR ready!\nName: ${session.name}\nAmount: ${session.amount ? `₱${session.amount}` : "not set"}\nDots: ${session.dotStyle}\nColor: ${session.qrColor}\n\nThe amount is updated in the QR payload only when the original QR already has an EMV amount field. Otherwise, it is a design label only.`,
  );
  await saveSession(env, chatId, { ...session, flow: "ready" });
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat?.id;
  if (!chatId) return;
  const text = (message.text || message.caption || "").trim();
  let session = await getSession(env, chatId);

  if (text === "/start") {
    session = { authorized: false, flow: "need_key" };
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, WELCOME);
    return;
  }
  if (text === "/help") {
    await sendMessage(env, chatId, WELCOME);
    return;
  }
  if (text === "/guide") {
    await sendMessage(env, chatId, `QR customization video tutorial:\n${TUTORIAL_URL}`);
    return;
  }
  if (text === "/cancel") {
    session = {
      ...session,
      flow: session.authorized ? "ready" : "need_key",
      payload: undefined,
      name: undefined,
      amount: undefined,
      dotStyle: undefined,
      qrColor: undefined,
      logoDataUrl: undefined,
    };
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, session.authorized ? "Cancelled. Send a new QR image when ready." : "Cancelled. Send your site access key to continue.");
    return;
  }
  if (text === "/logo") {
    if (!session.authorized) {
      await sendMessage(env, chatId, "Kailangan muna ang QrCustomPh access key bago mag-customize.");
      return;
    }
    session.flow = "need_logo";
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, "Send your logo image now. JPG or PNG is best. Use /skip for no logo.");
    return;
  }
  if (text === "/skip" && session.flow === "need_logo") {
    session.logoDataUrl = undefined;
    session.flow = "ready";
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, "No logo selected. Send a QR image to start.");
    return;
  }

  if (!session.authorized) {
    if (!text || text.startsWith("/")) {
      await sendMessage(env, chatId, "Send your QrCustomPh site access key first.");
      return;
    }
    const valid = await validateSiteKey(env, text);
    if (!valid) {
      await sendMessage(env, chatId, "Hindi valid ang key. Kunin ang access key sa QrCustomPh site at subukan ulit.");
      return;
    }
    session = { authorized: true, flow: "ready" };
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, "✅ Key accepted. Send your QR image to begin.");
    return;
  }

  if (session.flow === "need_logo" && (message.photo?.length || message.document?.file_id)) {
    const fileId = message.photo?.at(-1)?.file_id || message.document?.file_id;
    if (!fileId) return;
    try {
      const bytes = await downloadTelegramFile(env, fileId);
      const contentType = message.document?.mime_type || "image/jpeg";
      const logoDataUrl = `data:${contentType};base64,${bytesToBase64(bytes)}`;
      session.logoDataUrl = logoDataUrl;
      session.flow = "ready";
      await saveSession(env, chatId, session);
      await sendMessage(env, chatId, "✅ Logo saved. Send your QR image to begin.");
    } catch {
      await sendMessage(env, chatId, "Hindi ko ma-save ang logo. Mag-send ng JPG/PNG logo ulit.");
    }
    return;
  }

  if (message.photo?.length || message.document?.file_id) {
    const fileId = message.photo?.at(-1)?.file_id || message.document?.file_id;
    if (fileId) await processQrImage(env, chatId, fileId, session);
    return;
  }

  if (session.flow === "need_name") {
    if (!text || text.startsWith("/")) {
      await sendMessage(env, chatId, "Send a name for the design, for example: Aurette Store.");
      return;
    }
    session.name = text.slice(0, 80);
    session.flow = "need_amount";
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, "Anong amount? Halimbawa: 100 or 100.00. Reply /skip kung amount label lang ang gusto mo.");
    return;
  }

  if (session.flow === "need_amount") {
    const amount = text === "/skip" ? "" : normalizeAmount(text);
    if (amount === null) {
      await sendMessage(env, chatId, "Invalid amount. Gumamit ng number tulad ng 100 or 100.00, o /skip.");
      return;
    }
    session.amount = amount;
    session.flow = "need_style";
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, STYLE_HELP);
    return;
  }

  if (session.flow === "need_style") {
    const styles: Record<string, DotStyle> = { "1": "square", "2": "round", "3": "soft", square: "square", round: "round", soft: "soft" };
    const dotStyle = styles[text.toLowerCase()];
    if (!dotStyle) {
      await sendMessage(env, chatId, STYLE_HELP);
      return;
    }
    session.dotStyle = dotStyle;
    session.flow = "need_color";
    await saveSession(env, chatId, session);
    await sendMessage(env, chatId, COLOR_HELP);
    return;
  }

  if (session.flow === "need_color") {
    const qrColor = normalizeQrColor(text);
    if (!qrColor) {
      await sendMessage(env, chatId, "Invalid or too-light color. Use a dark hex color like #D81B60, or reply with pink, blue, green, purple, orange, gold, or black.");
      return;
    }
    session.qrColor = qrColor;
    await saveSession(env, chatId, session);
    await finishQr(env, chatId, session);
    return;
  }

  await sendMessage(env, chatId, "Send a QR image to begin, or use /logo to add a logo.");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "qr-pinoy-telegram-bot" });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json<TelegramUpdate>();
        if (update.message) ctx.waitUntil(handleMessage(env, update.message));
      } catch (error) {
        console.error("Webhook update failed", error);
      }
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/set-webhook") {
      const auth = request.headers.get("Authorization");
      if (!auth || auth !== `Bearer ${env.BOT_TOKEN}`) return new Response("Unauthorized", { status: 401 });
      const webhookUrl = `${url.origin}/webhook`;
      const result = await telegram(env, "setWebhook", { url: webhookUrl });
      return Response.json({ ok: true, webhookUrl, telegram: result });
    }

    return new Response("Not found", { status: 404 });
  },
};