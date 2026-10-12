# Claude Console

A self-hosted team chat for Claude through an Anthropic-format API (Tokenhot by default), with an admin panel and a staff panel.

## Quick start

You need **Node.js 22.13 or newer** (check with `node --version`; get it from nodejs.org).

```bash
cd claude-console
npm install
npm start
```

Open **http://localhost:3000**. On the first visit you create the admin account. Then:

1. **Admin › API keys:** add one or more Tokenhot keys, then press **Test** on each one.
2. **Admin › Models:** make sure the model IDs match the names Tokenhot uses, and set the prices to Tokenhot's rates so cost tracking is right.
3. **Admin › Staff:** create accounts for your team and set their limits.

On Windows, double-click `start.bat` instead of typing the commands.

## What's included

**Staff panel (`/chat`)**
- Streaming chat with a model switcher, limited to the models the admin allows.
- File uploads: images, PDFs, and text or code files, by button, drag-and-drop, or paste.
- Extended thinking toggle with a budget slider.
- Web search toggle, with sources shown under replies.
- A system prompt for each chat.
- Chat history with search, rename, and delete.
- Edit and resend, regenerate, stop, and copy.
- Artifacts: HTML, SVG, and React code opens in a sandboxed live preview with copy and download.
- Token count and cost on every reply, plus a running total for each chat.
- **⚡ Template button:** personal templates plus templates shared by the admin. `{{blanks}}` are filled in a form, and the finished prompt goes into the message box for editing.
- A personal usage page with limit meters.

**Admin panel (`/admin`)**
- **Overview:** today's and this month's spend, active staff, and key health.
- **Staff:** create, edit, disable, or delete accounts, and reset passwords. Usage limits can be counted in cost, tokens, or both, per day and per month. You also choose which models each person can use, and whether they can use web search and thinking.
- **API keys:** add, edit, test, enable or disable keys, and drag to set their order. If a key hits a rate limit (429), an overload error (529), runs out of credit, is invalid, or the gateway fails, the next key takes over automatically. The failed key then cools down before it's retried.
- **Models:** model IDs, prices, max output tokens, and which models are enabled.
- **Usage reports:** costs by person, model, key, and day for any date range, with CSV export.
- **Chat review:** read any staff conversation, filtered by person or search text.
- **Shared templates** and **Settings:** the endpoint, the `anthropic-version` header, the cooldown time, the web search price, the sign-in notice, and the default system prompt.

## How the API is called

All requests go from the **server** to `https://api.tokenhot.ai/v1/messages`, matching Tokenhot's documented format:

```
x-api-key: <your key>
Authorization: Bearer <your key>
anthropic-version: 2023-06-01
Content-Type: application/json
```

By default both auth headers are sent. In **Admin › Settings › How keys are sent**, you can switch to `x-api-key` only (Tokenhot's documented style) or `Authorization: Bearer` only.

**Two API formats.** Each model in Admin › Models has an API format:

- **Anthropic Messages:** `/v1/messages`, the headers above. Used for Claude, and supports thinking and web search.
- **OpenAI Chat Completions:** `https://api.tokenhot.ai/v1/chat/completions`, always sent with `Authorization: Bearer <key>`. Used for GPT-4o, Gemini, DeepSeek and other models. Images and PDFs are converted automatically. Reasoning text is shown when the provider streams it. Web search and the thinking budget don't apply.

**Load models from provider** (in Admin › Models) lists every model your key can use and picks the format for each one. If a Claude model returns "no available channel" on the Anthropic format, switch it to OpenAI format and try again.

Tokenhot uses **dotted model IDs** such as `claude-sonnet-4.6`. The app starts with `claude-sonnet-4.6` plus dotted guesses for the newer models. Check Tokenhot's model list and fix or remove any IDs it doesn't accept in Admin › Models.

Keys are encrypted (AES-256-GCM) in the database and never reach the browser, so staff can't see or copy them. You can change the default endpoint in Settings, or give one key its own endpoint. For example, you can point an official Anthropic key at `https://api.anthropic.com/v1/messages` and mix it with Tokenhot keys.

If Tokenhot doesn't support a feature (web search, thinking, or PDFs), the chat shows its error message. Turn that feature off for staff in their account settings.

## Your data

Everything lives in the `data/` folder:
- `console.db` holds users, chats, usage, and encrypted keys.
- `secret.key` is the encryption key for your API keys. **Back it up together with the database.** Without it, saved API keys can't be decrypted and must be re-entered.

Alternatively, set the environment variable `APP_SECRET` to a long random string and the server uses that instead of `secret.key`.

## Deploying on Railway

The project includes a `Dockerfile` and `railway.json`, so Railway builds it without extra setup. Railway serves it over HTTPS automatically.

1. Create a project in Railway and deploy this folder, either from a GitHub repo or with the Railway CLI (`railway up`).
2. **Add a volume** to the service, mounted at `/data`. Without it, all data is wiped on every deploy. The app finds the volume automatically.
3. **Set these variables** on the service:
   - `ADMIN_USERNAME`: your admin login
   - `ADMIN_PASSWORD`: at least 10 characters
   - `APP_SECRET`: a long random string, used to encrypt API keys. Keep a copy somewhere safe.
4. Under Settings › Networking, click **Generate Domain**, then open the URL and sign in.

Keep the service at **1 replica**, since SQLite doesn't support several copies writing at once. The browser setup page is disabled on Railway for safety; the admin account comes from the variables above. If you prefer the setup page, set `SETUP_TOKEN` instead and enter it on the page.

## Letting staff connect from other computers

By default the server only listens on this computer (`127.0.0.1`). To share it on your office network:

```bash
HOST=0.0.0.0 PORT=3000 npm start          # macOS / Linux
set HOST=0.0.0.0 && npm start             # Windows (cmd)
```

Staff then open `http://<this-computer's-IP>:3000`.

**Over the internet:** put it behind HTTPS. A reverse proxy like Caddy or Nginx works, or a tunnel such as Cloudflare Tunnel. Set `TRUST_PROXY=1` when running behind a proxy. Don't expose plain HTTP to the internet, because passwords and chats would travel unencrypted.

To keep it running in the background on a server, use a process manager such as `pm2`:

```bash
npm install -g pm2
pm2 start npm --name claude-console -- start
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | `0.0.0.0` to accept network connections |
| `DATA_DIR` | `./data` | Where the database and secret live |
| `APP_SECRET` | (file) | Encryption secret instead of `data/secret.key` |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy (automatic on Railway) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | Create the first admin on startup |
| `SETUP_TOKEN` | — | Require this token on the browser setup page |

## Notes

- Costs are estimates based on the prices set in Admin › Models, plus the web search price.
- Artifact previews run in a sandboxed frame with no access to your session. React previews load React, Babel, and Tailwind from public CDNs, so they need internet access.
- Forgotten admin password: if another admin exists, they can reset it. Otherwise, stop the server, delete `data/console.db`, and start again. **This erases all data**, so keep backups.
