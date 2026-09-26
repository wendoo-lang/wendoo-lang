import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Issues and verifies binding tokens: a binding id together with an HMAC of
 * it, formatted `<bindingId>.<hex signature>`. Only a holder of the secret can
 * produce a token that verifies.
 */
export class BindingTokens {
  private readonly _secret: string;

  /** @param secret - Key the token signatures are computed with. */
  constructor(secret: string) {
    this._secret = secret;
  }

  /** Returns a token for `bindingId`. */
  create(bindingId: string): string {
    return `${bindingId}.${this.sign(bindingId)}`;
  }

  /** Returns the binding id `token` carries, or `undefined` when its signature does not verify. */
  verify(token: string): string | undefined {
    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) return undefined;
    const bindingId = token.slice(0, dotIndex);
    const signature = Buffer.from(token.slice(dotIndex + 1), "hex");
    const expected = Buffer.from(this.sign(bindingId), "hex");
    if (signature.length !== expected.length) return undefined;
    return timingSafeEqual(signature, expected) ? bindingId : undefined;
  }

  private sign(bindingId: string): string {
    return createHmac("sha256", this._secret).update(bindingId).digest("hex");
  }
}
