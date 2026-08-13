**English** · [Русский](README.ru.md)

# Janitor AI Ripper

JAR (Janitor AI Ripper) — extract lorebooks and characters from JanitorAI, both public and private, locally on your PC and automated.

## Requirements

- **A Windows / Linux / Mac machine with a GUI.** JAR launches a full browser window, so it won't run without a GUI.
- JAR **won't run on Termux** out of the box, and **no support for Termux will be provided.**
- For mobile extraction, try [Glaze](https://github.com/hydall/Glaze) — an LLM roleplay frontend in development. JAR tools are built into it by default.

## Setup & run

### Step 1. Get the code

Option A — without Git: open https://github.com/hydall/JAR, click the green **Code → Download ZIP** button, unzip it, and enter the resulting folder.

Option B — with Git: 
```bash
git clone https://github.com/hydall/JAR.git
cd JAR
```

### Step 2. Launch the app

**Windows (easiest):** double-click **`start.bat`**.
On the first run it installs Node.js, dependencies, and Chromium, then starts the app. Subsequent runs just launch.

**Linux / Mac (or manual run on Windows):**

1. Install **Node.js LTS** from https://nodejs.org/en/download (if not already installed).
2. From the project folder, install dependencies and the Chromium browser:
   ```bash
   npm install
   ```
   (Chromium is installed automatically via `postinstall`.)
3. Start the app:
   ```bash
   npm start
   ```

Once started, the app opens in your default browser. **Keep the terminal / console window open while you use it** (stop with `Ctrl+C`).

### Step 3. Configure the extraction LLM

Open **⚙ Settings** to configure the extraction endpoint — any OpenAI-compatible endpoint (OpenRouter, OpenAI, local) that will be used to build the lorebook JSON (it's keys and activation rules).

### Step 4. Log into JanitorAI

The app uses a **separate browser** (`user-data/` folder) — you log into JanitorAI once inside it and the session persists. All extraction happens **under your account**; the tool sends the character text as chat messages to trigger lorebook entries. **A throwaway account is recommended.**

The program does not collect or store your login credentials — it only reads the JanitorAI session cookie to verify you are signed in.

## Use

1. **Log in** — click the **🔓** button in the header. A separate browser window opens at janitorai.com/login. Sign in as usual. The app detects the session automatically.

2. **Inspect a character** — paste the character URL into the sidebar and click **extract**. This pulls the card, avatar, and any public lorebooks.

3. **Extract a private card** — if the character definition is hidden, click **extract card** in the *character card* tab. The tool creates a chat, sends a probe, captures the card from the sent request.

4. **Extract a closed lorebook** — click **extract** in the *lorebook* tab. Sends the selected context to trigger lorebook entries on Janitor servers. Then, those entries are intercepted. Click "build lorebook" and select context to send these entries to an LLM of choice to reconstruct a lorebook.

5. **Download** — click **download .json** for a SillyTavern World Info file. Import via World Info → Import. Character cards download as PNG or JSON from the *character card* tab.

## How it works

JanitorAI uses Cloudflare to protect against automation. JAR launches a **full browser window** that passes through Cloudflare and executes all requests from there.

**Private Character card extraction** — JAR creates a dummy proxy preset, sends a message in the chat, and intercepts the `generateAlpha` response: the assembled prompt that contains the character card wrapped in tags.

**Private lorebook extraction** — closed lorebooks are processed on the JanitorAI server. Fully extracting them in their original form is impossible. As a workaround, JAR sends the character card, its catalog description, and the first message into the chat. This text reaches the JanitorAI server, where it triggers lorebook entries. The server injects those entries into the prompt. JAR intercepts the `generateAlpha` response and isolates the lorebook entries, discarding everything else.

**Public lorebooks and characters** — These are public and are downloaded directly from /hampter/characters endpoint. When a character has both public and closed lorebooks, the public entry text is automatically subtracted from the captured prompt before extraction, leaving only the closed entries.

After extraction you can:
- Download a **raw lorebook** without keys or rules.
- Send the entries to a chosen LLM (along with the selected context) and have it build a proper lorebook.

If the character uses a generic lorebook (e.g. a universe or shared lorebook), this method may not trigger all entries automatically. The only way to pull them is to manually type the trigger keys during entry collection. Those keys can then be sent to the LLM during the build for additional context.

## Saucepan (native extraction)

JAR can also extract characters from [saucepan.ai](https://saucepan.ai) — no browser or Cloudflare workaround needed. Saucepan serves companion definitions through an authenticated API, so extraction is a direct, exact pull (not a reconstruction).

1. **Log in** — open **⚙ Settings → Saucepan** and sign in with your Saucepan handle and password (or paste a Bearer token). The token is stored locally in `settings.local.json`; your password is never stored. A Saucepan session alone is enough to use the app — a JanitorAI login is not required.
2. **Extract** — paste a `saucepan.ai/companion/…` URL into the sidebar and click **extract**. The full card is pulled directly: description, first message and alternate greetings, example dialogue, tags, and avatar.
3. **Download** — save the card as PNG or JSON from the *character card* tab, exactly like a JanitorAI character.

Saucepan ships companion definitions as a shuffled list of text fragments padded with decoys (a naive read is scrambled). JAR validates each fragment against its proof hash, drops the decoys, and reassembles the survivors in order — mirroring Saucepan's own client — so the recovered text is exact. Greetings live on a separate endpoint and are reassembled the same way.
