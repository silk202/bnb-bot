import { NarratedExplainer } from "@/components/NarratedExplainer";

export { AvatarFace } from "@/components/NarratedExplainer";

/**
 * "Play short video with a humanistic avatar" explainer for the access gate.
 * Renders an animated talking avatar (blinking eyes, lip-synced mouth, gentle
 * bobbing) with real narration and a visible caption track, explaining how to
 * subscribe, gain access to the landing page, and install + activate the
 * desktop apps.
 *
 * Narration channel: Cartesia TTS (sonic-3.5) through a server-side action
 * with a content-addressed cache — the audio is generated ONCE per script and
 * every replay serves the cached file, so the free plan's quota is never
 * consumed twice no matter how often the video is played. When the
 * CARTESIA_API_KEY is not configured, the browser's Web Speech engine is used
 * as an honest fallback. No simulated backend data anywhere.
 */

const SCRIPT_LINES = [
  "Welcome to FlashBolt — your BNB Chain triangular arbitrage terminal.",
  "Here is how to subscribe and unlock your access.",
  "First, click the SUBSCRIBE NOW button on the thumbnail above.",
  "Fill in your full name, your email address, and your location.",
  "Choose a subject line: Request a passcode, Send a passcode, or Other issues.",
  "Request a passcode is for new subscribers — the operator issues your unique code after review.",
  "Send a passcode is for existing subscribers confirming payment — attach your payment receipt.",
  "The terminal operator reviews every request in the backend before releasing the passcode.",
  "Once confirmed, your unique passcode is emailed straight to you.",
  "Then open the Subscriber dashboard, enter your email and passcode, and you are in.",
  "The terminal is yours. Happy arbitrage!",
  "Want the desktop app too? Open Desktop apps from the landing page footer.",
  "Download the setup for your operating system — Linux, macOS, or Windows.",
  "Activate it with the email you subscribed with and your activation password.",
  "Each operating system gets its own password, generated in the backend and emailed to the operator.",
  "One activation keeps the app licensed for re-use and re-run.",
];

export function AvatarExplainer() {
  return (
    <NarratedExplainer
      scriptLines={SCRIPT_LINES}
      title="How to subscribe & get access"
      description="Watch a short explainer with a humanistic avatar — it walks you through subscribing, how the operator confirms your request, how your unique passcode unlocks the landing page, and how to install and activate the desktop apps."
      dialogTitle="How to subscribe & gain access"
    />
  );
}
