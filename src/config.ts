import * as vscode from "vscode";
import { getHomeDirectory, getRootFileSystem, readFile } from "./util";
import path from "path";

export type Options = {
  github: GithubOptions;
  assumeAws: AssumeAwsOptions;
};

export type GithubOptions = {
  token?: string;
};

export type AssumeAwsOptions = {
  assumeRoleAtStartup: boolean;
  autoRefresh: boolean;
  rememberRole: RememberRole;
  region: string;
  role?: string;
  profile: AssumeAwsProfileOptions;
};

export type ProfileName =
  | string
  | "Default Profile"
  | "Role ARN"
  | "Role Name"
  | "None";

export type AssumeAwsProfileOptions = {
  name: ProfileName;
};

export type AwsRoleSelection = {
  roleArn: string;
  provider?: string;
  org?: string;
};

class GitHubConfiguration {
  constructor(
    private configuration: vscode.WorkspaceConfiguration,
    private samlTo: SamlToConfiguration
  ) {}

  get token(): string | undefined {
    const fromFs = this.samlTo.githubToken;
    const fromEnv = process.env.GITHUB_TOKEN;
    const fromConfig = this.configuration.get<string>("token");
    return fromFs || fromEnv || fromConfig;
  }

  get org(): string | undefined {
    return this.repository ? this.repository.split("/")[0] : undefined;
  }

  get repository(): string | undefined {
    // TODO: alternate read from /workspaces/.codespaces/shared/.env
    const fromEnv = process.env.GITHUB_REPOSITORY;
    return fromEnv;
  }
}

class AssumeAwsProfileConfiguration {
  constructor(
    private configuration: vscode.WorkspaceConfiguration,
    private samlTo: SamlToConfiguration
  ) {}

  get name(): ProfileName {
    const fromFs = this.samlTo.awsProfile;
    const fromEnv: ProfileName | undefined = process.env.AWS_PROFILE;
    const fromConfig = this.configuration.get<ProfileName>("name");
    return fromFs || fromEnv || fromConfig || "Role ARN";
  }
}

export type RememberRole = "Workspace" | "Global" | "None";

class AssumeAwsConfiguration {
  #profile: AssumeAwsProfileConfiguration;

  constructor(
    private context: vscode.ExtensionContext,
    private configuration: vscode.WorkspaceConfiguration,
    private samlTo: SamlToConfiguration
  ) {
    this.#profile = new AssumeAwsProfileConfiguration(
      vscode.workspace.getConfiguration("saml-to.assumeAws.profile"),
      samlTo
    );

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("saml-to.assumeAws.profile")) {
        this.#profile = new AssumeAwsProfileConfiguration(
          vscode.workspace.getConfiguration("saml-to.assumeAws.profile"),
          samlTo
        );
      }
    });
  }

  get assumeRoleAtStartup(): boolean {
    return this.configuration.get<boolean>("assumeRoleAtStartup", true);
  }

  get rememberRole(): RememberRole {
    return this.configuration.get<RememberRole>("rememberRole", "None");
  }

  get autoRefresh(): boolean {
    return this.configuration.get<boolean>("autoRefresh", true);
  }

  get region(): string {
    const fromFs = this.samlTo.awsRegion;
    const fromEnv = process.env.AWS_DEFAULT_REGION;
    const fromConfig = this.configuration.get<string>("region");
    return fromFs || fromConfig || fromEnv || "us-east-1";
  }

  get role(): string | undefined {
    const fromFs = this.samlTo.awsRole;
    const fromEnv = process.env.AWS_ROLE_ARN;
    const fromConfig = this.configuration.get<string | undefined>("role");
    return fromFs || fromEnv || fromConfig || undefined;
  }

  get profile(): AssumeAwsProfileConfiguration {
    return this.#profile;
  }

  get lastRoleSelection(): AwsRoleSelection | undefined {
    if (this.rememberRole === "Global") {
      let roleSelection = this.context.globalState.get<string>(
        "assumeAws.lastRoleSelection"
      );
      return roleSelection ? JSON.parse(roleSelection) : undefined;
    }

    if (this.rememberRole === "Workspace") {
      let roleSelection = this.context.workspaceState.get<string>(
        "assumeAws.lastRoleSelection"
      );
      return roleSelection ? JSON.parse(roleSelection) : undefined;
    }

    return undefined;
  }

  set lastRoleSelection(roleSelection: AwsRoleSelection | null) {
    if (!roleSelection) {
      this.context.workspaceState
        .update("assumeAws.lastRoleSelection", null)
        .then(() => {});
      this.context.globalState
        .update("assumeAws.lastRoleSelection", null)
        .then(() => {});
      return;
    }

    let memento: vscode.Memento | undefined = undefined;

    if (this.rememberRole === "Global") {
      memento = this.context.globalState;
    }

    if (this.rememberRole === "Workspace") {
      memento = this.context.workspaceState;
    }

    if (memento) {
      memento
        .update("assumeAws.lastRoleSelection", JSON.stringify(roleSelection))
        .then(() => {});
    }
  }
}

