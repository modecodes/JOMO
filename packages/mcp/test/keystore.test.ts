import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileKeystore } from "../src/keystore.js";
import { Confirmations, CONFIRMATION_TTL_MS, scopeOf } from "../src/confirm.js";

const dir = mkdtempSync(join(tmpdir(), "jomo-ks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("FileKeystore", () => {
  const path = join(dir, "keystore.json");
  const pass = "correct horse battery";

  it("creates an encrypted file that never contains the key in clear", () => {
    const store = FileKeystore.create(path, pass);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(store.state.identityPrivateKey.slice(2));
    expect(JSON.parse(raw)).toMatchObject({ version: 1, kdf: "scrypt" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reopens with the passphrase and round-trips state", () => {
    const a = FileKeystore.open(path, pass);
    a.state.cursor = "12345";
    a.state.payments["0xabc"] = { stealthAddress: "0x000000000000000000000000000000000000dEaD", stealthPrivateKey: "0x11", ephemeralPublicKey: "0x02", token: null, amount: "1", memo: undefined, transactionHash: "0x00", blockNumber: "1", spent: false };
    a.save();
    const b = FileKeystore.open(path, pass);
    expect(b.state.cursor).toBe("12345");
    expect(Object.keys(b.state.payments)).toHaveLength(1);
    expect(b.state.identityPrivateKey).toBe(a.state.identityPrivateKey);
  });

  it("rejects wrong passphrases, short passphrases and overwrites", () => {
    expect(() => FileKeystore.open(path, "wrong passphrase!")).toThrow(/passphrase/);
    expect(() => FileKeystore.create(join(dir, "x.json"), "short")).toThrow(/12 characters/);
    expect(() => FileKeystore.create(path, pass)).toThrow(/already exists/);
  });

  it("keeps the derived key, not the passphrase, for the life of the process", () => {
    const store = FileKeystore.open(path, pass);
    const held = Object.values(store as unknown as Record<string, unknown>);
    expect(held.some((v) => v === pass)).toBe(false);
    expect(JSON.stringify(held)).not.toContain(pass);
    store.save();
    expect(FileKeystore.open(path, pass).state.identityPrivateKey).toBe(store.state.identityPrivateKey);
  });

  it("never follows a symlink planted at the temp path, and creates its directory private", () => {
    const nested = join(dir, "private", "keystore.json");
    const store = FileKeystore.create(nested, pass);
    expect(statSync(join(dir, "private")).mode & 0o777).toBe(0o700);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, `${nested}.${process.pid}.tmp`);
    store.state.cursor = "7";
    store.save();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(FileKeystore.open(nested, pass).state.cursor).toBe("7");
    expect(statSync(nested).mode & 0o777).toBe(0o600);
  });
});

describe("Confirmations", () => {
  const scope = scopeOf("send", { to: "0xabc", amount: "1 ETH" });

  it("issues single-use tokens", () => {
    const c = new Confirmations();
    const token = c.prepare("do it", { n: 1 }, scope);
    expect(c.consume<{ n: number }>(token, scope)).toEqual({ n: 1 });
    expect(() => c.consume(token, scope)).toThrow(/Unknown or expired/);
    expect(() => c.consume("nope", scope)).toThrow(/Unknown or expired/);
    expect(CONFIRMATION_TTL_MS).toBeGreaterThan(0);
  });

  it("binds a token to its tool and arguments, and burns it when they differ", () => {
    const c = new Confirmations();
    const token = c.prepare("send 1 ETH", {}, scope);
    expect(() => c.consume(token, scopeOf("send", { to: "0xabc", amount: "100 ETH" }))).toThrow(/different tool or different arguments/);
    expect(() => c.consume(token, scope)).toThrow(/Unknown or expired/);
    const other = c.prepare("send 1 ETH", {}, scope);
    expect(() => c.consume(other, scopeOf("sweep", { to: "0xabc", amount: "1 ETH" }))).toThrow(/different tool/);
  });

  it("ignores the token and key order when identifying a call, and cancels on request", () => {
    expect(scopeOf("send", { amount: "1 ETH", to: "0xabc", confirmationToken: "t" })).toBe(scope);
    const c = new Confirmations();
    const token = c.prepare("x", {}, scope);
    c.cancel(token);
    expect(() => c.consume(token, scope)).toThrow(/Unknown or expired/);
  });
});
