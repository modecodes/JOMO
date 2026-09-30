import { concatHex, encodeAbiParameters, getCreate2Address, type Address, type Hex } from "viem";
import {
  CREATE2_FACTORY_ADDRESS,
  ERC5564_ANNOUNCER_ADDRESS,
  FEE_VAULT_SALT,
  STEALTH_ROUTER_SALT,
  feeVaultBytecode,
  stealthRouterBytecode,
} from "./generated/contracts.js";

export interface DeploymentInputs {
  /** Multisig that controls FeeVault withdrawals and the router allowlist. */
  feeVaultOwner: Address;
  announcer?: Address | undefined;
}

export interface DeploymentAddresses {
  feeVault: Address;
  stealthRouter: Address;
  feeVaultInitCode: Hex;
  stealthRouterInitCode: Hex;
}

/**
 * Addresses `script/Deploy.s.sol` will produce for the given inputs. They depend on the bytecode,
 * the salts, the announcer and the vault owner, never on the key that broadcasts, so they are
 * identical on every chain that has the CREATE2 factory and can be published before the
 * deployment happens. The script aborts if it would land anywhere else.
 */
export function computeDeploymentAddresses(inputs: DeploymentInputs): DeploymentAddresses {
  const announcer = inputs.announcer ?? ERC5564_ANNOUNCER_ADDRESS;
  const feeVaultInitCode = concatHex([
    feeVaultBytecode,
    encodeAbiParameters([{ type: "address" }], [inputs.feeVaultOwner]),
  ]);
  const feeVault = getCreate2Address({ from: CREATE2_FACTORY_ADDRESS, salt: FEE_VAULT_SALT, bytecode: feeVaultInitCode });
  const stealthRouterInitCode = concatHex([
    stealthRouterBytecode,
    encodeAbiParameters([{ type: "address" }, { type: "address" }], [announcer, feeVault]),
  ]);
  const stealthRouter = getCreate2Address({ from: CREATE2_FACTORY_ADDRESS, salt: STEALTH_ROUTER_SALT, bytecode: stealthRouterInitCode });
  return { feeVault, stealthRouter, feeVaultInitCode, stealthRouterInitCode };
}
