# QrCustomPh Telegram QR Bot

Standalone Cloudflare Worker bot for QrCustomPh.

The deployable Worker source is `src/index.ts`. This folder is intentionally
separate from the website so it can be deployed to Cloudflare Workers.

It requires a QrCustomPh site access key before allowing QR customization. The bot accepts a JPG/PNG QR image, decodes the payload, then creates a clean vector QR with:

- custom display name
- amount label
- square, round, or soft QR dots
- custom QR dot color using hex codes or presets
- optional logo image
- EMV amount replacement when the original payload already contains an amount field

The bot sends an SVG document because SVG stays sharp when printed. The original provider-registered name is never rewritten. A personal QR may still display the provider's registered name when scanned; a merchant QR displays its merchant/business name according to the payment provider.

## 1. Create the Worker and KV namespace

From this folder:

```bash
npm install
npx wrangler kv namespace create STATE
```

Copy the returned KV namespace ID into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "the-id-returned-by-wrangler"
```

Set the public site URL in the `[vars]` section. It must be the public HTTPS URL
users open for QrCustomPh, without a trailing slash. Do not use a local URL.

## 2. Add the Telegram bot token

Create a bot with BotFather, then store the token as a Cloudflare secret. Do not paste the token into source code or chat:

```bash
npx wrangler secret put BOT_TOKEN
```

When Wrangler asks for the value, paste the token directly into the secure
terminal prompt. It will not be written to `src/index.ts` or `wrangler.toml`.

## 3. Deploy and connect Telegram

```bash
npx wrangler deploy
```

After deployment, connect the webhook. Replace `YOUR-WORKER-DOMAIN` with the domain printed by Wrangler:

```bash
export BOT_TOKEN='paste-your-token-here-only-in-this-terminal'
curl -X POST \
  -H "Authorization: Bearer $BOT_TOKEN" \
  https://YOUR-WORKER-DOMAIN/set-webhook
```

For PowerShell, use:

```powershell
curl.exe -X POST `
  -H "Authorization: Bearer $env:BOT_TOKEN" `
  https://YOUR-WORKER-DOMAIN/set-webhook
```

You can also call `/set-webhook` from the Cloudflare dashboard. The Worker
automatically registers the webhook at its own `/webhook` endpoint.

## Bot flow

1. `/start`
2. Send the access key generated on the QrCustomPh site
3. Send the QR image
4. Send the display name
5. Send the amount, or `/skip`
6. Choose `1`, `2`, or `3` for the dot style
7. Send a hex color such as `#D81B60`, or use a preset like `pink`, `blue`, `green`, `purple`, `orange`, `gold`, or `black`
8. Send a logo first with `/logo`, or generate without one using `/skip`

Use `/guide` anytime to receive the website customization video:
https://t.me/Auretttee/86

The amount is changed inside the EMV payload only when an existing amount field is present. For other QR formats, the amount is shown as a design label and the encoded provider payload is kept untouched.

## Important limitations

- Telegram photo uploads are normally JPEG; PNG documents are also supported.
- WebP and PDF uploads are rejected. Send a clear JPG/PNG QR image instead.
- The Worker does not alter a payment provider's registered personal name.
- Keep the Worker and QrCustomPh site on HTTPS.