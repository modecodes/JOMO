import { concatHex, encodeAbiParameters, getCreate2Address, keccak256, toFunctionSelector, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { computeDeploymentAddresses } from "../src/deployments.js";
import {
  CREATE2_FACTORY_ADDRESS,
  ERC5564_ANNOUNCER_ADDRESS,
  ERC6538_REGISTRY_ADDRESS,
  FEE_VAULT_SALT,
  FEE_VAULT_STATS_SELECTOR,
  STEALTH_ROUTER_DEPLOYMENTS,
  STEALTH_ROUTER_FEE_BPS,
  STEALTH_ROUTER_SALT,
  feeVaultBytecode,
  stealthRouterBytecode,
} from "../src/generated/contracts.js";
import { quoteFee } from "../src/client/PrivateAgent.js";

describe("generated contract constants", () => {
  it("uses the canonical ERC-5564 / ERC-6538 singleton addresses", () => {
    expect(ERC5564_ANNOUNCER_ADDRESS).toBe("0x55649E01B5Df198D18D95b5cc5051630cfD45564");
    expect(ERC6538_REGISTRY_ADDRESS).toBe("0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538");
    expect(FEE_VAULT_STATS_SELECTOR).toBe(toFunctionSelector("stats()"));
    expect(STEALTH_ROUTER_FEE_BPS).toBe(100n);
  });

  it("computes deterministic FeeVault and StealthRouter addresses like the deploy script", () => {
    expect(FEE_VAULT_SALT).toBe(keccak256(toHex("jomo.fee-vault.v1")));
    expect(STEALTH_ROUTER_SALT).toBe(keccak256(toHex("jomo.stealth-router.v2")));
    const owner = "0x1111111111111111111111111111111111111111";
    const out = computeDeploymentAddresses({ feeVaultOwner: owner });
    const vaultInit = concatHex([feeVaultBytecode, encodeAbiParameters([{ type: "address" }], [owner])]);
    const vault = getCreate2Address({ from: CREATE2_FACTORY_ADDRESS, salt: FEE_VAULT_SALT, bytecode: vaultInit });
    expect(out.feeVault).toBe(vault);
    const routerInit = concatHex([stealthRouterBytecode, encodeAbiParameters([{ type: "address" }, { type: "address" }], [ERC5564_ANNOUNCER_ADDRESS, vault])]);
    expect(out.stealthRouter).toBe(getCreate2Address({ from: CREATE2_FACTORY_ADDRESS, salt: STEALTH_ROUTER_SALT, bytecode: routerInit }));
  });

  it("ships only real deployments (none until the deploy script has run)", () => {
    for (const [chainId, d] of Object.entries(STEALTH_ROUTER_DEPLOYMENTS)) {
      expect(Number(chainId)).toBeGreaterThan(0);
      expect(d.stealthRouter).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(d.feeVault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("quotes the 1% fee rounded up, like the contract", () => {
    expect(quoteFee(0n)).toBe(0n);
    expect(quoteFee(1n)).toBe(1n);
    expect(quoteFee(99n)).toBe(1n);
    expect(quoteFee(100n)).toBe(1n);
    expect(quoteFee(101n)).toBe(2n);
    expect(quoteFee(10n ** 18n)).toBe(10n ** 16n);
  });
});
