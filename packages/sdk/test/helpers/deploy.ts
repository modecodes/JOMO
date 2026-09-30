import {
  concatHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeDeploymentAddresses } from "../../src/deployments.js";
import { CREATE2_FACTORY_ADDRESS, ERC5564_ANNOUNCER_ADDRESS, ERC6538_REGISTRY_ADDRESS, FEE_VAULT_SALT, STEALTH_ROUTER_SALT, feeVaultAbi } from "../../src/generated/contracts.js";
import { erc5564AnnouncerBytecode, erc6538RegistryBytecode, mockErc20Abi, mockErc20Bytecode } from "../fixtures/contracts.js";

/** Runtime code of the deterministic CREATE2 factory (identical on Robinhood Chain and Ethereum). */
export const CREATE2_FACTORY_RUNTIME: Hex =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

export interface Fixture {
  announcer: Address;
  registry: Address;
  router: Address;
  feeVault: Address;
  feeVaultOwner: Address;
  token: Address;
}

/**
 * Recreates the Robinhood Chain contract landscape on a local Anvil:
 * canonical Announcer + Registry singletons at their real addresses, the CREATE2 factory, and the
 * StealthRouter at its deterministic address. Also deploys a mock ERC-20.
 */
export async function deployFixture(rpcUrl: string, chain: Chain, deployerKey: Hex, feeVaultOwner: Address): Promise<Fixture> {
  const transport = http(rpcUrl);
  const account = privateKeyToAccount(deployerKey);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const test = createTestClient({ mode: "anvil", chain, transport });

  const deploy = async (bytecode: Hex, abi: readonly unknown[] = [], args: unknown[] = []): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: args as never });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("deployment failed");
    return getAddress(receipt.contractAddress);
  };

  const placeAt = async (target: Address, bytecode: Hex): Promise<void> => {
    const tmp = await deploy(bytecode);
    const code = await publicClient.getCode({ address: tmp });
    if (!code) throw new Error("no runtime code");
    await test.setCode({ address: target, bytecode: code });
  };

  await placeAt(ERC5564_ANNOUNCER_ADDRESS, erc5564AnnouncerBytecode);
  await placeAt(ERC6538_REGISTRY_ADDRESS, erc6538RegistryBytecode);
  await test.setCode({ address: CREATE2_FACTORY_ADDRESS, bytecode: CREATE2_FACTORY_RUNTIME });

  // FeeVault then StealthRouter through the CREATE2 factory, exactly like script/Deploy.s.sol
  const expected = computeDeploymentAddresses({ feeVaultOwner });
  let hash = await wallet.sendTransaction({ to: CREATE2_FACTORY_ADDRESS, data: concatHex([FEE_VAULT_SALT, expected.feeVaultInitCode]) });
  await publicClient.waitForTransactionReceipt({ hash });
  hash = await wallet.sendTransaction({ to: CREATE2_FACTORY_ADDRESS, data: concatHex([STEALTH_ROUTER_SALT, expected.stealthRouterInitCode]) });
  await publicClient.waitForTransactionReceipt({ hash });
  for (const [label, address] of [["FeeVault", expected.feeVault], ["StealthRouter", expected.stealthRouter]] as const) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error(`${label} did not land at its computed address`);
  }
  // The router allowlist is owner-only, exactly like mainnet: the multisig allows the router after
  // both contracts exist. Locally the owner is an unlocked Anvil account.
  await test.impersonateAccount({ address: feeVaultOwner });
  await test.setBalance({ address: feeVaultOwner, value: 10n ** 18n });
  const ownerWallet = createWalletClient({ account: feeVaultOwner, chain, transport });
  hash = await ownerWallet.writeContract({ address: expected.feeVault, abi: feeVaultAbi, functionName: "setRouter", args: [expected.stealthRouter, true] });
  await publicClient.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: feeVaultOwner });

  const token = await deploy(mockErc20Bytecode, mockErc20Abi, ["Test USD", "tUSD", true]);

  return {
    announcer: ERC5564_ANNOUNCER_ADDRESS,
    registry: ERC6538_REGISTRY_ADDRESS,
    router: expected.stealthRouter,
    feeVault: expected.feeVault,
    feeVaultOwner,
    token,
  };
}