export class SamlToConfiguration {
  #provider: string | undefined;
  #githubToken: string | undefined;
  #awsRole: string | undefined;
  #awsRegion: string | undefined;
  #awsProfile: string | undefined;

  constructor() {}

  public async initialize(): Promise<void> {
    let root = getRootFileSystem();
    let home = getHomeDirectory();

    const githubTokenJson = await readFile(
      path.join(home, ".saml-to", "github-token.json")
    );

    if (githubTokenJson) {
      const githubToken = JSON.parse(githubTokenJson);
      if (githubToken.token) {
        this.#githubToken = githubToken.token;
      }
    }

    // TODO: Support Windows (e.g. %APPDATA%\saml-to\provider)
    // This is currently only used in Codespaces
    // Since Codespaces is linux-only, this is fine for now

    this.#provider = await readFile(
      path.join(root, "etc", "saml-to", "provider")
    );
    this.#awsRole = await readFile(
      path.join(root, "etc", "saml-to", "aws", "role")
    );
    this.#awsRegion = await readFile(
      path.join(root, "etc", "saml-to", "aws", "region")
    );
    this.#awsProfile = await readFile(
      path.join(root, "etc", "saml-to", "aws", "profile")
    );
  }

  get githubToken(): string | undefined {
    return this.#githubToken;
  }

  get provider(): string | undefined {
    return this.#provider;
  }

  get awsRole(): string | undefined {
    return this.#awsRole;
  }

  get awsRegion(): string | undefined {
    return this.#awsRegion;
  }

  get awsProfile(): string | undefined {
    return this.#awsProfile;
  }
}

export class Configuration {
  #github: GitHubConfiguration;
  #assumeAws: AssumeAwsConfiguration;
  #samlTo: SamlToConfiguration;

  constructor(
    private context: vscode.ExtensionContext,
    samlTo: SamlToConfiguration
  ) {
    this.#samlTo = samlTo;

    this.context.globalState.setKeysForSync(["assumeAws.lastRoleSelection"]);

    this.#github = new GitHubConfiguration(
      vscode.workspace.getConfiguration("saml-to.github"),
      samlTo
    );

    this.#assumeAws = new AssumeAwsConfiguration(
      context,
      vscode.workspace.getConfiguration("saml-to.assumeAws"),
      samlTo
    );

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("saml-to.github")) {
        this.#github = new GitHubConfiguration(
          vscode.workspace.getConfiguration("saml-to.github"),
          samlTo
        );
      }
      if (e.affectsConfiguration("saml-to.assumeAws")) {
        this.#assumeAws = new AssumeAwsConfiguration(
          context,
          vscode.workspace.getConfiguration("saml-to.assumeAws"),
          samlTo
        );
      }
    });
  }

  get samlTo(): SamlToConfiguration {
    return this.#samlTo;
  }

  get github(): GitHubConfiguration {
    return this.#github;
  }

  get assumeAws(): AssumeAwsConfiguration {
    return this.#assumeAws;
  }
}
