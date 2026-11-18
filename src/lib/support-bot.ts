/**
 * FlashBolt support assistant — a free, self-contained support bot trained on
 * how this app actually works.
 *
 * Every answer is written from the real behaviour of the codebase (scanner,
 * bot, contract deploy/verify, wallets, history receipts, PnL, notifications,
 * Telegram channel, multi-chain registry). The engine is a deterministic
 * keyword matcher over this knowledge base — nothing is simulated and no
 * external API key or cost is involved.
 */

export interface SupportTopic {
  id: string;
  title: string;
  /** Must match for the topic to be eligible (its most distinctive terms). */
  mustInclude: string[];
  /** General terms that add to the match score. */
  keywords: string[];
  answer: string;
}

export interface SupportAnswer {
  topicId: string;
  title: string;
  answer: string;
  /** How many knowledge-base terms the query matched. */
  matched: number;
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const TOPICS: SupportTopic[] = [
  {
    id: "what-is-flashbolt",
    title: "What FlashBolt is",
    mustInclude: ["flashbolt", "what is", "about this app", "what does it do"],
    keywords: ["flashbolt", "arbitrage", "bot", "app", "tool", "dapp", "terminal"],
    answer:
      "FlashBolt is a flash-loan triangular arbitrage terminal. It scans real DEX liquidity on BNB Smart Chain, Ethereum, Arbitrum and Polygon, finds triangular routes whose net profit (after the lender fee, slippage and live gas) is positive, and can execute them in real time with a connected wallet — or track them in paper mode with the same real market data. Everything shown is real market data, never simulated.",
  },
  {
    id: "how-it-works",
    title: "How the arbitrage works",
    mustInclude: ["how", "triangular", "triangle", "flash loan", "spread", "route"],
    keywords: [
      "how",
      "triangular",
      "triangle",
      "flash loan",
      "flashloan",
      "spread",
      "route",
      "leg",
      "arbitrage",
      "swap",
      "work",
    ],
    answer:
      "A triangular arbitrage borrows the chain's native token with a flash loan (e.g. from Aave V3 or Venus), swaps it across three DEX legs — e.g. BNB → token → token → BNB — and repays the loan in the same transaction. The scanner only flags routes where the expected net profit after the lender fee, your slippage setting and the chain's live gas price is still positive. The lender rotates with every scan run, preferring low-fee lenders first (Balancer queue on the Strategy page).",
  },
  {
    id: "paper-vs-live",
    title: "Paper mode vs live mode",
    mustInclude: ["paper", "live mode", "live"],
    keywords: ["paper", "live", "mode", "simulat", "real"],
    answer:
      "Paper mode runs the exact same scanner and market data but keeps gains in a tracked paper account — no real transaction is broadcast. Live mode requires a connected wallet and an armed (deployed) contract; then the bot broadcasts real wallet-signed transactions. The mode switch is on the Bot page. Paper mode is honest accounting of the same real market data, not a fake feed.",
  },
  {
    id: "scanner",
    title: "The Scanner page",
    mustInclude: ["scanner", "honey", "scan"],
    keywords: [
      "scanner",
      "scan",
      "honey",
      "honeypot",
      "spread",
      "pairs",
      "dexscreener",
      "liquidity",
      "route",
      "filter",
    ],
    answer:
      "The Scanner streams real DEX pairs from DexScreener for the active chain (BNB, Ethereum, Arbitrum or Polygon) and computes live triangular routes. A 'honey pot' is a route that clears both a real liquidity floor and a profit threshold — flagged instantly with a notification. You can filter by DEX (the active chain's whitelist), and execute any profitable route in one click when live mode is armed. No values are fabricated: every spread comes from live pair data and the chain's real gas price.",
  },
  {
    id: "lenders",
    title: "Flash-loan lenders & rotation",
    mustInclude: ["lender", "lenders", "venus", "aave", "dforce", "radiant", "rotation", "borrow"],
    keywords: [
      "lender",
      "lenders",
      "venus",
      "aave",
      "dforce",
      "radiant",
      "pancakeswap",
      "rotation",
      "borrow",
      "fee",
      "balancer",
    ],
    answer:
      "Lenders are scoped per chain to protocols that actually deploy there — Venus and PancakeSwap stay on BNB, Aave V3 and Radiant cover the EVM chains, and so on. The flash-loan lender rotates with each scan run and the rotation queue prioritises low-fee lenders before higher-fee ones (the 'Balancer' section on the Strategy page), so the bot favours the cheapest borrowing cost first.",
  },
  {
    id: "gas",
    title: "Gas prices & RPC endpoints",
    mustInclude: ["gas", "rpc", "gwei", "fee"],
    keywords: ["gas", "rpc", "gwei", "fee", "price", "endpoint", "private"],
    answer:
      "Live gas prices come from each chain's public CORS-open RPC (e.g. 1rpc.io for Ethereum, the Polygon public node, Arbitrum's RPC, BNB's dataseed). On the Contract page you can also set a private RPC override next to the public endpoint; the override is honoured everywhere via the effectiveRpc helper — live gas, receipt lookups and execution. BNB testnet always stays on the public testnet RPC. A private RPC must be an http(s) URL that allows CORS.",
  },
  {
    id: "bot-loop",
    title: "Starting & stopping the bot",
    mustInclude: ["bot", "running", "cadence", "paused", "start"],
    keywords: [
      "bot",
      "running",
      "paused",
      "start",
      "stop",
      "cadence",
      "scan every",
      "scan",
      "loop",
    ],
    answer:
      "Toggle 'Bot running' on the Bot page to start the scan loop; it re-scans every N seconds (the cadence you set). The loop only advances while the bot is running. In live mode the bot only executes trades that are still profitable — routes below the net-profit floor are skipped, never forced. The sidebar shows the bot state, the active chain and whether a contract is armed.",
  },
  {
    id: "funding",
    title: "Funding your wallet — getting the address right",
    mustInclude: [
      "fund", "funding", "top up", "topup", "deposit address", "send bnb",
      "send sol", "buy bnb", "buy sol", "where send", "which network",
    ],
    keywords: [
      "fund", "funding", "top", "deposit", "send", "address", "network",
      "bnb", "sol", "tbnb", "faucet", "exchange", "withdraw", "transfer",
    ],
    answer:
      "Fund YOUR OWN wallet, then the terminal uses it — FlashBolt never takes a deposit. Get the full 0x… address from MetaMask (copy icon next to the account name) or from the Wallets page header, which now shows it with a click-to-copy button and the live BNB balance. Send on the network you trade on: BNB Smart Chain for the BNB terminal (tBNB test-only via the official faucet), Solana for the SOL terminal. Exchange withdrawals must pick that same network or funds can strand. Deposits appear in the wallet card within seconds of the next balance refresh — the honest placeholder stays until the chain confirms.",
  },
  {
    id: "auto-payout",
    title: "Auto-payout of profits",
    mustInclude: ["payout", "auto-payout", "withdraw", "profit"],
    keywords: [
      "payout",
      "payouts",
      "auto",
      "withdraw",
      "profit",
      "paid",
      "wallet",
      "credited",
    ],
    answer:
      "When auto-payout is on, every live execution's profit is transferred straight to your connected wallet in the same transaction. When it's off (or in paper mode), the gain is credited to the paper account instead. The setting lives on the Bot page, and each execution in History shows exactly which happened.",
  },
  {
    id: "wallets",
    title: "Connecting a wallet",
    mustInclude: ["wallet", "connect", "metamask", "provider", "inject", "eip"],
    keywords: [
      "wallet",
      "connect",
      "metamask",
      "injected",
      "provider",
      "eip-1193",
      "reject",
      "approve",
      "account",
    ],
    answer:
      "On the Wallets page (or the Bot page in live mode) click Connect — FlashBolt uses the wallet's EIP-1193 injected provider, so MetaMask, Rabby, Trust and similar wallets work. If you reject the request (error code 4001) nothing is sent and the UI says so honestly. Make sure the wallet is on the chain the bot is scanning; the terminal switches the chain for you when execution starts.",
  },
  {
    id: "deploy",
    title: "Compiling & deploying the contract",
    mustInclude: ["deploy", "deployment", "compile", "bytecode", "constructor"],
    keywords: [
      "deploy",
      "deployment",
      "compile",
      "auto-compile",
      "bytecode",
      "constructor",
      "creation",
      "armed",
      "router",
      "testnet",
    ],
    answer:
      "The Contract page auto-compiles the FlashBoltArbitrage contract in the browser (real solc), producing the ABI, the bytecode hash and the full creation bytecode. 'Deploy' encodes the Router02 constructor argument for the selected chain, broadcasts a real wallet-signed transaction (switching the wallet to the right network first), polls the receipt and auto-arms the deployment. You can deploy to BNB mainnet, BNB testnet, or the EVM chain selected in the terminal. A rejection or on-chain revert is reported honestly with the actual error.",
  },
  {
    id: "testnet-mainnet",
    title: "BNB testnet / mainnet switch",
    mustInclude: ["testnet", "mainnet", "switch network"],
    keywords: ["testnet", "mainnet", "switch", "network", "bsc", "contract"],
    answer:
      "Inside the Contract page there is a mainnet/testnet switch for BNB. Testnet deploys and verifies against the BNB testnet endpoints (and always uses the public testnet RPC), mainnet against live BscScan. Deployments are tracked per chain, so switching never shows a stale contract.",
  },
  {
    id: "verify",
    title: "Verify & publish source code",
    mustInclude: ["verify", "verif", "bscscan", "publish", "flatten", "source"],
    keywords: [
      "verify",
      "verif",
      "bscscan",
      "publish",
      "flatten",
      "flattened",
      "source",
      "api key",
      "license",
      "wizard",
    ],
    answer:
      "After a deploy, 'Verify & Publish' submits the real flattened source (imports inlined into a single pragma/SPDX file) to the explorer's API — BscScan on BNB. It needs a BSCSCAN_API_KEY from the Keys tab; without one, the page links to the explorer's manual wizard and copies the flattened source for you. Other chains link their own explorer's verification wizard.",
  },
  {
    id: "history-receipts",
    title: "History & real receipts",
    mustInclude: ["history", "receipt", "transaction", "tx", "explorer"],
    keywords: [
      "history",
      "receipt",
      "receipts",
      "transaction",
      "tx",
      "hash",
      "confirmed",
      "reverted",
      "pending",
      "explorer",
      "block",
    ],
    answer:
      "Every on-chain execution's real receipt is fetched from the chain's RPC and shown in History: a Confirmed / Reverted / Pending badge, the block number, the gas used in native tokens, the full transaction hash (copyable) and a link to the chain's explorer. Reverted trades show the loss honestly — nothing is hidden or simulated.",
  },
  {
    id: "pnl",
    title: "PnL analytics",
    mustInclude: ["pnl", "profit and loss", "overview", "win rate", "earnings"],
    keywords: [
      "pnl",
      "profit",
      "loss",
      "overview",
      "win rate",
      "best trade",
      "net",
      "analytics",
      "chart",
    ],
    answer:
      "The Overview page computes PnL from the actual persisted execution trail: paper profits net of documented flash-loan fees, and on-chain trades net of the real gas paid (receipt gas × the transaction's actual gas price). Metric cards show Net PnL, On-chain PnL, Paper PnL, Win rate and Best trade, and the cumulative chart plots the same net series. Every figure traces back to recorded receipts.",
  },
  {
    id: "notifications",
    title: "Notifications bell",
    mustInclude: ["notification", "bell", "alert", "unread", "events"],
    keywords: [
      "notification",
      "notifications",
      "bell",
      "alert",
      "unread",
      "read",
      "event",
      "feed",
    ],
    answer:
      "The bell at the top right of the terminal lists real events: every bot execution (success, MEV-blocked, below floor, revert) and every new honey-pot route from the live scanner. Events persist per user, unread counts show on the badge, and 'mark all read' clears them. Nothing is pre-seeded — only events that actually happened appear.",
  },
  {
    id: "telegram",
    title: "Telegram alert channel",
    mustInclude: ["telegram", "ping", "chat id", "bot token", "channel"],
    keywords: [
      "telegram",
      "ping",
      "chat",
      "channel",
      "token",
      "alert",
      "send",
    ],
    answer:
      "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the Keys tab and the terminal sends a real Telegram message (api.telegram.org Bot API) for flash-loan trades and earnings — for both operator and subscriber accounts. That is the ONLY thing that goes to Telegram: honey-pot finds, support tickets and email alerts never go there (they stay in-app and/or go to the operator's email). Without the keys the channel is honestly reported as disabled — nothing is faked.",
  },
  {
    id: "strategy",
    title: "Strategy page — whitelist & balancer",
    mustInclude: ["strategy", "whitelist", "balancer", "slippage", "threshold"],
    keywords: [
      "strategy",
      "whitelist",
      "whitelists",
      "balancer",
      "rotation",
      "slippage",
      "threshold",
      "dex",
      "lender",
    ],
    answer:
      "The Strategy page controls which AMMs each chain may trade through (a separate whitelist per chain with each DEX's real fee), the flash-loan lender rotation queue (low-fee lenders first), and the slippage / profit-floor thresholds. The scanner only ever uses the active chain's whitelist; BNB's legacy list is the fallback.",
  },
  {
    id: "multi-chain",
    title: "Switching chains",
    mustInclude: ["chain", "ethereum", "arbitrum", "polygon", "bsc", "switch"],
    keywords: [
      "chain",
      "chains",
      "bsc",
      "ethereum",
      "arbitrum",
      "polygon",
      "switch",
      "multi",
      "network",
    ],
    answer:
      "Use the chain switcher at the top centre of the terminal (also on the Scanner page) to move between BNB Smart Chain, Ethereum, Arbitrum and Polygon. Each chain has its own real DexScreener pairs, quote token, RPC, routers, DEX whitelist, lenders and a separate armed deployment — so switching never shows another chain's stale data.",
  },
  {
    id: "account-menu",
    title: "Account menu",
    mustInclude: ["account", "email", "sign out", "logout", "profile", "menu"],
    keywords: [
      "account",
      "email",
      "registered",
      "sign out",
      "logout",
      "profile",
      "menu",
      "support",
    ],
    answer:
      "The account menu (top right of the terminal, before the world clock) shows your registered email address and a Support entry that opens this assistant. Signing out returns you to the landing page; your terminal state is preserved in your account.",
  },
  {
    id: "world-clock",
    title: "World clock & timezones",
    mustInclude: ["clock", "time", "utc", "timezone", "offset"],
    keywords: ["clock", "time", "utc", "timezone", "offset", "date"],
    answer:
      "The world clock on every page shows the real device time shifted to a UTC offset, formatted 00:00:00 with the date beneath it (e.g. AUG:09:2026). Click the dropdown arrow next to UTC to pick an offset from UTC-12 to UTC+14; the choice persists across pages. It is your real clock, ticking every second — never a simulation.",
  },
  {
    id: "support-bot",
    title: "This support assistant",
    mustInclude: ["support", "assistant", "chatbot", "ask you", "help bot"],
    keywords: ["support", "assistant", "chatbot", "bot", "help", "question", "answer"],
    answer:
      "This assistant is a free, built-in support bot trained on how FlashBolt works. It answers from a knowledge base written from the app's real behaviour — try asking about deploying, wallet issues, the scanner, PnL, receipts, or switching chains. If it can't answer precisely it will say so and list what it covers, rather than guess.",
  },
  {
    id: "setup-local",
    title: "Running FlashBolt locally / deploying your own",
    mustInclude: ["setup", "install", "locally", "runbook", "deploy your own"],
    keywords: [
      "setup",
      "install",
      "bun install",
      "bunx convex dev",
      "locally",
      "local",
      "runbook",
      "run it",
      "deploy your own",
      "own instance",
      "vite",
    ],
    answer:
      "To run your own instance: bun install, then bunx convex dev (provisions its own Convex deployment and writes VITE_CONVEX_URL), then bun run dev. A fresh setup needs JWKS, JWT_PRIVATE_KEY and SITE_URL on the backend (Keys/API keys UI, or npx convex env set), and the client VITE_CONVEX_URL. There is also a one-command setup script (bun run setup / setup:win) that is non-destructive — it never touches .env or existing settings. The README runbook walks the whole flow, and the release guard (check:mirror) verifies the packaged mirror is in sync before shipping.",
  },
  {
    id: "env-keys",
    title: "Environment variables & API keys",
    mustInclude: ["env", "environment", "api key", "keys tab", "secrets", "jwt", "jwks"],
    keywords: [
      "env",
      "environment",
      "api key",
      "api keys",
      "keys",
      "secrets",
      "jwt",
      "jwks",
      "site url",
      "vite_convex_url",
      "bscscan",
      "telegram",
      "sambanova",
      "token",
    ],
    answer:
      "All secrets live in the Keys/API keys tab (or npx convex env set): JWKS and JWT_PRIVATE_KEY sign/verify auth tokens, SITE_URL drives auth redirects, BSCSCAN_API_KEY enables Verify & Publish, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID enable Telegram alerts for flash-loan trades and earnings, CARTESIA_API_KEY powers the avatar explainer's real voice (cached, so replays cost nothing), and SAMBANOVA_API_KEY enables the support chatbot's open-ended AI answers. The client's VITE_CONVEX_URL is written automatically by Convex. Every channel honestly reports 'disabled' until its key is present — nothing is faked.",
  },
  {
    id: "mirror-package",
    title: "Mirror zip & packaging",
    mustInclude: ["mirror", "zip", "package", "duplicate", "project 2"],
    keywords: [
      "mirror",
      "zip",
      "package",
      "packaging",
      "duplicate",
      "project 2",
      "template",
      "repackage",
      "mirror-v",
      "exact copy",
    ],
    answer:
      "bun run package:mirror produces a versioned mirror-v<version>.zip (mirror/ layout) containing everything a fresh project needs, and then runs the release guard which checks src, package.json, CHANGELOG, README and scripts are byte-identical to the live app with no forbidden contents (node_modules/.git/dist/.env*). It is how Project 2 gets an exact copy of this app — paste the zip contents into a fresh project and it provisions its own Convex deployment.",
  },
  {
    id: "version-release",
    title: "Versions & changelog",
    mustInclude: ["version", "changelog", "release", "v1"],
    keywords: [
      "version",
      "changelog",
      "release",
      "releases",
      "v1.",
      "badge",
      "current version",
    ],
    answer:
      "Each feature batch ships as a new minor version (v1.7.0 today): the Contract page badge, package.json, CHANGELOG.md and README all carry the same number, and the mirror zip is named after it (mirror-v1.7.0.zip). The CHANGELOG lists every release with its real features.",
  },
  {
    id: "ai-support",
    title: "AI answers in support chat",
    mustInclude: ["ai", "model", "sambanova", "llama", "open-ended"],
    keywords: [
      "ai",
      "model",
      "sambanova",
      "llama",
      "open-ended",
      "smart",
      "chatbot",
      "answer",
    ],
    answer:
      "The support chat answers instantly from its local knowledge base, and when it isn't confident it calls a real free AI model — Llama 3.3 70B on SambaNova Cloud — through a server-side Convex action. Add SAMBANOVA_API_KEY in the Keys tab to enable it; the model's name and mark appear under the chat popup. Without the key, the chatbot honestly stays knowledge-base-only. Every AI reply is a genuine model response, never a canned script.",
  },
  {
    id: "human-help",
    title: "Talk to a human / create a ticket",
    mustInclude: [
      "human",
      "agent",
      "person",
      "ticket",
      "escalate",
      "speak to",
      "talk to",
      "real person",
      "support team",
    ],
    keywords: [
      "human",
      "agent",
      "person",
      "ticket",
      "escalate",
      "speak to",
      "talk to",
      "real person",
      "support team",
      "customer support",
      "someone",
    ],
    answer:
      "I'll create a support ticket with our conversation so a human can pick it up with full context. A reference number appears here as soon as it's saved, and if a Telegram channel is configured the team is pinged with your summary.",
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting problems",
    mustInclude: ["error", "problem", "not working", "fail", "stuck", "pending", "issue", "broken"],
    keywords: [
      "error",
      "problem",
      "not working",
      "fail",
      "failed",
      "stuck",
      "pending",
      "issue",
      "broken",
      "nothing",
      "why",
    ],
    answer:
      "Common causes, in order: (1) live mode needs a wallet connected and a contract deployed + armed on the active chain — the sidebar says 'contract armed · live ready' when set; (2) the bot must be toggled on and its cadence elapsed; (3) a route below the net-profit floor is skipped by design — only profitable trades execute; (4) a revert or rejection (code 4001) is shown verbatim in History; (5) a private RPC that blocks CORS won't be used — check it's an http(s) URL that allows CORS. If none of these fit, describe the exact message you see.",
  },
  {
    id: "sol-terminal",
    title: "The Solana (SOL) terminal",
    mustInclude: ["solana", "jupiter", "sniper", "sol terminal"],
    keywords: [
      "solana", "jupiter", "sniper", "snipe", "scanner", "arb", "arbitrage",
      "terminal", "jito", "route",
    ],
    answer:
      "The SOL FlashBolt terminal is the Solana side of the app: a Sniper (buys a token the moment a signal lands, then exits with a real sell), a Scanner for live two-leg arbitrage, a Strategy page for the guards, and a Wallets page. Routes are quoted and executed through Jupiter across Solana DEXes, submitted through the Jito block-engine (protected, revert-safe) or the public RPC, and signed by your connected Phantom/Solflare/Backpack extension or an imported in-memory vault wallet. Every quote, signature and on-chain confirmation is real — nothing is simulated.",
  },
  {
    id: "sol-arb-balance",
    title: "SOL balance needed for a flash-loan arb",
    mustInclude: [
      "enough sol", "how much sol", "balance for", "loan size", "flash loan balance",
      "preflight", "insufficient sol", "not enough sol",
    ],
    keywords: [
      "enough", "balance", "loan", "sol", "arb", "arbitrage", "short", "shortfall",
      "reserve", "cover", "fund", "funded", "require", "required", "needed",
    ],
    answer:
      "The Solana route is a real two-leg arbitrage — the wallet fronts the loan size itself (there is no on-chain borrowed principal on the SOL side), so the wallet must hold the full loan amount PLUS a 0.005 SOL fee/ATA-rent reserve, verified by a live getBalance pre-flight before anything is signed. A 5 SOL arb needs 5.005 SOL; the strategy max loan caps at 50 SOL. Oversized signals are FITTED to the wallet instead of failing: a route bigger than the balance shrinks to what the wallet can front (balance − 0.005 SOL reserve, floor 0.05 SOL) and lands as a real, smaller trade — e.g. a 0.061 SOL wallet executes a 0.056 SOL clip. Only a wallet below 0.055 SOL total is refused inline with the exact top-up math — no wallet popup, nothing signed or spent (engine 'preflight-balance').",
  },
  {
    id: "sol-wallets",
    title: "SOL wallets — extensions & the import vault",
    mustInclude: [
      "solana", "phantom", "solflare", "backpack", "session passphrase",
      "import wallet", "import a wallet", "imported wallet", "seed phrase",
      "recovery sheet", "vault",
    ],
    keywords: [
      "wallet", "connect", "extension", "passphrase", "unlock", "lock", "import",
      "watch-only", "solana", "phantom",
    ],
    answer:
      "On the SOL terminal's Wallets page: connect Phantom, Solflare or Backpack (detected via the standard extension injection points, with a silent onlyIfTrusted reconnect) — or press 'Import wallet' and paste a seed phrase or private key. Imports are validated locally (BIP39 + SLIP-0010) and sealed with AES-256-GCM under a session passphrase YOU invent — it is not your Phantom password, it never leaves the browser tab, and the same passphrase unlocks the vault after a reload (Lock wipes memory; the recovery sheet re-verifies it before exporting keys). Public keys can be added watch-only: tracked for payouts, never able to sign.",
  },
  {
    id: "sol-strategy",
    title: "SOL Strategy — adjustable guards",
    mustInclude: [
      "profit floor", "scan cadence", "max loan", "min loan", "sol strategy",
      "slippage setting", "slippage sol",
    ],
    keywords: [
      "profit", "floor", "cadence", "max", "min", "loan", "slippage", "guards",
      "strategy", "solana",
    ],
    answer:
      "The SOL Strategy page's Guards & execution section is fully adjustable: profit floor (0–5%), slippage (0.05–5%), scan cadence (1–300 s) and the max loan (0.05–50 SOL — the app's real bounds; the 0.05 floor matches the wallet-fit minimum clip, so a 0.055 SOL wallet can still land a real 0.05 SOL route). Number inputs and live sliders share the same bounds, typed values clamp into range on blur, and failed saves surface an honest error instead of vanishing. The scanner only executes routes that clear your profit floor after fees and slippage — routes below it are skipped by design.",
  },
];

export const GREETING: SupportAnswer = {
  topicId: "greeting",
  title: "Hello",
  answer:
    "Hi! I'm the FlashBolt support assistant. Ask me anything about the terminal — scanning, flash loans, deploying and verifying contracts, wallets, PnL, receipts, the Solana sniper and its wallets, or switching chains. You can also tap a suggested topic below.",
  matched: 0,
};

const THANKS: SupportAnswer = {
  topicId: "thanks",
  title: "You're welcome",
  answer: "You're welcome — happy to help. Anything else about FlashBolt?",
  matched: 0,
};

export const FALLBACK: SupportAnswer = {
  topicId: "fallback",
  title: "Let me point you somewhere useful",
  answer:
    "I couldn't match that against the FlashBolt knowledge base with confidence, and I won't guess. I can help with: deploying & verifying contracts, connecting wallets, the scanner and honey-pots, flash-loan lenders and rotation, gas and private RPCs, PnL, history receipts, notifications & Telegram alerts, the Solana sniper (arb balance, Phantom/vault imports, strategy guards), and switching chains. Try rephrasing with one of those topics.",
  matched: 0,
};

/** Words that carry no topic signal and should never trigger a match. */
const STOPWORDS = new Set([
  "how", "do", "does", "did", "i", "my", "me", "the", "a", "an", "to", "of",
  "on", "in", "with", "can", "could", "get", "got", "where", "is", "are",
  "it", "that", "for", "you", "your", "what", "when", "why", "and", "or",
  "not", "no", "will", "would", "please", "show", "tell", "help", "about",
  "use", "using", "there", "here", "at", "from", "be", "been", "was", "were",
]);

/** Query with filler words removed, so "how do I deploy" leaves "deploy". */
function meaningfulQuery(q: string): string {
  const words = q.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return words.join(" ");
}

/** Pick the best topic for a query; returns FALLBACK when nothing is confident. */
export function getSupportAnswer(rawQuery: string): SupportAnswer {
  const q = normalize(rawQuery);
  if (!q) return FALLBACK;

  if (/^(hi|hello|hey|yo|greetings|good (morning|afternoon|evening))(\s|$)/.test(q)) {
    return GREETING;
  }
  if (/(^|\s)(thanks|thank you|thx|appreciated)(\s|$)/.test(q)) {
    return THANKS;
  }
  if (/^(help|help me|what can you do|what do you know)$/.test(q)) {
    return FALLBACK;
  }

  const meaningful = meaningfulQuery(q);
  let best: SupportTopic | null = null;
  let bestScore = 0;
  for (const topic of TOPICS) {
    // Multi-word keywords match the full query; single words must survive
    // stopword removal so generic filler never scores a topic.
    const matched = topic.keywords.filter(
      (k) => (k.includes(" ") ? q.includes(k) : meaningful.includes(k)),
    ).length;
    const mustMatched = topic.mustInclude.some((k) =>
      k.includes(" ") ? q.includes(k) : meaningful.includes(k),
    );
    // A distinctive must-include term earns a hit even alone; otherwise need
    // at least two overlapping terms to avoid guessing.
    if ((mustMatched && matched >= 1) || matched >= 2) {
      if (best === null || matched > bestScore) {
        best = topic;
        bestScore = matched;
      }
    }
  }

  if (!best) return FALLBACK;
  return {
    topicId: best.id,
    title: best.title,
    answer: best.answer,
    matched: bestScore,
  };
}

/** Suggested quick-topic chips for the chat UI. */
export const QUICK_TOPICS: { label: string; query: string }[] = [
  { label: "How does the bot work?", query: "how does the bot work" },
  { label: "Deploy a contract", query: "how do I deploy a contract" },
  { label: "Wallet won't connect", query: "wallet will not connect" },
  { label: "Check my PnL", query: "where is my PnL" },
  { label: "Verify on BscScan", query: "verify contract on bscscan" },
  { label: "Switch chain", query: "how do I switch chains" },
  { label: "Run it locally", query: "how do I run flashbolt locally" },
  { label: "SOL for a 5 SOL arb?", query: "do I have enough sol for a 5 sol flash loan" },
  { label: "Import a Phantom wallet", query: "how do I import a phantom wallet" },
  { label: "Fund my wallet", query: "how do I fund my wallet" },
];
