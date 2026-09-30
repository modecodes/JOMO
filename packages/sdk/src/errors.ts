/** Base class for all SDK errors. `code` is stable and safe to branch on. */
export class JomoError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JomoError";
    this.code = code;
  }
}

export class InvalidStealthMetaAddressError extends JomoError {
  constructor(message = "Invalid stealth meta-address") {
    super("INVALID_STEALTH_META_ADDRESS", message);
    this.name = "InvalidStealthMetaAddressError";
  }
}

export class InvalidKeyError extends JomoError {
  constructor(message = "Invalid secp256k1 key", options?: { cause?: unknown }) {
    super("INVALID_KEY", message, options);
    this.name = "InvalidKeyError";
  }
}

export class RecipientNotRegisteredError extends JomoError {
  readonly registrant: string;
  constructor(registrant: string) {
    super(
      "RECIPIENT_NOT_REGISTERED",
      `No stealth meta-address registered for ${registrant} (ERC-6538 scheme 1). ` +
        "Ask the recipient to call agent.register(), or pass their stealth meta-address directly.",
    );
    this.name = "RecipientNotRegisteredError";
    this.registrant = registrant;
  }
}

export class NoAccountError extends JomoError {
  constructor() {
    super(
      "NO_ACCOUNT",
      "This operation signs a transaction but the agent was created without an `account`. " +
        "Pass a viem LocalAccount (e.g. privateKeyToAccount) or a `from` stealth payment.",
    );
    this.name = "NoAccountError";
  }
}

export class RouterUnavailableError extends JomoError {
  /** `missing`: no router code at the address. `disabled`: its FeeVault has stopped it (emergency stop). */
  readonly reason: "missing" | "disabled";
  constructor(chainId: number, address: string, reason: "missing" | "disabled" = "missing") {
    super(
      "ROUTER_UNAVAILABLE",
      (reason === "disabled"
        ? `StealthRouter ${address} on chain ${chainId} is stopped by its FeeVault. `
        : `StealthRouter is not deployed at ${address} on chain ${chainId}. `) +
        "Batch sends require the router; single sends fall back to direct ERC-5564 announcements.",
    );
    this.name = "RouterUnavailableError";
    this.reason = reason;
  }
}

export class MemoError extends JomoError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("MEMO", message, options);
    this.name = "MemoError";
  }
}

export class TransactionRevertedError extends JomoError {
  readonly hash: string;
  constructor(hash: string, what: string) {
    super("TRANSACTION_REVERTED", `${what} was mined but reverted (transaction ${hash}). Nothing it was meant to do took effect.`);
    this.name = "TransactionRevertedError";
    this.hash = hash;
  }
}

export class TransferNotDeliveredError extends JomoError {
  readonly hash: string;
  constructor(hash: string, message: string) {
    super("TRANSFER_NOT_DELIVERED", `${message} (transaction ${hash}). The payment was not announced.`);
    this.name = "TransferNotDeliveredError";
    this.hash = hash;
  }
}

export class InsufficientBalanceError extends JomoError {
  constructor(message: string) {
    super("INSUFFICIENT_BALANCE", message);
    this.name = "InsufficientBalanceError";
  }
}
