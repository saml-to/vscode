import * as vscode from "vscode";
import {
  Configuration as IDPConfiguration,
  IDPApi,
  TotpApi,
} from "../api/github-sls-rest-api";
import packageJson from "../package.json";
import os from "os";
import { Configuration } from "./config";

type Headers = { "user-agent": string; "x-2fa-code"?: string; origin?: string };

const USER_AGENT = `${packageJson.name}/${
  packageJson.version
} (${os.platform()}; ${os.arch()}) VSCode/${vscode.version}`;

type ApiHelperOptions = {
  dev?: boolean;
  apiKey?: string;
};

type ApiState = {
  awsRole?: string;
  awsRoleRefreshTimeout?: NodeJS.Timeout;
  awsRoleQuickPick?: vscode.QuickPick<vscode.QuickPickItem>;
};

export class ApiFactory {
  accessToken?: string;

  public readonly apiState: ApiState = {};

  constructor(
    public readonly context: vscode.ExtensionContext,
    private readonly configuration: Configuration,
    private options: ApiHelperOptions = {}
  ) {
    context.subscriptions.push(
      vscode.authentication.onDidChangeSessions(async (e) => {
        if (e.provider.id === "github") {
          await this.getAccessToken();
        }
      })
    );
  }

  public async initialize(): Promise<void> {
    try {
      await this.getAccessToken(undefined, false);
    } catch (e) {
      if (!(e instanceof Error)) {
        throw e;
      }
      vscode.window.showWarningMessage(
        `[SAML.to] Unable to initialize: ${e.message}`
      );
    }
  }

  private async getAccessToken(
    twoFactorCode?: string,
    create = true
  ): Promise<string | undefined> {
    let accessToken: string | null = null;

    if (this.configuration.github.token) {
      accessToken = this.configuration.github.token;
    } else {
      const session = await vscode.authentication.getSession(
        "github",
        ["user:email"],
        {
          createIfNone: create,
        }
      );

      if (create && (!session || !session.accessToken)) {
        throw new Error("Unable to setup GitHub Session");
      }

      if (session) {
        accessToken = session.accessToken;
      }
    }

    if (accessToken && this.accessToken !== accessToken) {
      try {
        const idpApi = await this.idpApi(twoFactorCode, accessToken);
        const { data: identity } = await idpApi.getIdentity();

        vscode.window.showInformationMessage(
          `[SAML.to] Logged into GitHub as ${identity.name} (${identity.id})`
        );

        this.accessToken = accessToken;
      } catch (e) {
        if (!(e instanceof Error)) {
          throw e;
        }
        throw new Error("Unable to fetch GitHub Identity: " + e.message);
      }
    }

    return this.accessToken;
  }

  public async idpApi(
    twoFactorCode?: string,
    accessToken?: string
  ): Promise<IDPApi> {
    const headers: Headers = { "user-agent": USER_AGENT };
    if (twoFactorCode) {
      headers["x-2fa-code"] = `${twoFactorCode}`;
    }

    // Origin header for Codespaces Identity
    const repository = this.configuration.github.repository;
    if (repository) {
      headers["origin"] = repository;
    }

    const configuration = new IDPConfiguration({
      accessToken: accessToken || (await this.getAccessToken(twoFactorCode)),
      baseOptions: {
        headers,
      },
    });

    if (this.options.dev) {
      configuration.basePath = "https://sso-nonlive.saml.to/github";
      configuration.apiKey = this.options.apiKey;
    }

    return new IDPApi(configuration);
  }

  public async totpApi(
    twoFactorCode?: string,
    accessToken?: string
  ): Promise<TotpApi> {
    const headers: Headers = { "user-agent": USER_AGENT };
    if (twoFactorCode) {
      headers["x-2fa-code"] = `${twoFactorCode}`;
    }

    const repository = this.configuration.github.repository;
    if (repository) {
      headers["origin"] = repository;
    }

    const configuration = new IDPConfiguration({
      accessToken: accessToken || (await this.getAccessToken(twoFactorCode)),
      baseOptions: {
        headers,
      },
    });

    if (this.options.dev) {
      configuration.basePath = "https://sso-nonlive.saml.to/github";
      configuration.apiKey = this.options.apiKey;
    }

    return new TotpApi(configuration);
  }
}
