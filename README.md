# Back to Center

Back to Center is a small conversation app for sorting through worries, decisions, frustrations, and overloaded thoughts. It keeps chat history in the browser and sends AI requests through a local Node server to DeepInfra. When DeepInfra cannot respond, a simpler rule-based responder is used. This is a thinking companion, not a therapist or emergency service.

The browser workspace includes searchable, renameable, pinnable, and duplicable chats, a pinned-only history filter, local chat deep-links and copyable local links, automatic recovery of an unfinished draft, reversible deletion from both history and the open chat, local conversation stats, adjustable text size, optional timestamp visibility, JSON backup, Markdown export, native sharing when supported, keyboard shortcuts, an on-demand connection check, an optional install-app prompt, a distraction-free focus mode with countdown and stopwatch timers, an optional night theme, message editing, one-click reply copying, reply regeneration, quoted follow-up context, guided follow-up prompts, local read-aloud support, an optional saved takeaway per chat, a private local-only note per chat, and an installable cached shell. DeepInfra is used for normal replies; when it is unavailable, unconfigured, or the local server cannot be reached, the built-in responder activates automatically and is clearly labeled. Shared and Markdown-exported content intentionally excludes private notes.

Chats remain browser-local by default. After meaningful use, the app may offer an optional account prompt. Hosted accounts use Supabase Auth and HttpOnly access-token cookies; users can explicitly save selected chats to that account. No chat is uploaded during signup automatically. The local fallback account store is intended for local or small deployments and does not include email verification, password recovery, multi-factor authentication, or distributed sessions.

## Requirements and setup

