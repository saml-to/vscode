import {
  GithubSlsRestApiChallenge,
  GithubSlsRestApiTotpMethod,
} from "../api/github-sls-rest-api";
import { ApiFactory } from "./api";
import * as vscode from "vscode";
import QRCode from "qrcode-svg";
import { AwsRoleSelection, Configuration } from "./config";

export type RetryFunctionWithCode = (
  configuration: Configuration,
  apiFactory: ApiFactory,
  roleSelection: AwsRoleSelection,
  code: string
) => () => Promise<void>;

export class TotpHelper {
  constructor(
    private configuration: Configuration,
    private apiFactory: ApiFactory,
    private roleSelection: AwsRoleSelection
  ) {}

  async promptChallenge(
    challenge: GithubSlsRestApiChallenge,
    retryFn: RetryFunctionWithCode,
    last?: {
      method: GithubSlsRestApiTotpMethod;
      recipient?: string;
    }
  ): Promise<void> {
    const { org, invitation, methods } = challenge;
    let { recipient } = challenge;

    if (last) {
      recipient = last.recipient;
    }

    if (!methods || !methods.length) {
      throw new Error(
        `Unable to enroll in 2-Factor Authentication. ${org} requires Two Factor auth, however the allowed challenge methods are missing.`
      );
    }

    let method: GithubSlsRestApiTotpMethod;
    let panel: vscode.WebviewPanel | undefined = undefined;

    if (invitation && !last) {
      if (methods.length === 1) {
        method = methods[0];
      } else {
        const selection = await vscode.window.showQuickPick(
          methods.map((m) => {
            return {
              label: `${
                m === GithubSlsRestApiTotpMethod.App
                  ? "Authenticator App"
                  : "Email"
              }`,
              method: m,
            };
          }),
          {
            placeHolder:
              "By which method would you like to provide 2-factor codes?",
          }
        );

        if (!selection) {
          throw new Error("No 2FA method selected");
        }

        method = selection.method;
      }

      const totpApi = await this.apiFactory.totpApi();
      const { data: enrollResponse } = await totpApi.totpEnroll(org, method, {
        invitation,
      });
      const { uri } = enrollResponse;
      recipient = enrollResponse.recipient;
      if (!uri) {
        throw new Error("Missing TOTP URI");
      }

      if (enrollResponse.method === GithubSlsRestApiTotpMethod.App) {
        const totpQr = await generateTotpQr(uri);
        panel = vscode.window.createWebviewPanel(
          "twoFactorEnrollment",
          "2-Factor Enrollment",
          vscode.ViewColumn.Beside,
          {}
        );
        panel.webview.html = getWebviewContent(org, totpQr);
      }
    } else {
      method = last ? last.method : methods[0];
    }

    let message: string;
    if (method === GithubSlsRestApiTotpMethod.App) {
      message = `Please enter the code in your Authenticator App for ${recipient}:`;
    } else {
      message = `Please enter the code sent to ${recipient} via ${method}:`;
    }

    const code = await vscode.window.showInputBox({
      prompt: message,
      password: true,
      title: "[SAML.to] 2-Factor Code",
      ignoreFocusOut: true,
      validateInput: (text) => {
        if (!text.match(/^\d{1,10}$/)) {
          return "Invalid code";
        }
        return null;
      },
    });

    if (!code) {
      if (panel) {
        panel.dispose();
      }
      return;
    }

    const totpApi = await this.apiFactory.totpApi(code);

    if (invitation) {
      const { data: response } = await totpApi.totpEnroll(org, method, {
        invitation,
      });
      if (!response.verified) {
        vscode.window.showErrorMessage(
          "[SAML.to] The code is incorrect. Please try again."
        );

        await this.promptChallenge(challenge, retryFn, {
          recipient: response.recipient || recipient,
          method,
        });

        if (panel) {
          panel.dispose();
        }

        return;
      }
    }

    if (panel) {
      panel.dispose();
    }

    return retryFn(
      this.configuration,
      this.apiFactory,
      this.roleSelection,
      code
    )();
  }
}

type TotpQr = {
  svg: string;
  secret: string;
};

export const generateTotpQr = (uri: string): Promise<TotpQr> => {
  const url = new URL(uri);
  const secret = url.searchParams.get("secret") ?? "";
  return new Promise<TotpQr>((resolve) => {
    const svg = new QRCode({ content: uri }).svg();
    resolve({
      svg,
      secret,
    });
  });
};

function getWebviewContent(org: string, totpQr: TotpQr) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>2-Factor Enrollment</title>
</head>
<body>
    <div style="text-align: center">
      <h3><pre>${org}</pre></h3>
      <h4>Requires 2-Factor<br/>Authentication</h4>
      <div style="border: 1px solid #ccc; padding: 10px; margin: 10px;">
        <h4>Scan this QR Code using an Authenticator App:</h4>
        <img src="data:image/svg+xml;charset=utf8,${encodeURIComponent(
          totpQr.svg
        )}"/>
        <h5>Or enter this code manually:</h5>
        <pre>${totpQr.secret.match(/\w{1,4}/g)?.join(" ")}</pre>
      </div>
    </div>
</body>
</html>`;
}
