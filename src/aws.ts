import * as vscode from "vscode";
import { ApiFactory } from "./api";
import { TotpHelper } from "./totp";
import { AssumeRoleWithSAMLCommand, STSClient } from "@aws-sdk/client-sts";
import { exec } from "./exec";
import humanizeDuration from "humanize-duration";
import { AwsRoleSelection, Configuration, ProfileName } from "./config";
import { isAxiosError } from "axios";

export const assumeAwsRole = (
  configuration: Configuration,
  apiFactory: ApiFactory,
  roleSelection?: AwsRoleSelection | null,
  twoFactorCode?: string,
  isRefresh?: boolean
): (() => Promise<void>) => {
  if (apiFactory.apiState.awsRoleRefreshTimeout) {
    clearTimeout(apiFactory.apiState.awsRoleRefreshTimeout);
    apiFactory.apiState.awsRoleRefreshTimeout = undefined;
  }

  return async () => {
    try {
      const idpApi = await apiFactory.idpApi(twoFactorCode);

      if (
        roleSelection === undefined &&
        configuration.assumeAws.lastRoleSelection
      ) {
        roleSelection = configuration.assumeAws.lastRoleSelection;
      }

      // Clear State
      configuration.assumeAws.lastRoleSelection = null;

      if (!roleSelection) {
        const { data: roles } = await idpApi.listRoles();

        if (!roles.results || !roles.results.length) {
          throw new Error("No roles available");
        }

        const selection = await vscode.window.showQuickPick(
          roles.results.map((r) => {
            return {
              label: r.role,
              description: `${r.org} (${r.provider})`,
              roleArn: r.role,
              org: r.org,
              provder: r.provider,
            };
          }),
          {
            placeHolder: "Select an AWS Role",
            matchOnDescription: true,
            matchOnDetail: true,
          }
        );

        if (!selection) {
          throw new Error("No role selected");
        }

        return assumeAwsRole(
          configuration,
          apiFactory,
          {
            roleArn: selection.roleArn,
            org: selection.org,
            provider: selection.provder,
          },
          twoFactorCode
        )();
      }

      const { data: assumeRoleResponse } = await idpApi.assumeRole(
        roleSelection.roleArn,
        roleSelection.org,
        roleSelection.provider
      );

      const { challenge } = assumeRoleResponse;
      if (challenge) {
        const totpHelper = new TotpHelper(
          configuration,
          apiFactory,
          roleSelection
        );
        // TODO TOTP Enrollment
        return await totpHelper.promptChallenge(challenge, assumeAwsRole);
      }

      const { sdkOptions, samlResponse } = assumeRoleResponse;

      if (!sdkOptions) {
        throw new Error("Missing SDK Options");
      }

      if (!samlResponse) {
        throw new Error("Missing SAML Response");
      }

      const client = new STSClient({
        region: configuration.assumeAws.region,
      });
      const { Credentials } = await client.send(
        new AssumeRoleWithSAMLCommand({
          ...sdkOptions,
          SAMLAssertion: samlResponse,
        })
      );

      if (!Credentials) {
        throw new Error("Missing Credentials");
      }

      const now = new Date();

      const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } =
        Credentials;

      if (!AccessKeyId || !SecretAccessKey || !SessionToken || !Expiration) {
        throw new Error(
          "Missing Access Key Id, Secret Access Key, Session Token or Expiration"
        );
      }

      // Save State
      configuration.assumeAws.lastRoleSelection = roleSelection;

      if (configuration.assumeAws.profile.name !== "None") {
        const profileName = generateProfileName(
          configuration.assumeAws.profile.name,
          roleSelection
        );
        const base = ["aws", "configure"];
        base.push("--profile", profileName);
        base.push("set");

        await exec([...base, "region", configuration.assumeAws.region]);
        await exec([...base, "aws_access_key_id", AccessKeyId]);
        await exec([...base, "aws_secret_access_key", SecretAccessKey]);
        await exec([...base, "aws_session_token", SessionToken]);

        if (!isRefresh) {
          vscode.window.showInformationMessage(
            `[SAML.to] AWS Profile "${profileName}" has been updated`
          );
        }
      } else {
        // where to put the credentials when it's none?
      }

      const refreshTimeout = (Expiration.getTime() - now.getTime()) / 2;

      if (configuration.assumeAws.autoRefresh) {
        apiFactory.apiState.awsRoleRefreshTimeout = setTimeout(async () => {
          await assumeAwsRole(
            configuration,
            apiFactory,
            roleSelection,
            undefined,
            true
          )();
        }, refreshTimeout);

        if (!isRefresh) {
          vscode.window.showInformationMessage(
            `[SAML.to] Credentials will refresh every ${humanizeDuration(
              refreshTimeout,
              { units: ["h", "m"], round: true }
            )}`
          );
        }
      }
    } catch (e) {
      // Clear State
      configuration.assumeAws.lastRoleSelection = null;

      if (!(e instanceof Error)) {
        throw e;
      }

      if (isAxiosError(e)) {
        vscode.window.showWarningMessage(
          `[SAML.to] Unable to assume AWS role: ${e.response?.data?.message}`
        );
      } else {
        vscode.window.showWarningMessage(
          `[SAML.to] Unable to assume AWS role: ${e.message}`
        );
      }
    }
  };
};

export const generateProfileName = (
  profileName: ProfileName,
  roleSelection: AwsRoleSelection
): string => {
  if (profileName === "Default Profile") {
    return "default";
  }

  if (profileName === "Role Name") {
    return roleSelection.roleArn.split("/").pop() || roleSelection.roleArn;
  }

  if (profileName === "Role ARN") {
    return roleSelection.roleArn;
  }

  if (profileName === "Account ID") {
    const parts = roleSelection.roleArn.split(":");
    return parts[4];
  }

  return profileName;
};

export const stopRefresh = (apiFactory: ApiFactory): (() => void) => {
  return () => {
    if (apiFactory.apiState.awsRoleRefreshTimeout) {
      clearTimeout(apiFactory.apiState.awsRoleRefreshTimeout);
      apiFactory.apiState.awsRoleRefreshTimeout = undefined;
      vscode.window.showInformationMessage(
        "[SAML.to] AWS Role Auto-Refresh Cancelled"
      );
    }
  };
};