- Node.js 20.6 or newer (built-in `fetch` and `--env-file` are used). No npm packages are required.
- A DeepInfra account and API key for AI replies. Create a key in your DeepInfra account. The [default model](https://deepinfra.com/meta-llama/Llama-3.3-70B-Instruct-Turbo/api) is `meta-llama/Llama-3.3-70B-Instruct-Turbo`; change it with `DEEPINFRA_MODEL` if needed.
- A current browser. The server listens on `127.0.0.1` only.

Open the ignored `.env` file in this directory and paste your key after `DEEPINFRA_API_KEY=`. The model and timeout are already set. This machine currently has another Node process on port 8080, so `.env` uses port 8081; change `PORT` to 8080 if that port becomes free. Then, in Windows PowerShell:

```powershell
cd C:\Users\ssanj\Desktop\un-brain
npm start
```

Open the URL printed by the server, currently <http://localhost:8081>. Press `Ctrl+C` in the server terminal to stop it. `npm start` loads `.env` with Node's native flag, so no loader package is needed. Environment variables already set in PowerShell take precedence over values in `.env`. If you leave the key blank, the app starts normally and automatically uses clearly labeled local fallback replies.

The server does not require Ollama. If the configured port is occupied, change `PORT` in `.env` and restart the app.

## Deploy to Vercel

The hosted version uses the Vercel Node functions in `api/chat.js` and `api/health.js`. Browser chat history remains local to each browser, while DeepInfra requests run through the server-side function so the API key is never sent to the browser.

Hosted accounts use Supabase. Configure `SUPABASE_URL` (the project URL, not the dashboard URL), `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `PUBLIC_APP_URL` (the deployed origin) in Vercel, then run `supabase-schema.sql` once in the Supabase SQL editor. Signup uses email, username, password, and confirmation; login uses email and password; the account dialog also supports password-reset links. Anonymous chats remain browser-local until a user explicitly saves one to their account.

To deploy from GitHub:

1. Push this project to `https://github.com/SanjeevRam2006/declutter` (or import the repository in Vercel).
2. In Vercel, choose **Add New → Project**, select the repository, and deploy with the default settings.
3. Add these environment variables for Preview and Production:

   - `DEEPINFRA_API_KEY` — your secret DeepInfra key.
   - `DEEPINFRA_MODEL` — for example `meta-llama/Llama-3.3-70B-Instruct-Turbo`.
   - `AI_TIMEOUT_MS` — for example `30000`.
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` — the Supabase project URL and API keys.
   - `PUBLIC_APP_URL` — the exact deployed origin, for example `https://declutter-fawn.vercel.app`.

4. Redeploy after saving the variables and open the generated `.vercel.app` URL.

In Supabase Authentication URL Configuration, set the Site URL to the same `PUBLIC_APP_URL` and add its wildcard origin (for example `https://declutter-fawn.vercel.app/**`) as an allowed redirect URL. Password reset and email confirmation links use this origin.

Do not commit `.env`, `data/users.json`, or API keys. Vercel deployments do not need `npm start`; the platform discovers the `api/` functions and serves the static files directly.

For local development without Supabase variables, the legacy file-backed account store remains available. It is not suitable for production because Vercel functions do not provide durable filesystem storage.

## Tests

Run the free, mocked suite with:

```powershell
npm test
```

This checks the existing responder, HTTP validation, DeepInfra success and failure cases, safety handling, static file access, and browser chat state with a small DOM harness. It never calls DeepInfra.

On Windows with Chrome installed, an optional real-browser smoke test starts its own local server, exercises automatic fallback replies, and checks layout plus chat persistence:

```powershell
npm run test:browser
```

Set `CHROME_PATH` if Chrome is installed elsewhere. This test does not need an API key or call DeepInfra.

The browser smoke test also checks that Focus Mode can run a stopwatch, survive switching back to chat, and reset cleanly. Focus timer state is kept locally in `back_to_center_focus_timer_v1`; a running timer is reconstructed from its saved timestamp after a refresh.

An optional **paid live smoke test** can be run after setting a real key and starting the server:

```powershell
$body = @{ messages = @(@{ role = "user"; content = "I am putting off a report due tomorrow." }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://localhost:8081/api/chat" -Method Post -ContentType "application/json" -Body $body
```

Check that `source` is `deepinfra`; `fallback` means the provider could not answer. The live test sends that message to DeepInfra and may incur a charge. Do not paste API keys into browser code, this request body, or the repository.

## Privacy and limits

Conversation history is saved in this browser's local storage. It is not encrypted, and anyone with access to the browser profile may be able to read it. Clearing site data may remove chats. Deleting a chat removes it from this app's local history; it cannot erase messages already sent to DeepInfra. AI requests send a bounded part of the conversation to DeepInfra for processing. The API key remains on the Node server. The page loads no external fonts or scripts, and the server does not log chat content or keys.

Exported JSON backups contain the conversation text and should be treated like the chats themselves. Importing a backup creates new local copies; it does not upload the file to the server.

The server accepts at most 24 messages per request, 4,000 characters per message, and 256 KiB per request. It sends at most 24,000 characters of recent conversation context to the model. The browser keeps full local history. The timeout defaults to 30 seconds and can be set from 1 to 120 seconds with `AI_TIMEOUT_MS`.

The rule-based safety check catches some explicit statements of current self-harm or imminent danger and replies before calling DeepInfra. It cannot reliably understand every phrasing or context and is not a guarantee of safety. India and US contacts appear only when a user explicitly states that location; otherwise the app gives location-neutral guidance. The India contacts are [112](https://112.gov.in/) and [Tele-MANAS 14416](https://www.dghs.mohfw.gov.in/national-mental-health-programme.php); the US contacts are [911](https://www.911.gov/calling-911/) and [988](https://988lifeline.org/contact-us/).

The app also has a narrow conversational guardrail for clear self-reports and corrections. If you say you are fine, happy, calm, or correct a misunderstanding, it accepts that statement instead of treating it as concealed distress. This is a small rule-based protection, not a complete interpretation of intent.

## Troubleshooting

- **Local fallback / missing key:** paste the key after `DEEPINFRA_API_KEY=` in `.env`, then restart the server. `GET /api/health` reports whether a key is configured without making a paid request. If it still says unconfigured, check for an existing PowerShell environment variable that overrides `.env`.
- **Invalid key or model:** confirm the key in your DeepInfra account and the model identifier in the [official catalog](https://deepinfra.com/models). Restart after changing environment variables. Provider error details are deliberately not shown in the browser.
- **Rate limit or provider/network error:** wait, check DeepInfra status and your account limits, then use **Try DeepInfra again** on a basic reply.
- **Local server unavailable:** verify that `npm start` is running and open the exact local URL printed by the server. The browser can still provide a basic reply while an already-open page is offline.
- **Chat history missing:** confirm you are using the same browser profile and local address. Clearing browser site data also clears the history.
