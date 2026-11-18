# FlashBolt Sniper Overlay — browser extension (v2.9.0)

Runs the full FlashBolt sniper engine inside DEXView, GMGN, Ave.ai and DexScreener:
ON/OFF bot toggle, site-chain auto-sync (the overlay follows the chain page you
browse on each site), multi-source brand-new-token capture (buyable AND sellable
only), direct wallet connect, real router buy/sell gated by a full eth_call
simulation (zero gas on failure), auto-sell with trailing stop, automatic payout
and a UTC world clock.

## Install — Chrome / Edge / Brave / Opera (MV3)
1. Unzip chrome-flashbolt-overlay.zip (or copy the files) into a folder.
2. Open chrome://extensions → enable Developer mode → Load unpacked → select the folder.

## Install — Firefox (MV2)
1. Unzip firefox-flashbolt-overlay.zip into a folder.
2. Open about:debugging#/runtime/this-firefox → Load Temporary Add-on → select manifest.json.
   (For a permanent install, package the folder with web-ext and sign on AMO.)

## Prefer the userscript instead?
Use flashbolt-sniper-overlay.user.js with Tampermonkey/Violentmonkey/Greasemonkey —
one script, every Chromium + Firefox + Safari (Userscripts app) browser.

Settings live inside the floating panel on the page; they persist per site.
