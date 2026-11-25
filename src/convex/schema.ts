import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove

      // "Continue as Guest" operator marker — set by
      // gate.activateGuestOperatorSession on the anonymous session's user row
      // ONLY after a real guest access code was verified server-side. Lets
      // operator-only backend surfaces (the Telegram bot mirror) accept the
      // guest identity without an email address.
      guestOperatorVerifiedAt: v.optional(v.number()),
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // FlashBolt terminal state — one document per user, persisted across reloads
    terminalStates: defineTable({
      userId: v.id("users"),
      balance: v.number(),
      lifetimePnl: v.number(),
      executionsToday: v.number(),
      successesToday: v.number(),
      successRate: v.number(),
      scansToday: v.number(),
      openOpportunities: v.number(),
      botRunning: v.boolean(),
      // INDEPENDENT background running — the SOL FlashBolt bot starts/stops
      // on its own switch so stopping one bot never stops the other. The BNB
      // engine keeps the classic botRunning; the SOL engine (and its bot
      // commands) gate on solBotRunning.
      solBotRunning: v.optional(v.boolean()),
      mode: v.union(v.literal("paper"), v.literal("live")),
      // GLOBAL "Live only" ledger view — hides 🧪 SIM (paper) rows across
      // the terminal UI (activity feed + histories). Server-persisted so the
      // preference follows the operator across browsers/devices.
      liveOnly: v.optional(v.boolean()),
      minProfit: v.number(),
      mevGuard: v.boolean(),
      cadence: v.number(),
      connectedWallets: v.array(v.string()),
      lastScanAt: v.number(),
      // WHO drove the last scan — the single-driver rule for the autonomous
      // engine: "client" = the browser scan loop (app online), "server" =
      // the offline engine (terminal.scanPass). scanPass yields when the
      // client is freshly driving and resurrects via the heartbeat cron
      // otherwise — never two drivers at once.
      lastScanSource: v.optional(v.union(v.literal("client"), v.literal("server"))),
      // Lease tokens of the CURRENT server engine loops (single-driver
      // guarantee per chain): a self-rescheduling scanPass continues only
      // while the stored token matches its own; a client scan clears it.
      // Separate BNB/SOL leases let both engines run (or stop) independently.
      engineLoopToken: v.optional(v.string()),
      solEngineLoopToken: v.optional(v.string()),
      // Per-chain scan bookkeeping (mirrors lastScanAt/lastScanSource) so the
      // two engines stay independent: the SOL loop's freshness is judged on
      // its own stamps, never on the BNB loop's (and vice versa).
      solLastScanAt: v.optional(v.number()),
      solLastScanSource: v.optional(v.union(v.literal("client"), v.literal("server"))),
      // ── Sniper engines (BNB + SOL), the same 24/7 single-driver pattern ──
      // The snipers run as their own always-on server loops gated by the
      // SAME per-chain bot switches (botRunning / solBotRunning) but judged
      // on their OWN freshness stamps and leases — a scan loop never stands
      // a sniper loop down and vice versa, and BNB never touches SOL.
      bSnLastScanAt: v.optional(v.number()),
      bSnLastScanSource: v.optional(v.union(v.literal("client"), v.literal("server"))),
      bSnLoopToken: v.optional(v.string()),
      sSnLastScanAt: v.optional(v.number()),
      sSnLastScanSource: v.optional(v.union(v.literal("client"), v.literal("server"))),
      sSnLoopToken: v.optional(v.string()),
      // Per-chain opportunity counts from the engines' own passes (the
      // shared openOpportunities stays for the dashboard). The EnginePulse
      // reads these reactively to narrate fresh route finds per chain.
      bnbOpenOpportunities: v.optional(v.number()),
      solOpenOpportunities: v.optional(v.number()),
      scanDate: v.string(),
      // strategy
      maxLoan: v.number(),
      maxHops: v.number(),
      slippage: v.number(),
      gasPriority: v.union(
        v.literal("standard"),
        v.literal("fast"),
        v.literal("turbo"),
      ),
      autoPayout: v.boolean(),
      dexWhitelist: v.array(v.string()),
      // Balancer v — prioritize low-fee flash-loan lenders in the rotation
      lenderBalancer: v.boolean(),
      // One-time migration marker: existing accounts got the balancer flipped
      // ON (low-fee-first automatic lender selection) exactly once — explicit
      // operator choices afterwards are never overridden.
      lenderBalancerAutoOn: v.optional(v.boolean()),
      // Private-RPC submission (Flashbots Protect / bloXroute) — signed txs
      // for hot-wallet paths go to a private relay, hidden from the public
      // mempool until inclusion (anti-frontrun / anti-sandwich).
      privateSubmit: v.boolean(),
      // Daily arbitrage target — max flash routes the scanner executes per
      // day (0 = unlimited). Shared guard for both terminals.
      dailyArbTarget: v.number(),
      // Multi-asset flash loans: quote assets (beyond the wrapped native)
      // the operator enables for loan denomination. Entries must be assets
      // DISCOVERED live in the market feed (deep pairs on >=2 venues); the
      // engine ignores unknown symbols. Empty ⇒ native-denominated only.
      loanAssets: v.optional(v.array(v.string())),
      // ── SOL FlashBolt sniper/flasher settings (stamped into the overlay,
      // adjustable from /settings and the overlay dashboard) ──
      // Cluster: "mainnet" = mainnet-beta, "testnet" = devnet.
      solNetwork: v.union(v.literal("mainnet"), v.literal("testnet")),
      solBuyAmountSol: v.number(),
      solSellAmountPct: v.number(),
      solSlippagePct: v.number(),
      solProfitTargetPct: v.number(),
      solTrailingStopPct: v.number(),
      solMinLiquidityUsd: v.number(),
      // Per-cluster RPC override for the SOL flasher (empty = official URLs).
      solRpcOverrides: v.optional(v.record(v.string(), v.string())),
      // Execution rail: "jupiter" = real Jupiter swaps from the armed wallet;
      // "solcontract" = the FlashboltSolana program (needs a deployed program,
      // explicit authorization and — on mainnet — the audit sign-off).
      solExecutionRail: v.optional(
        v.union(v.literal("jupiter"), v.literal("solcontract")),
      ),
      // Deployed FlashboltSolana program ID (empty = none deployed).
      solContractProgramId: v.optional(v.string()),
      // Operator authorization binding the contract rail to the vault wallet.
      solContractAuthorized: v.optional(v.boolean()),
      // Independent audit sign-off — required before mainnet contract use.
      solAuditApproved: v.optional(v.boolean()),
      // Pinned cluster genesis hash; the engine refuses to sign when the RPC
      // reports a different (or unreadable) hash. Empty = built-in per cluster.
      solPinnedGenesis: v.optional(v.string()),
      // Addresses of Solana wallets imported into the SOL sniper via /import.
      // Only PUBLIC addresses live here — private keys/mnemonics are validated
      // locally and never leave the operator's browser session.
      solImportedWallets: v.optional(v.array(v.string())),
      // Public addresses of wallets imported into the BNB terminal via the
      // wallets page / sniper import. Same contract as solImportedWallets:
      // ONLY public addresses — private keys/mnemonics are derived locally
      // (BIP39 m/44'/60'/0'/0/0) and sealed in the browser's AES-256-GCM
      // session vault; nothing secret is ever transmitted or stored here.
      evmImportedWallets: v.optional(v.array(v.string())),
      // network (mainnet / testnet switch — managed from the Contract page)
      network: v.union(v.literal("mainnet"), v.literal("testnet")),
      // multi-chain scanner (bsc default; ethereum / arbitrum / polygon)
      chainKey: v.union(
        v.literal("bsc"),
        v.literal("ethereum"),
        v.literal("arbitrum"),
        v.literal("polygon"),
      ),
      // live mode: user's deployed FlashBoltArbitrage + router (Contract page)
      deployedContractAddress: v.optional(v.string()),
      routerAddress: v.optional(v.string()),
      // per-chain deployment records (chainKey -> armed contract + router).
      // signerAddress = the account that signed the contract-creation tx
      // ("0x..." = session hot wallet, "injected:<address>" = browser wallet).
      // relay = the channel that actually carried the signed bytes
      // (private-relay endpoint URL, or "public-rpc"). Both undefined for
      // manually pasted addresses that were never broadcast from this app.
      deployments: v.optional(
        v.record(
          v.string(),
          v.object({
            contractAddress: v.string(),
            routerAddress: v.string(),
            signerAddress: v.optional(v.string()),
            relay: v.optional(v.string()),
            /**
             * When the CURRENT address was armed (ms). Pins compare against it
             * so an old arm cannot approve a newer deployment. Re-saving the
             * same address never refreshes it. Absent on deployments saved
             * before this field existed.
             */
            armedAt: v.optional(v.number()),
            /**
             * When this address was first seen armed (ms). Equal to `armedAt`
             * for every arm recorded since the field existed; deliberately
             * absent for a pre-timestamp record, whose real first-arm time is
             * unknown and must not be back-dated.
             */
            firstArmedAt: v.optional(v.number()),
            /**
             * When the operator last SAVED this deployment (ms) — the
             * "affirmed" fact. It proves recency of the save (router edit,
             * signer note), never recency of the arm; the pin guard reads
             * `armedAt` for that.
             */
            affirmedAt: v.optional(v.number()),
          }),
        ),
      ),
      // per-chain DEX whitelists (chainKey -> dex short codes)
      dexWhitelists: v.optional(v.record(v.string(), v.array(v.string()))),
      // per-chain private RPC overrides (chainKey -> URL; falls back to public)
      rpcOverrides: v.optional(v.record(v.string(), v.string())),
      // automatic payout accounting
      payoutsTotal: v.number(),
      payoutsCount: v.number(),
      lastPayoutAt: v.optional(v.number()),
    }).index("by_user", ["userId"]),

    // FlashBolt execution trail (paper trades + blocked attempts)
    executions: defineTable({
      userId: v.id("users"),
      label: v.string(),
      profitPct: v.number(),
      amountBnb: v.number(),
      status: v.union(
        v.literal("success"),
        v.literal("blocked"),
        v.literal("below_floor"),
        v.literal("failed"),
      ),
      ts: v.number(),
      // flash-loan lender + DEX chain used for this execution
      lender: v.optional(v.string()),
      dexes: v.optional(v.string()),
      // profit auto-paid out to the wallet on success
      payoutBnb: v.optional(v.number()),
      network: v.optional(v.string()),
      // live mode on-chain record
      txHash: v.optional(v.string()),
      chainId: v.optional(v.number()),
      // private relay that carried the broadcast (undefined = public RPC path)
      relay: v.optional(v.string()),
      // real gas actually paid by the on-chain tx (from the receipt)
      gasUsedBnb: v.optional(v.number()),
      // REAL measured wall-clock cost of the local signing call (ms) — from
      // performance.now() around account.signTransaction in the production
      // executor (hot path only; undefined = injected wallet signed it).
      signingLatencyMs: v.optional(v.number()),
      // originating terminal chain ("bsc" | "ethereum" | "arbitrum" |
      // "polygon" | "solana") — lets each terminal read its own trail without
      // mixing native units (SOL gas vs BNB gas) in one PnL sum.
      chain: v.optional(v.string()),
      // how the edge was found ("triangular" | "cross-chain" | "statistical")
      // — lets Stats attribute real executions per discovery method.
      method: v.optional(v.string()),
    })
      .index("by_user", ["userId"])
      // Newest-first bounded reads (listExecutions / EnginePulse) and
      // day-windowed metric scans (collectMetrics) — full-table collects
      // were a top DB-I/O consumer.
      .index("by_user_ts", ["userId", "ts"])
      .index("by_ts", ["ts"]),

    // FlashBolt notification center — real events only (executions + honey
    // spots), persisted per user and shown in the terminal bell.
    notifications: defineTable({
      userId: v.id("users"),
      kind: v.union(
        v.literal("execution"),
        v.literal("honey_pot"),
        v.literal("market_news"),
        v.literal("session_update"),
        // Operator-only infrastructure fault (the bot message sweep). Its own
        // kind so the bell gets its own icon and its dedupe key cannot collide
        // with a session update; the writer resolves recipients server-side.
        v.literal("bot_health"),
      ),
      title: v.string(),
      body: v.string(),
      ts: v.number(),
      read: v.boolean(),
      chainKey: v.optional(v.string()),
      // Explicit dedupe identity for writers that must tell two same-titled
      // events apart (the abandonment notice carries its batch's row ids).
      // Absent on every other notification, which keeps the title + 1 h rule.
      dedupeKey: v.optional(v.string()),
    })
      .index("by_user", ["userId"])
      // Bounded bell reads: newest-N feed and unread-only count without
      // collecting the user's whole notification history on every refresh.
      .index("by_user_ts", ["userId", "ts"])
      .index("by_user_read", ["userId", "read"])
      // Kind-scoped reads (honey-pot context, market-news dedupe) — never
      // scan the operator's 16k+ execution notifications for a handful of
      // rows of another kind.
      .index("by_user_kind", ["userId", "kind"])
      // Daily retention sweep (retention.ts) — age-based pruning by ts.
      .index("by_ts", ["ts"]),

    // MATERIALIZED all-time PnL aggregates per user (see terminal.ts
    // pnlSummary). The executions table holds 16k+ rows ≈ 6 MB — a full
    // scan per pnlSummary run re-burned that on EVERY execution write while
    // the terminal was open (the single largest DB-I/O consumer). Instead,
    // applyExecution folds each row into this doc incrementally and
    // purgeCorruptedSolPaper rebuilds it from the full history once per
    // session (that mutation already scans everything). One small doc read
    // per run; the 24-hour figures still come from a bounded by_user_ts
    // range scan over just the last day.
    pnlStats: defineTable({
      userId: v.id("users"),
      liveCount: v.number(),
      wins: v.number(),
      grossProfit: v.number(),
      gasBurned: v.number(),
      solLiveCount: v.number(),
      solWins: v.number(),
      solGrossProfit: v.number(),
      solGasBurned: v.number(),
      simCount: v.number(),
      simWins: v.number(),
      simNet: v.number(),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // FlashBolt support chat — real conversation history per user, persisted
    // so questions and answers survive page refreshes.
    support_messages: defineTable({
      userId: v.id("users"),
      role: v.union(v.literal("user"), v.literal("bot")),
      text: v.string(),
      // where the bot answer came from: user = typed by the operator,
      // greeting / kb / fallback = knowledge base, ai = live model reply
      source: v.union(
        v.literal("user"),
        v.literal("greeting"),
        v.literal("kb"),
        v.literal("ai"),
        v.literal("fallback"),
      ),
    }).index("by_user", ["userId"]),

    // FlashBolt support tickets — real escalations created from the support
    // chat when the operator asks for a human. Stores the transcript so the
    // support side has full context.
    support_tickets: defineTable({
      userId: v.id("users"),
      summary: v.string(),
      transcript: v.array(
        v.object({ role: v.string(), text: v.string() }),
      ),
      status: v.union(v.literal("open"), v.literal("closed")),
      createdAt: v.number(),
    }).index("by_user", ["userId"]),

    // ---------------------------------------------------------------------
    // Gate (v2.0) — terminal operator + subscriber access management
    // ---------------------------------------------------------------------

    // Terminal operator profile — email + passphrase. Both are never stored
    // in clear: AES-256-GCM ciphertext produced by convex/encryption.ts, plus
    // a one-way SHA-256 hash of the email so the signed-in user can be
    // verified against it server-side without ever exposing the address.
    // The operator email is hidden from everyone and only revealed after a
    // one-time code emailed to it is verified (short visible window).
    //
    // altEmailCipher / altEmailHash — the ALTERNATIVE operator default email
    // (akimprinciples@yahoo.com), encrypted and hashed exactly like the
    // primary. It works identically: every operator notification (subscriber
    // info + unique passcodes, payment receipts, other messages, desktop
    // activation passwords, one-time codes) is delivered to the operator's
    // default inboxes, and the alternative address is a valid operator
    // identity (sign-in, console access, no-password desktop downloads).
    //
    // deliveryPref — which channel(s) receive incoming messages (from
    // subscribers and from the operator's own actions): "all" (both emails +
    // WhatsApp, the default), "primary" (primary email only), "secondary"
    // (alternative email only) or "whatsapp" (WhatsApp chat link only).
    // Enforced centrally by scheduleOperatorMail + scheduleWhatsAppMirror.
    operatorConfig: defineTable({
      email: v.optional(v.string()), // legacy plaintext (pre-encryption rows only)
      emailCipher: v.optional(v.string()),
      emailHash: v.optional(v.string()),
      altEmail: v.optional(v.string()), // legacy plaintext (pre-encryption rows only)
      altEmailCipher: v.optional(v.string()),
      altEmailHash: v.optional(v.string()),
      passphraseCipher: v.string(),
      passphraseUpdatedAt: v.number(),
      guestPassphraseCipher: v.optional(v.string()),
      deliveryPref: v.optional(
        v.union(
          v.literal("all"),
          v.literal("primary"),
          v.literal("secondary"),
          v.literal("whatsapp"),
        ),
      ),
      // Guest passcode mode: "popup" = code displayed in popup (default),
      // "email" = code sent via email (old method).
      guestPasscodeMode: v.optional(
        v.union(v.literal("popup"), v.literal("email")),
      ),
      // Encrypted persistent guest passcode for "popup" mode — stored AES-256-GCM.
      guestPasscodeCipher: v.optional(v.string()),
      // FlashBolt Trade — operator-managed deposit details, keyed by asset
      // symbol. Crypto: receiving address (+ optional network note). Cash:
      // bank account / mobile-money number + instructions. Set from the
      // Operator Console; served to the Trade terminal's deposit modal.
      tradeDepositDetails: v.optional(v.record(v.string(), v.string())),
    }).index("by_email", ["email"]),

    // Server-side AES key for operatorConfig ciphertext. Generated once and
    // stored server-side only; never returned by any query or mutation.
    gateKeys: defineTable({
      key: v.string(),
    }),

    // Dynamic one-time codes emailed to the operator for email/passphrase
    // reveal/change (the "visible" / "change" buttons). verifiedAt records
    // when the code was entered so the short visible/editable windows can be
    // enforced server-side on update.
    operatorCodes: defineTable({
      // "guest" — the fresh periodic code emailed to the operator default
      // address on every "Continue as Guest" click (auth page + desktop apps
      // popup); it must be verified before the guest session / downloads open.
      // "whatsapp-reveal" / "whatsapp-edit" — one-time codes emailed to the
      // operator to view (short visible window) or edit+save (short editable
      // window) the encrypted WhatsApp chat link in the operator console.
      purpose: v.union(
        v.literal("reveal"),
        v.literal("change"),
        v.literal("guest"),
        v.literal("guest-passcode"),
        v.literal("guest-passcode-reset"),
        v.literal("whatsapp-reveal"),
        v.literal("whatsapp-edit"),
        v.literal("sign-in-otp"),
        v.literal("forgot-passcode-otp"),
        v.literal("forgot-passcode-session"),
      ),
      email: v.string(),
      code: v.string(),
      expiresAt: v.number(),
      used: v.boolean(),
      createdAt: v.number(),
      verifiedAt: v.optional(v.number()),
    }).index("by_email", ["email"]),

    // Subscriber passcodes — one per email, per-subscriber expiry window
    // (72 hours by default), blockable by the terminal operator. Passcodes are
    // stored AES-256-GCM encrypted (passcodeCipher) so they are completely
    // hidden until the operator confirms payment and triggers "send"; the
    // plaintext never reaches the frontend. activatedAt is set the first time
    // the passcode is used to open the landing page — after that the email
    // can never generate another passcode.
    subscribers: defineTable({
      email: v.string(),
      fullName: v.string(),
      location: v.string(),
      subject: v.union(v.literal("request"), v.literal("send"), v.literal("other")),
      message: v.string(),
      file: v.optional(v.string()),
      fileName: v.optional(v.string()),
      passcode: v.optional(v.string()), // legacy plaintext (pre-encryption rows)
      passcodeCipher: v.optional(v.string()),
      // payment receipt lifecycle for "Send a passcode" submissions
      paymentStatus: v.optional(
        v.union(v.literal("awaiting"), v.literal("confirmed"), v.literal("rejected")),
      ),
      // first successful subscriber login — permanently marks the passcode
      // as active (no further passcodes can ever be generated for the email)
      activatedAt: v.optional(v.number()),
      status: v.union(
        v.literal("active"),
        v.literal("blocked"),
        v.literal("expired"),
      ),
      expiresAt: v.number(),
      // per-subscriber expiry window in hours (default 72) — the terminal
      // operator can set a custom window per subscriber from the console
      expiryHours: v.optional(v.number()),
      createdAt: v.number(),
      lastSentAt: v.optional(v.number()),
      notifyNote: v.optional(v.string()),
      // --- Permit code (unique access gate) ---
      // Auto-generated alongside the passcode on "Request a passcode".
      // The subscriber uses this code to unlock the landing page.
      permitCode: v.optional(v.string()), // legacy plaintext
      permitCodeCipher: v.optional(v.string()), // AES-256-GCM encrypted
      permitCodeExpiry: v.optional(v.number()), // when the permit code expires (epoch ms)

      // --- Subscription plan (operator-controlled duration) ---
      // "free" = 0 days (no expiry check beyond passcode TTL), other plans
      // set a hard wall-clock expiry after which the subscriber is blocked
      // until they re-subscribe.
      subscriptionPlan: v.optional(
        v.union(
          v.literal("free"),
          v.literal("1month"),
          v.literal("2month"),
          v.literal("3month"),
          v.literal("4month"),
          v.literal("5month"),
          v.literal("6month"),
          v.literal("9month"),
          v.literal("1year"),
        ),
      ),
      subscriptionExpiry: v.optional(v.number()), // epoch ms when plan expires
      // --- Daily flash loan trade limit ---
      dailyTradeLimit: v.optional(v.number()), // operator-set daily cap (default 3)
      dailyTradeCount: v.optional(v.number()), // trades executed today
      dailyTradeDate: v.optional(v.string()), // YYYY-MM-DD of the current counter

      // --- Overlay (userscript / browser extension) access token ---
      // The raw token is stamped into the exported overlay artifacts and
      // presented to /api/overlay/* so the server can enforce THIS
      // subscriber's daily target outside the app (third-party DEX sites
      // have no app session). Stored AES-256-GCM encrypted (issued once,
      // re-exports return the same token so installs never break) with a
      // one-way SHA-256 hash for the gate's index lookup — never plaintext.
      overlayTokenCipher: v.optional(v.string()),
      overlayTokenHash: v.optional(v.string()),

      // per-subscriber in-app alert preferences (bell only — the Telegram
      // channel is operator-managed and never gated by these)
      alertPrefs: v.optional(
        v.object({
          marketNews: v.boolean(),
          sessionAlerts: v.boolean(),
          honeyPot: v.boolean(),
          earnings: v.boolean(),
        }),
      ),
    })
      .index("by_email", ["email"])
      .index("by_overlay_token", ["overlayTokenHash"]),

    // Immutable audit trail for gate actions (operator + subscriber events).
    auditLogs: defineTable({
      actor: v.string(),
      action: v.string(),
      target: v.string(),
      description: v.string(),
      ts: v.number(),
    }).index("by_ts", ["ts"]),

    // Cartesia voice cache — one row per unique (voice + script). The
    // generated audio bytes live in Convex file storage (storageId) and every
    // replay serves the stored file, so the Cartesia free-plan quota is never
    // consumed twice for the same narration.
    ttsCache: defineTable({
      key: v.string(), // sha256(voice | text) — content-addressed
      storageId: v.id("_storage"),
      text: v.string(),
      createdAt: v.number(),
    }).index("by_key", ["key"]),

    // Server-side rate limiting — one row per fixed-window bucket. The
    // installed Convex build exposes no ctx.rateLimit API, so this honest
    // table-backed limiter (see rateLimit.ts) throttles sensitive mutations
    // (operator/subscriber sign-ins, passcode requests, sends, activations)
    // with real backend-enforced windows — never simulated.
    rateLimits: defineTable({
      bucket: v.string(), // e.g. "subscriber-login:user@example.com"
      windowStart: v.number(), // epoch ms the current window began
      count: v.number(), // calls consumed in the current window
      limit: v.number(), // max calls allowed per window (for console display)
      windowMs: v.number(), // window duration in ms (for console display)
    }).index("by_bucket", ["bucket"]),

    // Real market-news cache — RSS headlines fetched by the news action
    // (CoinDesk / CoinTelegraph / Decrypt) and re-used for a short TTL so
    // the public feeds are polled sparingly. Items are real published
    // headlines; nothing here is generated or simulated.
    newsCache: defineTable({
      key: v.string(), // single row: "market-news"
      fetchedAt: v.number(),
      items: v.array(
        v.object({
          source: v.string(),
          title: v.string(),
          link: v.string(),
          pubDate: v.string(),
          summary: v.string(),
        }),
      ),
    }).index("by_key", ["key"]),

    // Operator-tunable terminal settings — a single "default" row holding
    // the honeypot scanner thresholds, the market-news high-signal watchlist
    // keywords and per-session window overrides (UTC minutes-of-day). The
    // frontend strips and the backend signal/news engines all read this row;
    // when it is missing every consumer falls back to the documented
    // defaults. Editable ONLY by the terminal operator from the console.
    terminalConfig: defineTable({
      key: v.string(), // "default" — single row
      honeyMinProfitPct: v.number(),
      honeyMinLiquidityUsd: v.number(),
      newsKeywords: v.array(v.string()),
      sessionOverrides: v.optional(
        v.record(
          v.string(),
          v.object({ openMin: v.number(), closeMin: v.number() }),
        ),
      ),
      updatedAt: v.number(),
      // MATERIALIZED FleetMetrics snapshot (JSON) + fetch time — written by
      // the fleet-metrics-refresh cron, served by signals.collectMetrics.
      // Cache-only: updateTerminalConfig never touches these fields.
      fleetMetrics: v.optional(v.string()),
      fleetMetricsAt: v.optional(v.number()),
    }).index("by_key", ["key"]),

    // ── Operator git sync — in-app repository status + instant redeploys ──
    // One "default" row. The repository access token is stored AES-GCM
    // encrypted (encryption.ts) and NEVER returned to any client — only the
    // last-4 hint is readable. hooks maps a provider slug ("vercel",
    // "netlify", "render", "cloudflare") to that platform's own build/deploy
    // webhook URL; syncNow POSTs to every configured hook (real HTTP, real
    // status codes) and reads the repository's actual latest commit — nothing
    // here is ever simulated.
    gitSyncConfig: defineTable({
      key: v.string(), // "default" — single row
      repo: v.optional(v.string()), // "owner/name"
      branch: v.optional(v.string()), // "main"
      tokenCipher: v.optional(v.string()),
      tokenHint: v.optional(v.string()),
      tokenSetAt: v.optional(v.number()),
      hooks: v.optional(v.record(v.string(), v.string())),
      // Stamped by syncNow after a real run (commit + per-provider verdicts).
      lastSyncAt: v.optional(v.number()),
      lastSync: v.optional(v.string()), // JSON snapshot of the last run
      lastCommitSha: v.optional(v.string()),
      lastCommitMessage: v.optional(v.string()),
      lastCommitAuthor: v.optional(v.string()),
      lastCommitAt: v.optional(v.number()),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),

    // WhatsApp community channel — a single "default" row holding the
    // channel link served by getWhatsAppChannel. The link is stored in the
    // backend (never hardcoded in the frontend) and the WhatsApp button on
    // every page opens it. `fallbackUrl` is the alternative link the backend
    // considers when the primary link fails its real reachability check.
    // Only the terminal operator can change either value.
    whatsappConfig: defineTable({
      key: v.string(), // "default" — single row
      url: v.string(),
      fallbackUrl: v.optional(v.string()),
      // WhatsApp number (E.164) that receives subscriber messages — the
      // operator's second default inbox alongside the operator email. Stored
      // in the backend and used to build the real wa.me click-to-chat link
      // subscribers use to send pass-code / activation-password requests.
      supportNumber: v.optional(v.string()),
      // The operator's WhatsApp chat link (wa.me/message/...) — the second
      // default destination for subscriber information (full name, location,
      // subject line, message, payment receipts) plus generated unique pass
      // codes and desktop activation passwords. Stored AES-256-GCM encrypted
      // (chatLinkCipher); the plaintext is never returned by any query — it
      // is only revealed inside the operator console for a short window after
      // a one-time emailed code is verified (visible / edit / save).
      chatLinkCipher: v.optional(v.string()),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),

    // Real-time Telegram session signals — one row per signal sent to the
    // channel (every 15 minutes via cron, or on demand by the operator). Each
    // row carries the structured dashboard snapshot (market session, AI
    // market score, core-network status, operating metrics) so the Signals
    // page can render the exact state the channel received. Every number is
    // computed from real live data — never simulated.
    // ---------------------------------------------------------------------
    // Desktop app activation licenses (v2.2) — Linux / macOS / Windows
    // ---------------------------------------------------------------------
    // One encrypted activation password per (subscriber email, operating
    // system), generated server-side and emailed ONLY to the terminal
    // operator. Only emails already registered as subscribers (stored in the
    // backend) are recognized here — licenses can never be issued to an
    // arbitrary address. The plaintext is never exposed by any query; the
    // operator reveals/changes it through the console with a one-time code
    // emailed to the operator address (short 10-second visible window), and
    // every other lifecycle action (send / update / block / unblock /
    // delete) is operator-gated.
    //
    // Expiry rule: any new password (generated / changed / updated) that is
    // NOT used to activate the desktop app within 72 hours is auto-expired by
    // a daily cron. The moment a password activates the app even once within
    // the window it becomes permanently active for re-use / re-run.
    activationLicenses: defineTable({
      email: v.string(), // the subscriber email this license belongs to
      os: v.union(v.literal("linux"), v.literal("macos"), v.literal("windows")),
      passwordCipher: v.string(), // AES-256-GCM — never returned to the client
      status: v.union(v.literal("active"), v.literal("blocked"), v.literal("expired")),
      activationCount: v.number(), // 0 until the password is used once
      lastActivatedAt: v.optional(v.number()),
      rotatedAt: v.number(), // last password generation / change / update
      expiresAt: v.number(), // rotatedAt + 72h — enforced only pre-first-activation
      createdAt: v.number(),
      updatedAt: v.number(),
      // one-time change-code state (10-second visible/editable window)
      changeCodeCipher: v.optional(v.string()),
      changeCodeExpiresAt: v.optional(v.number()),
      changeVerifiedAt: v.optional(v.number()),
      changeRevealExpiresAt: v.optional(v.number()),
    }).index("by_email_os", ["email", "os"]),

    // Operator sign-in emails — the terminal operator can sign up on the auth
    // page with any different email address freely (no pass codes). Each email
    // is stored in the backend and carries the full lifecycle controls
    // (block / unblock / delete / change / update) from the operator console.
    // The passwordCipher holds the internal account credential used by the
    // email-only "operator-email" auth provider — the operator never types or
    // sees a passcode; the app signs in with it in the background.
    operatorEmails: defineTable({
      email: v.string(),
      status: v.union(v.literal("active"), v.literal("blocked")),
      passwordCipher: v.string(), // internal credential (AES-256-GCM)
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_email", ["email"]),

    telegramSignals: defineTable({
      kind: v.union(v.literal("session_open"), v.literal("session_update")),
      session: v.string(),
      sessionLabel: v.string(),
      title: v.string(),
      body: v.string(),
      score: v.number(),
      sentAt: v.number(),
      delivered: v.boolean(),
      deliveryNote: v.optional(v.string()),
      // structured live-market snapshot behind the score
      market: v.object({
        routeCount: v.number(),
        avgEdgePct: v.number(),
        liquidityUsd: v.number(),
        volumeUsd: v.number(),
        gasGwei: v.number(),
        dispersionPct: v.number(),
      }),
      // fleet-wide operating metrics at signal time
      metrics: v.object({
        activeTerminals: v.number(),
        runningBots: v.number(),
        executionsToday: v.number(),
        successesToday: v.number(),
        lifetimePnl: v.number(),
        openOpportunities: v.number(),
        scansToday: v.number(),
        networks: v.object({ mainnet: v.number(), testnet: v.number() }),
        chains: v.array(v.string()),
      }),
    }).index("by_ts", ["sentAt"]),

    // ── FlashBolt Telegram Bot — the operator-only mirror of the app ──
    // Chats that completed the secure pairing (their pairing code matches a
    // code issued inside the authenticated operator session). Bot identity
    // is authoritative: chatId comes from the verified Telegram update, never
    // from user-typed input, and unlinked chats are refused every command
    // except /start /pair /help.
    telegramBotChats: defineTable({
      chatId: v.string(), // Telegram chat id (string form)
      title: v.optional(v.string()), // chat title / first name (display only)
      username: v.optional(v.string()), // @username when public
      linkedAt: v.number(),
      lastSeenAt: v.number(),
      lastCommand: v.optional(v.string()),
      // Per-chain stamp of the last ACCEPTED manual scan (/bnb_scan,
      // /sol_scan). The claim mutation is atomic on this document, so two taps
      // cannot both scan; 0 means "no cooldown" (a released claim).
      lastBnbScanAt: v.optional(v.number()),
      lastSolScanAt: v.optional(v.number()),
      // per-chat UI preference: silent (no sound) vs normal notifications
      silent: v.boolean(),
      blocked: v.boolean(), // operator can remotely disable a chat
    })
      .index("by_chat", ["chatId"])
      .index("by_last_seen", ["lastSeenAt"]),

    // Bot config — single "default" row. The pairing code is issued by the
    // authenticated operator session (web side) and shown ONLY there; the
    // bot verifies the user-typed code against it. Rotating invalidates the
    // old code. webhookSecret is a random value Convex stamps as the
    // X-Telegram-Bot-Api-Secret-Token header check on every update.
    telegramBotConfig: defineTable({
      key: v.string(), // "default" — single row
      pairingCode: v.optional(v.string()),
      pairingExpiresAt: v.optional(v.number()),
      webhookSecret: v.string(),
      // UI prefs the operator can flip from the bot itself
      digestEnabled: v.boolean(),
      alertFanout: v.boolean(), // mirror trade alerts to linked chats
      soundAlerts: v.boolean(), // disable_notification=false when true
      // Live webhook health, stamped by the self-healing sweep (cron every
      // 10 min + every dialog auto-connect). Drives the header status chip.
      webhookOk: v.optional(v.boolean()),
      webhookCheckedAt: v.optional(v.number()),
      // Single-operator policy switch: plain /start auto-pairs the chat and
      // boots the full console (default ON). Set false to require the
      // app-issued pairing code again.
      autoPairOnStart: v.optional(v.boolean()),
      // Cached @username from Telegram getMe — lets the account menu deep-link
      // straight into Web Telegram instantly (no round-trip before opening).
      // Stamped by auto-connect, webhook registration and the self-heal cron.
      botUsername: v.optional(v.string()),
      // Operator-supplied bot token from the console's Telegram Bot panel —
      // encrypted AT REST with the project AES-GCM secret key (encryption.ts,
      // server-held key in gateKeys/env). Never returned to any client: only
      // the last-4 hint below is readable. When set it takes priority over
      // the deployment env fallback.
      botTokenEnc: v.optional(v.string()),
      botTokenHint: v.optional(v.string()),
      botTokenSetAt: v.optional(v.number()),
      // When Telegram's setMyCommands menu was last pushed (weekly gate;
      // cleared on token save so the new bot gets its own command menu).
      commandsPushedAt: v.optional(v.number()),
      // Version of the command SPECS that was pushed. The */10 self-heal
      // re-pushes when this is behind, so a newly added command appears in
      // Telegram's native menu within one sweep (not up to a week later).
      commandsVersion: v.optional(v.number()),
      // Auto-purge (default ON): tracked bot messages older than
      // BOT_MESSAGE_TTL_MS (10 min) are deleted by the */10 sweep. Optional so
      // an existing row keeps working — `!== false` is the default.
      autoPurge: v.optional(v.boolean()),
      // Channel purge scope (default ON, independent of autoPurge): channel
      // posts older than the TTL are deleted by the same sweep. Kept separate
      // because the channel is a feed the operator may want to keep, and a
      // chat-scoped `/purge` must never decide that for it.
      channelPurge: v.optional(v.boolean()),
      // Last purge sweep's honest tally, stamped by the `telegram-bot-purge`
      // cron and surfaced on `/alerts`, the bot panel and the header chip.
      // Optional so an existing row keeps working: absent = "not reported
      // yet", never "0 deleted". Only the sweep writes these.
      purgeLastAt: v.optional(v.number()),
      purgeLastDeleted: v.optional(v.number()),
      purgeLastFailed: v.optional(v.number()),
      // The part of purgeLastFailed whose row survived and will be retried on
      // the next sweep (a transient refusal: rights, kicked bot, 429, 5xx,
      // network). Absent on a tally stamped before round 31 = 0.
      purgeLastRetrying: v.optional(v.number()),
      // Rows in scope the automatic sweep has stopped retrying (budget spent or
      // hopeless chat). A STANDING count: the tally names them until the rows
      // leave, instead of letting `failed - retrying` imply a permanent refusal.
      purgeLastAbandoned: v.optional(v.number()),
      purgeLastSkipped: v.optional(v.string()),
      // When a sweep-fault alert was last sent, so a persisting fault repeats
      // hourly instead of every sweep. Cleared by the first clean sweep.
      purgeAlertedAt: v.optional(v.number()),
      // How many alerts this fault has sent (1..PURGE_ALERT_CAP). At the cap the
      // sweep stops alerting altogether instead of pinging forever; the tally
      // keeps being stamped, so /alerts still shows the live failure.
      purgeAlertsSent: v.optional(v.number()),
      // When the current fault began (the first failing sweep), for the
      // "failing for 2h 10m" wording on repeats. Cleared with the rest.
      purgeFaultSince: v.optional(v.number()),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),

    // Every message the bot posted to a paired chat or to the channel, with
    // its real Telegram message id, so the 10-minute purge can delete it.
    // Rows leave the table when the message is deleted (or when the delete is
    // attempted and refused — the Bot API will not delete older messages).
    telegramBotMessages: defineTable({
      chatId: v.string(),
      messageId: v.number(),
      source: v.union(v.literal("bot"), v.literal("channel")),
      sentAt: v.number(),
      // Transient refusals counted against PURGE_RETRY_CAP. Absent = 0, so the
      // rows already tracked when the budget landed simply start at zero.
      attempts: v.optional(v.number()),
      // The automatic sweep has stopped retrying this row: the budget is spent,
      // or Telegram called the chat hopeless. The row is KEPT (the message is
      // still in the chat) so /purge can still delete it by hand; the 48 h
      // tracking-row retention eventually removes it otherwise.
      abandoned: v.optional(v.boolean()),
      // Which verdict abandoned it. A listing says "chat unreachable" or
      // "36/36 attempts", so the operator knows whether to fix the chat first.
      abandonedReason: v.optional(v.union(v.literal("exhausted"), v.literal("hopeless"))),
    })
      .index("by_sent", ["sentAt"])
      .index("by_chat", ["chatId"])
      // Counting the standing abandoned backlog without a table scan: this
      // walks only the marked rows instead of every tracked message.
      .index("by_abandoned", ["abandoned", "sentAt"]),

    // Server-issued device trust (v2.5): after a REAL server-side
    // verification (guest access code or operator email OTP) the server mints
    // a 256-bit bearer token for this browser and stores ONLY its SHA-256
    // hash. Later sessions on the same device send the token with bot
    // requests; a hash match proves the device completed a real verification
    // — the amber "Session not recognized" banner can never reappear on a
    // verified device. Raw tokens are never persisted; rows expire after 180
    // days (re-verification re-issues).
    operatorDeviceTrust: defineTable({
      userId: v.id("users"),
      tokenHash: v.string(), // sha256 of the raw bearer token — raw never stored
      verifiedKind: v.union(v.literal("guest-code"), v.literal("operator-otp")),
      email: v.optional(v.string()),
      createdAt: v.number(),
      lastVerifiedAt: v.number(),
      expiresAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_hash", ["tokenHash"]),

    // Copier bot — profitable token signals copied from Telegram channels
    // (t.me/AveSignalMonitor by default). Messages are pulled from the
    // channels' public web previews (t.me/s/<channel>), parsed into token
    // signals and gated, then served to the Sniper terminal and the
    // DEXView/GMGN/Ave overlay's LIVE CANDIDATES through the public
    // /api/copier/signals endpoint for sub-millisecond manual/auto sniping.
    copierSignals: defineTable({
      id: v.string(), // dedupe key: source + " : " + address
      source: v.string(),
      sourceLabel: v.string(),
      address: v.string(),
      symbol: v.string(),
      name: v.string(),
      chain: v.string(),
      priceUsd: v.number(),
      liquidityUsd: v.number(),
      marketCapUsd: v.number(),
      postedAt: v.number(),
      capturedAt: v.number(),
      buyable: v.boolean(),
      excerpt: v.string(),
    })
      .index("by_key", ["id"])
      .index("by_capturedAt", ["capturedAt"]),

    // Trade notification settings — per-user sound + push preferences.
    // Controls whether flash-loan trade notifications play sounds and/or
    // send browser push notifications. Defaults to both ON.
    tradeNotificationSettings: defineTable({
      userId: v.id("users"),
      soundEnabled: v.boolean(),
      pushEnabled: v.boolean(),
    }).index("by_user", ["userId"]),

    // ── FlashBolt Trade — exchange terminal ledger ──
    // Per-user, per-market balances. kind: "crypto" = on-chain assets,
    // "cash" = NGN cash ledger. available is spendable; locked is held by
    // open orders / pending withdrawals.
    tradeBalances: defineTable({
      userId: v.id("users"),
      kind: v.union(v.literal("crypto"), v.literal("cash")),
      asset: v.string(), // "BTC", "ETH", "USDT", "NGN", ...
      available: v.number(),
      locked: v.number(),
      updatedAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_user_asset", ["userId", "kind", "asset"]),

    // Trade transaction history (deposits, withdrawals, swaps, transfers,
    // interest). status: pending items await operator settlement (cash
    // bank-transfer requests, crypto deposits awaiting confirmations).
    tradeTx: defineTable({
      userId: v.id("users"),
      kind: v.union(
        v.literal("cash"),
        v.literal("crypto"),
        v.literal("internal"),
      ),
      direction: v.union(
        v.literal("deposit"),
        v.literal("withdrawal"),
        v.literal("swap"),
        v.literal("interest"),
        v.literal("transfer_in"),
        v.literal("transfer_out"),
      ),
      asset: v.string(),
      amount: v.number(), // positive number; direction carries the sign
      status: v.union(
        v.literal("pending"),
        v.literal("completed"),
        v.literal("failed"),
      ),
      ts: v.number(),
      ref: v.string(), // unique reference (FB-…)
      note: v.optional(v.string()),
      meta: v.optional(v.string()), // JSON payload (rate, counterparty…)
    })
      .index("by_user_ts", ["userId", "ts"])
      .index("by_ref", ["ref"])
      .index("by_status", ["status"]),

    // Limit orders (Order Book). Marketable orders are filled by the
    // order-scan cron when the live market price crosses the limit.
    tradeOrders: defineTable({
      userId: v.id("users"),
      side: v.union(v.literal("buy"), v.literal("sell")),
      base: v.string(),
      quote: v.string(),
      price: v.number(), // limit price in quote units per base
      amount: v.number(), // base amount
      filled: v.number(), // base amount filled so far
      status: v.union(
        v.literal("open"),
        v.literal("filled"),
        v.literal("canceled"),
      ),
      ts: v.number(),
    })
      .index("by_user_ts", ["userId", "ts"])
      .index("by_open", ["status"]),

    // Earn plans — Flexible (4.5% APY, withdraw anytime, daily payouts)
    // and Fixed (7% APY, locked 60–365 days, paid at maturity).
    tradeEarnPlans: defineTable({
      userId: v.id("users"),
      kind: v.union(v.literal("flexible"), v.literal("fixed")),
      asset: v.string(),
      principal: v.number(),
      apyPct: v.number(),
      startedAt: v.number(),
      endsAt: v.optional(v.number()), // fixed plans only
      lastAccrualAt: v.number(),
      accrued: v.number(),
      status: v.union(v.literal("active"), v.literal("closed")),
    })
      .index("by_user", ["userId"])
      // Cron accrual pass reads ONLY active plans (was: full-table collect
      // every pass — closed plans dominated the scan).
      .index("by_status", ["status"]),

    // Favorite pairs (Markets ⭐) per user.
    tradeFavorites: defineTable({
      userId: v.id("users"),
      pair: v.string(), // "BTC/USDT"
      ts: v.number(),
    }).index("by_user", ["userId"]),

    // Cached live market prices for the Trade terminal. data = JSON map
    // { asset: { usd, ngn } }. Refreshed by ensurePrices (60s TTL).
    tradePriceCache: defineTable({
      key: v.string(), // "trade.prices"
      data: v.string(),
      ts: v.number(),
    }).index("by_key", ["key"]),

    // Operator-entered proof of cash deposit (bank/mobile-money reference).
    // Creates a pending tradeTx; the operator verifies against the real
    // bank statement and settles or rejects from the console.
    tradeDepositClaims: defineTable({
      userId: v.id("users"),
      asset: v.string(), // cash currency
      amount: v.number(),
      method: v.union(v.literal("bank_transfer"), v.literal("mobile_money")),
      senderName: v.string(),
      reference: v.string(),
      status: v.union(v.literal("pending"), v.literal("verified"), v.literal("rejected")),
      ts: v.number(),
    }).index("by_status", ["status"]),

    // Cryptographically-verified deposit address bindings. A user proves
    // control of their own address by signing a server challenge (EVM
    // EIP-191 recovery or Solana ed25519). The signature itself is kept for
    // audit; verification happens BEFORE the row is written.
    tradeDepositAddresses: defineTable({
      userId: v.id("users"),
      asset: v.string(),
      netId: v.string(), // "ERC20" | "BEP20" | "TRC20" | "SOL" | "BTC" | …
      address: v.string(),
      mode: v.union(v.literal("personal"), v.literal("derived")),
      // personal: sig-verified user wallet. derived: watch-only xpub child.
      derivationIndex: v.optional(v.number()), // derived only
      challengeNonce: v.optional(v.string()), // personal only
      signature: v.optional(v.string()), // personal only (audit)
      active: v.boolean(),
      ts: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_address", ["address"])
      .index("by_active", ["active"]),

    // Auto-detected on-chain deposits, idempotent per (txHash, logIndex).
    // A row exists ONLY when the chain observation was confirmed server-
    // side; the ledger credit runs exactly once per row.
    tradeChainDeposits: defineTable({
      userId: v.id("users"),
      asset: v.string(),
      netId: v.string(),
      txHash: v.string(),
      logIndex: v.number(), // 0 for native transfers
      address: v.string(), // receiving account that matched
      amount: v.number(), // real decimal amount from the chain
      confirmations: v.number(),
      credited: v.boolean(),
      ts: v.number(),
    })
      .index("by_tx", ["txHash", "logIndex"])
      .index("by_user", ["userId"]),

    // Dynamic cash receiving accounts (bank / mobile-money) per currency.
    // The operator publishes the REAL account users pay into; rotation
    // deactivates (never deletes) the old row so historical deposit
    // claims always keep pointing at the account they were actually paid
    // into. Only ONE active account per currency is shown to users at a
    // time — like a real exchange's rotating bank rails.
    tradeCashAccounts: defineTable({
      asset: v.string(), // NGN | GHS | KES | XAF (bank rails)
      details: v.string(), // account number · bank · name (free text)
      method: v.union(v.literal("bank_transfer"), v.literal("mobile_money")),
      active: v.boolean(),
      rotatedAt: v.optional(v.number()), // set when deactivated by rotation
      ts: v.number(),
    })
      .index("by_asset_active", ["asset", "active"]),

    // Kora Pay QUI-CHKOUT auto-deposits (bank rails: NGN / GHS / KES / XAF).
    // One row per initialized checkout. The user is redirected to Kora's
    // hosted checkout, which generates a ONE-TIME virtual bank account
    // (e.g. Sterling Bank · Korapay-QUI-CHKOUT) that accepts exactly ONE
    // transfer of EXACTLY the requested amount, then expires. When Kora
    // confirms the payment (charge.success webhook, HMAC-verified), the
    // user's cash ledger is credited automatically — no manual claim.
    tradeKoraDeposits: defineTable({
      userId: v.id("users"),
      reference: v.string(), // our unique merchant reference (FB-KORA-…)
      asset: v.string(), // NGN | GHS | KES | XAF
      amount: v.number(), // exact amount sent to checkout (major units)
      status: v.union(
        v.literal("pending"),
        v.literal("success"),
        v.literal("failed"),
        v.literal("expired"),
      ),
      checkoutUrl: v.string(), // Kora hosted checkout URL
      credited: v.boolean(), // ledger credit completed exactly once
      koraStatus: v.optional(v.string()), // last status seen from Kora
      koraFee: v.optional(v.number()), // fee reported by Kora
      failureReason: v.optional(v.string()),
      ts: v.number(),
      settledAt: v.optional(v.number()),
    })
      .index("by_reference", ["reference"])
      .index("by_user", ["userId"]),

    // ── Chain activation ────────────────────────────────────────────────
    // Authorization decisions, kept separate from technical validation.
    // A row here is what lets a chain sign live — never a frontend flag, an
    // armed contract, or a browser-stored value. Rows are written ONLY by
    // operator-gated mutations in ./chainActivations.ts.
    chainActivations: defineTable({
      chainId: v.number(),
      /** mainnet | testnet */
      environment: v.string(),
      /** live-signing (the only scope implemented; withdrawals are separate) */
      scope: v.string(),
      /** PENDING | ACTIVE | SUSPENDED | REVOKED | EXPIRED */
      status: v.string(),
      /** Operator identity that created the request. */
      operatorId: v.string(),
      /** Operator identity that approved the current term. */
      approvedBy: v.optional(v.string()),
      evidenceRefs: v.array(v.string()),
      validationSnapshotId: v.optional(v.id("chainValidationSnapshots")),
      /** Executor contract approved for live signing (bytecode-pinned when set). */
      contractAddress: v.optional(v.string()),
      contractCodeHash: v.optional(v.string()),
      /**
       * The exact server observation this approval's hash came from. The pin
       * mutations copy these from the `executorCodeInspections` row they
       * accepted, so an approval can be traced back to evidence the backend
       * read itself — bytes, host and time — and the referenced row is kept by
       * `pruneInspectionEvidence` so that pointer never dangles.
       */
      contractCodeInspectionId: v.optional(v.id("executorCodeInspections")),
      contractCodeInspectedAt: v.optional(v.number()),
      contractCodeRpcHost: v.optional(v.string()),
      activatedAt: v.optional(v.number()),
      /** Hard expiry. An ACTIVE row past this instant is treated as EXPIRED. */
      expiresAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
      revocationReason: v.optional(v.string()),
      supersededBy: v.optional(v.id("chainActivations")),
    })
      .index("by_chain", ["chainId", "environment"])
      .index("by_status", ["status"]),

    // Technical evidence: what was actually checked, and what could not be.
    // A snapshot never authorizes anything on its own — approval points at it.
    chainValidationSnapshots: defineTable({
      chainId: v.number(),
      environment: v.string(),
      createdAt: v.number(),
      createdBy: v.string(),
      softwareVersion: v.string(),
      /** [{ id, ok, detail }] — one entry per check performed. */
      checks: v.array(v.object({ id: v.string(), ok: v.boolean(), detail: v.string() })),
      /** Checks that could NOT be performed (missing sources, no key, …). */
      unverified: v.array(v.string()),
      contractAddress: v.optional(v.string()),
      contractCodeHash: v.optional(v.string()),
      rpcEndpoints: v.array(v.string()),
    }).index("by_chain_created", ["chainId", "createdAt"]),

    /**
     * What the BACKEND read from chain when it inspected an executor. Written
     * only by the `inspectExecutorCode` action (via an internal mutation), and
     * required by both pin mutations — a hash the server never observed cannot
     * become an approval.
     */
    executorCodeInspections: defineTable({
      activationId: v.id("chainActivations"),
      chainId: v.number(),
      address: v.string(),
      codeHash: v.string(),
      bytes: v.number(),
      /** Host of the RPC that answered (no path/keys). */
      rpcHost: v.string(),
      actorId: v.string(),
      userId: v.id("users"),
      inspectedAt: v.number(),
    })
      .index("by_chain_address", ["chainId", "address", "inspectedAt"])
      .index("by_actor", ["actorId", "inspectedAt"])
      // Global oldest-first sweep for the `inspection-evidence-prune` cron.
      .index("by_inspected_at", ["inspectedAt"]),

    // Append-only history. There is deliberately no mutation that edits or
    // deletes a row here — approval history cannot be rewritten in place.
    chainActivationAudit: defineTable({
      activationId: v.id("chainActivations"),
      chainId: v.number(),
      /** Operator identity (or "expiry" for the derived status). */
      actorId: v.string(),
      /** created | approved | renewed | suspended | revoked | superseded */
      action: v.string(),
      previousStatus: v.optional(v.string()),
      newStatus: v.string(),
      reason: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_activation", ["activationId", "createdAt"])
      .index("by_chain", ["chainId", "createdAt"]),

    // ── Validated discovery registry ────────────────────────────────────
    // The backend is authoritative for which RPC endpoints and which
    // addresses (router, factory, token, pool, executor) may be used. Browser
    // storage caches these rows for display; it never establishes trust.

    // Every endpoint this deployment knows about, with the verdict from a
    // SERVER-side probe. Only VALIDATED + unexpired rows are usable.
    rpcEndpoints: defineTable({
      chainId: v.number(),
      url: v.string(),
      /** stored | discovered | operator — where the candidate came from */
      origin: v.string(),
      /** VALIDATED | REJECTED */
      status: v.string(),
      latencyMs: v.optional(v.number()),
      headBlock: v.optional(v.number()),
      checkedAt: v.number(),
      expiresAt: v.number(),
      validatedBy: v.string(),
      lastError: v.optional(v.string()),
    })
      .index("by_chain_status", ["chainId", "status"])
      .index("by_url", ["url"]),

    // Approved addresses. `checks` is the evidence that was actually run;
    // expiry and revocation are enforced on read, like chain activations.
    discoveryRecords: defineTable({
      chainId: v.number(),
      /** router | factory | token | pool | executor */
      kind: v.string(),
      address: v.string(),
      label: v.optional(v.string()),
      /** PENDING | VALIDATED | REJECTED | REVOKED */
      status: v.string(),
      /** operator | discovery */
      source: v.string(),
      codeHash: v.optional(v.string()),
      evidenceRefs: v.array(v.string()),
      checks: v.array(v.object({ id: v.string(), ok: v.boolean(), detail: v.string() })),
      registeredBy: v.string(),
      validatedAt: v.optional(v.number()),
      expiresAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
      revocationReason: v.optional(v.string()),
    })
      .index("by_chain_kind", ["chainId", "kind"])
      .index("by_address", ["chainId", "address"]),

    // Server-controlled registry of destinations treated as INTERNAL profit
    // payouts. A destination is internal only because a row here says so —
    // not because it is connected, listed on a card, or equal to the signer.
    internalDestinations: defineTable({
      chainId: v.number(),
      address: v.string(),
      label: v.optional(v.string()),
      enabled: v.boolean(),
      approvedBy: v.string(),
      approvedAt: v.number(),
      disabledAt: v.optional(v.number()),
      reason: v.optional(v.string()),
    })
      .index("by_chain", ["chainId", "enabled"])
      .index("by_address", ["chainId", "address"]),

    // Append-only record of every validation pass (RPC probes, address
    // validation) so "why is this approved?" has an answer.
    validationRuns: defineTable({
      chainId: v.number(),
      /** rpc | discovery */
      scope: v.string(),
      createdAt: v.number(),
      actorId: v.string(),
      summary: v.string(),
      checks: v.array(v.object({ id: v.string(), ok: v.boolean(), detail: v.string() })),
    }).index("by_chain_created", ["chainId", "createdAt"]),

    // Swaps refused by the discovery/validation gate before any transaction
    // was built. Distinct from payoutBlocks (which records payout refusals) so
    // "how often did policy block trading?" is a query, not a log search.
    executionBlocks: defineTable({
      userId: v.id("users"),
      chainId: v.number(),
      /** unvalidated-target (extend as more gates gain typed refusals) */
      code: v.string(),
      reason: v.string(),
      router: v.optional(v.string()),
      token: v.optional(v.string()),
      amountNative: v.number(),
      network: v.optional(v.string()),
      /** First occurrence of this block (minute bucket start). */
      ts: v.number(),
      /**
       * Attempts folded into this row. The same refusal repeating within a
       * minute is one row with hits > 1, so counts measure attempts without
       * one row per evaluation pass. Absent on rows written before dedupe.
       */
      hits: v.optional(v.number()),
      /** Last attempt folded into this row. Windows use this. */
      lastTs: v.optional(v.number()),
      /** code|chainId|token|reason|minute — the dedupe identity. */
      dedupeKey: v.optional(v.string()),
    })
      .index("by_user_ts", ["userId", "ts"])
      .index("by_user_dedupe", ["userId", "dedupeKey"])
      .index("by_code_ts", ["code", "ts"]),

    // Payouts refused by the wallet guard — one row per block, queryable by
    // wallet/level instead of being buried in an execution label.
    payoutBlocks: defineTable({
      userId: v.id("users"),
      /** Address that would have paid out (the signer). */
      wallet: v.string(),
      /** Destination that was refused, when the block came from the payout path. */
      destination: v.optional(v.string()),
      token: v.optional(v.string()),
      spender: v.optional(v.string()),
      allowance: v.optional(v.string()),
      /** critical | high | medium | low — the level that produced the block. */
      level: v.string(),
      /** Finding kinds, e.g. ["drainable-approval"]. */
      kinds: v.array(v.string()),
      reason: v.string(),
      amountNative: v.number(),
      chain: v.optional(v.string()),
      network: v.optional(v.string()),
      ts: v.number(),
    })
      .index("by_user_ts", ["userId", "ts"])
      .index("by_wallet_ts", ["wallet", "ts"]),

  },
  {
    schemaValidation: false,
  },
);

export default schema;
