import * as vscode from "vscode";
import { ApiFactory } from "./api";
import { TotpHelper } from "./totp";
import { AssumeRoleWithSAMLCommand, STSClient } from "@aws-sdk/client-sts";
import { exec } from "./exec";
import humanizeDuration from "humanize-duration";
import { Configuration, ProfileName } from "./config";
import { isAxiosError } from "axios";

export const assumeAwsRole = (
  configuration: Configuration,
  apiFactory: ApiFactory,
  roleArn?: string | null,
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

      if (roleArn === undefined && configuration.assumeAws.lastRoleArn) {
        roleArn = configuration.assumeAws.lastRoleArn;
      }

      // Clear State
      configuration.assumeAws.lastRoleArn = null;

      if (!roleArn) {
        const { data: roles } = await idpApi.listRoles();

        if (!roles.results || !roles.results.length) {
          throw new Error("No roles available");
        }

        const selection = await vscode.window.showQuickPick(
          roles.results.map((r) => {
            return {
              label: r.role.split("/").pop() || r.role,
              description: r.org,
              detail: `${r.role}`,
              roleArn: r.role,
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
          selection.roleArn,
          twoFactorCode
        )();
      }

      const { data: assumeRoleResponse } = await idpApi.assumeRole(roleArn);

      const { challenge } = assumeRoleResponse;
      if (challenge) {
        const totpHelper = new TotpHelper(configuration, apiFactory, roleArn);
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
      configuration.assumeAws.lastRoleArn = roleArn;

      if (configuration.assumeAws.profile.name !== "None") {
        const profileName = generateProfileName(
          configuration.assumeAws.profile.name,
          roleArn
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
            roleArn,
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
      configuration.assumeAws.lastRoleArn = null;

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
  roleArn: string
): string => {
  if (profileName === "Default Profile") {
    return "default";
  }

  if (profileName === "Role Name") {
    return roleArn.split("/").pop() || roleArn;
  }

  if (profileName === "Role ARN") {
    return roleArn;
  }

  if (profileName === "Account ID") {
    const parts = roleArn.split(":");
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
