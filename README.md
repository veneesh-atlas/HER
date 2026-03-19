# HER — Your AI Companion

A warm, emotionally immersive AI companion web app inspired by the film *Her* (2013).  
Built with **Next.js**, **TypeScript**, **Tailwind CSS**, and **Google Gemini**.

---

## Prerequisites

Make sure your machine has these installed before starting:

| Tool | Version | How to check | Install from |
|------|---------|--------------|--------------|
| **Node.js** | 18 or newer | `node -v` | [nodejs.org](https://nodejs.org/) |
| **npm** | 9 or newer (comes with Node) | `npm -v` | Included with Node.js |

---

## Setup (step by step)

### 1. Unzip the project

Unzip the folder wherever you like. You should see a folder called `HER` with files like `package.json`, `next.config.ts`, `src/`, etc.

### 2. Open a terminal inside the project folder

- **Windows:** Open the `HER` folder in File Explorer → click the address bar → type `cmd` or `powershell` → press Enter.
- **Mac/Linux:** Open Terminal → `cd /path/to/HER`

### 3. Install dependencies

```bash
npm install
```

This will create a `node_modules` folder with all required packages. It may take a minute or two.

### 4. Create your environment file

Create a file called **`.env.local`** in the project root (right next to `package.json`) with this content:

```
HER_PROVIDER=gemini
GEMINI_API_KEY=your_api_key_here
```

**To get a free Gemini API key:**
1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Sign in with a Google account
3. Click **"Create API Key"**
4. Copy the key and paste it in place of `your_api_key_here`

> ⚠️ **Important:** The `.env.local` file is intentionally excluded from the zip for security. Each person needs their own API key.

### 5. Start the development server

```bash
npm run dev
```

You should see output like:

```
  ▲ Next.js 16.x.x
  - Local:   http://localhost:3000
```

### 6. Open the app

Open your browser and go to:

```
http://localhost:3000
```

Click **"begin"** on the landing page to enter the chat. That's it — you're talking to HER.

---

## Project structure (quick overview)

```
HER/
├── src/
│   ├── app/                  ← Pages & API routes
│   │   ├── page.tsx              Landing page
│   │   ├── chat/page.tsx         Chat interface
│   │   ├── api/chat/route.ts     Gemini API endpoint
│   │   └── globals.css           Design system & palette
│   ├── components/           ← UI components
│   │   └── chat/                 ChatHeader, ChatWindow, ChatInput,
│   │                             MessageBubble, TypingIndicator
│   └── lib/                  ← Core logic
│       ├── provider.ts           AI provider (Gemini)
│       ├── prompts/              HER's personality & voice
│       ├── context.ts            Conversation context builder
│       ├── conversation.ts       Payload builder
│       ├── chat-store.ts         localStorage persistence
│       └── types.ts              TypeScript types
├── .env.local                ← API keys (you create this)
├── package.json
├── next.config.ts
└── tsconfig.json
```

---

## Common commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start development server (http://localhost:3000) |
| `npm run build` | Build for production |
| `npm start` | Run the production build |
| `npm run lint` | Check code for issues |

---

## What to zip / what NOT to zip

When sharing this project, **exclude** these (they're auto-generated or private):

| Exclude | Why |
|---------|-----|
| `node_modules/` | Huge — gets recreated by `npm install` |
| `.next/` | Build cache — gets recreated by `npm run dev` |
| `.env.local` | Contains your private API key |
| `test-*.mjs` | Dev-only test scripts (optional to include) |

Everything else should be included in the zip.

---

## Troubleshooting

**"Module not found" errors**  
→ Run `npm install` again. You may have missed step 3.

**"GEMINI_API_KEY is not set" or API errors**  
→ Make sure `.env.local` exists in the project root with a valid key. Restart the dev server after creating/editing it.

**Port 3000 already in use**  
→ Either stop whatever's using port 3000 or run: `npm run dev -- -p 3001`

**Blank page or hydration errors**  
→ Delete the `.next` folder and restart:
```bash
# Mac/Linux
rm -rf .next
npm run dev
```
```powershell
# Windows PowerShell
Remove-Item -Recurse -Force .next
npm run dev
```

---

## Tech stack

- **Next.js 16** — App Router, React Server Components
- **React 19** — UI framework
- **TypeScript 5** — Type safety
- **Tailwind CSS 4** — Styling (warm analog palette)
- **Google Gemini 2.5 Flash** — AI model via `@google/generative-ai`

---

*Made with warmth.* 🧡

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
