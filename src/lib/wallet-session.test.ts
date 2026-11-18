import { describe, expect, test } from "bun:test";
import {
  onWalletSessionEvent,
  probeWalletSession,
  reconnectInjectedEvm,
  reconnectSolana,
  ensureEvmSessionGuard,
  ensureSolanaSessionGuard,
} from "./wallet-session";

/**
 * Wallet session layer — the honest-glue rules that matter:
 *   • absent providers resolve null (never throw, never fabricate)
 *   • silent probes use eth_accounts / onlyIfTrusted (no eth_requestAccounts,
 *     no plain connect()) — a locked wallet STAYS locked, reported honestly
 *   • guards are idempotent and fan events out to every subscriber exactly
 *     once, with one broken subscriber never breaking the others
 */

describe("wallet-session", () => {
  test("absent EVM provider resolves null instead of throwing", async () => {
    const addr = await reconnectInjectedEvm();
    expect(addr).toBeNull();
  });

  test("absent Solana provider resolves null instead of throwing", async () => {
    const pk = await reconnectSolana("phantom");
    expect(pk).toBeNull();
  });

  test("probeWalletSession reports null/null without providers", async () => {
    const probe = await probeWalletSession();
    expect(probe.address).toBeNull();
    expect(probe.chainId).toBeNull();
  });

  test("silent probes use eth_accounts / onlyIfTrusted (no popup methods)", async () => {
    const seen: string[] = [];
    let trustedConnect = false;
    const events: Array<{ method: string } & Record<string, unknown>> = [];
    const provider = {
      request(args: { method: string }) {
        seen.push(args.method);
        events.push(args);
        if (args.method === "eth_accounts") return Promise.resolve(["0xabc"]);
        if (args.method === "eth_chainId") return Promise.resolve("0x38");
        return Promise.resolve(null);
      },
      on() {},
      removeListener() {},
    };
    const solProvider = {
      connect(opts?: { onlyIfTrusted?: boolean }) {
        if (opts?.onlyIfTrusted) trustedConnect = true;
        return Promise.resolve({ publicKey: { toString: () => "So1PubKey" } });
      },
      disconnect() {
        return Promise.resolve();
      },
      on() {},
    };
    (globalThis as Record<string, unknown>).window = {
      ethereum: provider,
      phantom: { solana: solProvider },
    };
    try {
      const addr = await reconnectInjectedEvm();
      expect(addr).toBe("0xabc");
      const pk = await reconnectSolana("phantom");
      expect(pk).toBe("So1PubKey");
      expect(trustedConnect).toBe(true); // silent path, never a plain connect
      const probe = await probeWalletSession();
      expect(probe.chainId).toBe(56);
      expect(seen.every((m) => m === "eth_accounts" || m === "eth_chainId")).toBe(true);
      expect(seen.includes("eth_requestAccounts")).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  test("event fan-out reaches subscribers; a broken one never breaks others", () => {
    const got: unknown[] = [];
    let brokenCalls = 0;
    const off1 = onWalletSessionEvent((e) => {
      got.push(e);
    });
    const off2 = onWalletSessionEvent(() => {
      brokenCalls += 1;
      throw new Error("subscriber is broken");
    });
    const off3 = onWalletSessionEvent((e) => {
      got.push(e);
    });
    // Reach into the module through a guard install on a fake provider to
    // emit one real event of each shape via the public surface.
    const handlerMap = new Map<string, (...args: unknown[]) => void>();
    const provider = {
      request() {
        return Promise.resolve(null);
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlerMap.set(event, handler);
      },
      removeListener() {},
    };
    (globalThis as Record<string, unknown>).window = { ethereum: provider };
    try {
      ensureEvmSessionGuard();
      ensureEvmSessionGuard(); // idempotent — second install must not re-listen
      handlerMap.get("accountsChanged")?.(["0xnew"]);
      handlerMap.get("chainChanged")?.("0x38");
      expect(got.filter((e) => (e as { kind: string }).kind === "accounts").length).toBe(2); // both healthy subscribers, once each
      expect(got.filter((e) => (e as { kind: string }).kind === "chain").length).toBe(2);
      expect(brokenCalls).toBe(2); // called once per emitted event, never blocked others
      off1();
      off2();
      off3();
      // After unsubscribe, no further fan-out to the removed listeners.
      got.length = 0;
      brokenCalls = 0;
      handlerMap.get("chainChanged")?.("0x1");
      expect(got.length).toBe(0);
      expect(brokenCalls).toBe(0);
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  test("solana guard fans accountChanged + disconnect; idempotent per wallet", () => {
    const got: Array<{ kind: string; wallet?: string }> = [];
    const off = onWalletSessionEvent((e) => got.push(e as { kind: string; wallet?: string }));
    const handlerMap = new Map<string, (...args: unknown[]) => void>();
    let onCalls = 0;
    const provider = {
      connect() {
        return Promise.resolve(null);
      },
      disconnect() {
        return Promise.resolve();
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        onCalls += 1;
        handlerMap.set(event, handler);
      },
    };
    (globalThis as Record<string, unknown>).window = { backpack: provider };
    try {
      ensureSolanaSessionGuard("backpack");
      ensureSolanaSessionGuard("backpack"); // idempotent — still ONE listener set
      expect(onCalls).toBe(2); // accountChanged + disconnect, installed once
      handlerMap.get("accountChanged")?.({ toString: () => "NewPk" });
      handlerMap.get("disconnect")?.();
      const kinds = got.map((e) => e.kind);
      expect(kinds.filter((k) => k === "sol-account").length).toBe(1);
      expect(kinds.filter((k) => k === "disconnected").length).toBe(1);
      off();
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  test("chainChanged with malformed hex is ignored without throwing", () => {
    const got: unknown[] = [];
    const off = onWalletSessionEvent((e) => got.push(e));
    const handlerMap = new Map<string, (...args: unknown[]) => void>();
    const provider = {
      request() {
        return Promise.resolve(null);
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlerMap.set(event, handler);
      },
      removeListener() {},
    };
    (globalThis as Record<string, unknown>).window = { ethereum: provider };
    try {
      ensureEvmSessionGuard();
      expect(() => handlerMap.get("chainChanged")?.("not-hex")).not.toThrow();
      expect(got.length).toBe(0);
      off();
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});
