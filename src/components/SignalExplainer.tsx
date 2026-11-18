import { NarratedExplainer } from "@/components/NarratedExplainer";

/**
 * "Play short video" explainer for the real-time signals dashboard. Uses the
 * same verified narration pipeline as the gate explainer: Cartesia TTS with a
 * content-addressed cache (generated once per script, replays never consume
 * quota) and an honest Web Speech fallback when CARTESIA_API_KEY is not set.
 *
 * Two scripts exist because the two terminals genuinely differ in how their
 * signals reach Telegram:
 *
 *  • BNB FlashBolt — EVM path: eth_call-guarded executions through a
 *    Flashbots-style private relay, alerts denominated in BNB.
 *  • SOL FlashBolt — Solana path: simulateTransaction dry-run gate, Jito
 *    block-engine protected submission with revert protection and a minimum
 *    1,000-lamport tip, alerts denominated in SOL, Raydium/Orca/Meteora/
 *    PumpSwap venue coverage, Phantom/Solflare wallet payouts.
 *
 * Both scripts only describe real implemented behavior. Nothing is simulated.
 */

const SIGNAL_SCRIPT_BNB = [
  "This is the real-time signals dashboard — exactly what your Telegram channel receives.",
  "Every fifteen minutes, the engine computes a fresh market session update.",
  "Sessions follow the standard UTC windows: Sydney, Tokyo, London, and New York.",
  "The AI market score is a zero to one hundred rating built only from live data — cross-DEX price dispersion, route density, average edge, liquidity depth, volume, and the real gas price.",
  "The core network card shows the mainnet and testnet split, the chains being scanned, and how many terminals and bots are running right now.",
  "Operating metrics come from the real execution trail — executions today, win rate, fleet PnL, and open opportunities.",
  "Each dashboard is delivered to the configured Telegram channel through the real Bot API.",
  "On the BNB end, every executed route is first simulated with eth call, then submitted through a Flashbots-style private relay so bundles land protected.",
  "Trade alerts from this terminal are denominated in BNB — for example, plus zero point two five BNB.",
  "The first signal of a session is a session open alert; the rest are session updates scoped to that session window.",
  "Nothing here is simulated — every number comes from the live feed and the real backend.",
];

const SIGNAL_SCRIPT_SOL = [
  "This is the real-time signals dashboard as seen from the SOL FlashBolt terminal — what your Telegram channel receives from the Solana end.",
  "Every fifteen minutes, the engine computes a fresh market session update on the standard UTC windows: Sydney, Tokyo, London, and New York.",
  "The AI market score is a zero to one hundred rating built only from live data — cross-DEX price dispersion, route density, average edge, liquidity depth, and trading volume.",
  "From the Solana end, every execution is recorded with its chain tag and native symbol, so fleet win rate and PnL honestly include SOL terminal activity.",
  "Solana trade alerts reach the same Telegram channel through the same Bot API, but denominated in SOL — plus X SOL — where the BNB terminal reports the same events in BNB.",
  "The difference starts at execution: routes are first dry-run with simulate transaction on the Solana RPC — a failing simulation is dropped before broadcast, so no gas is burned.",
  "Passing routes are submitted through the Jito block engine with revert protection and a minimum one thousand lamport tip, instead of BNB's Flashbots-style private relay.",
  "Opportunities come from Raydium, Orca, Meteora and PumpSwap liquidity, plus Telegram copier signals converted into cross-venue WSOL flash-loan routes.",
  "Gas and the Jito tip are paid from your connected Phantom or Solflare wallet, and profits sweep back to that same wallet inside the atomic transaction.",
  "The core network card lists the Solana terminal's chain alongside BNB as soon as it is active — one fleet, two terminals, one Telegram channel.",
  "Nothing here is simulated — every number comes from the live feed and the real backend.",
];

export function SignalExplainer({ variant = "bnb" }: { variant?: "bnb" | "sol" }) {
  if (variant === "sol") {
    return (
      <NarratedExplainer
        scriptLines={SIGNAL_SCRIPT_SOL}
        title="How signals reach Telegram — SOL FlashBolt end"
        description="Watch a short narrated walkthrough of the Solana signal path — simulateTransaction dry-run gate, Jito block-engine protected submission, SOL-denominated trade alerts, Raydium/Orca/Meteora/PumpSwap coverage, and how it differs from the BNB terminal."
        dialogTitle="The SOL signal path, narrated"
        playLabel="Play explainer"
      />
    );
  }
  return (
    <NarratedExplainer
      scriptLines={SIGNAL_SCRIPT_BNB}
      title="How signals reach Telegram"
      description="Watch a short narrated walkthrough of the signals dashboard — market sessions, the AI market score, core network and operating metrics, and how each update is delivered to the Telegram channel."
      dialogTitle="The signals dashboard, narrated"
      playLabel="Play explainer"
    />
  );
}
