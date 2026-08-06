import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type ICachePlugin,
  type TokenCacheContext,
} from "@azure/msal-node";
import { AuthExpiredError, BackendUnavailableError } from "../errors.js";
import { logger } from "../logger.js";

const SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
];

export function filePlugin(path: string): Required<ICachePlugin> {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      try {
        context.tokenCache.deserialize(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (context.cacheHasChanged) {
        await writeFile(path, context.tokenCache.serialize(), { mode: 0o600 });
      }
    },
  };
}

export class GraphTokenProvider {
  private readonly app: PublicClientApplication;

  constructor(
    private readonly mailboxName: string,
    tenantId: string,
    clientId: string,
    cacheDir: string,
  ) {
    this.app = new PublicClientApplication({
      auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
      cache: { cachePlugin: filePlugin(join(cacheDir, `${this.mailboxName}.json`)) },
    });
  }

  async getToken(): Promise<string> {
    const accounts = await this.app.getTokenCache().getAllAccounts();
    const account = accounts[0];
    if (account === undefined) throw new AuthExpiredError(this.mailboxName);
    try {
      const result = await this.app.acquireTokenSilent({ account, scopes: SCOPES });
      if (result === null) throw new AuthExpiredError(this.mailboxName);
      return result.accessToken;
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      // Only interaction-required means the human must re-login; anything
      // else (network, AAD outage) is transient and must say so.
      if (error instanceof InteractionRequiredAuthError) {
        throw new AuthExpiredError(this.mailboxName);
      }
      logger.warn({ mailbox: this.mailboxName, error: String(error) }, "silent token acquisition failed");
      throw new BackendUnavailableError(this.mailboxName, `token acquisition failed: ${String(error)}`);
    }
  }

  async deviceCodeLogin(onMessage: (text: string) => void): Promise<void> {
    const result = await this.app.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (info) => onMessage(info.message),
    });
    if (result === null) {
      throw new Error(`Device code login for mailbox '${this.mailboxName}' returned no result`);
    }
  }
}
