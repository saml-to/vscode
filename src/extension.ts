import * as vscode from "vscode";
import { ApiFactory } from "./api";
import { assumeAwsRole, stopRefresh } from "./aws";
import { Configuration, SamlToConfiguration } from "./config";

export async function activate(context: vscode.ExtensionContext) {
  const samlTo = new SamlToConfiguration();
  await samlTo.initialize();

  const configuration = new Configuration(context, samlTo);

  const apiFactory = new ApiFactory(context, configuration, {});
  await apiFactory.initialize();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "saml-to-vscode.assume-aws-role",
      assumeAwsRole(
        configuration,
        apiFactory,
        configuration.assumeAws.role
          ? {
              roleArn: configuration.assumeAws.role,
              org: configuration.github.org,
              provider: configuration.samlTo.provider,
            }
          : undefined
      )
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "saml-to-vscode.stop-refresh",
      stopRefresh(apiFactory)
    )
  );

  if (configuration.assumeAws.assumeRoleAtStartup) {
    vscode.commands.executeCommand("saml-to-vscode.assume-aws-role");
  }
}

export function deactivate() {}
