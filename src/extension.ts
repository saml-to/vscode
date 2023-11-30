import * as vscode from "vscode";
import { ApiFactory } from "./api";
import { assumeAwsRole, stopRefresh } from "./aws";
import { Configuration } from "./config";

export async function activate(context: vscode.ExtensionContext) {
  const configuration = new Configuration(context);
  const apiFactory = new ApiFactory(context, configuration, {});
  await apiFactory.initialize();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "saml-to-vscode.assume-aws-role",
      assumeAwsRole(
        configuration,
        apiFactory,
        configuration.assumeAws.role || undefined
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
