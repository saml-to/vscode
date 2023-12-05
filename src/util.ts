import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";

const hasCode = <T>(error: T): error is T & { code: string } => {
  return typeof (error as { code?: unknown }).code === "string";
};

const isFileNotFoundError = (err: unknown): boolean => {
  if (err instanceof vscode.FileSystemError) {
    return err.code === vscode.FileSystemError.FileNotFound().code;
  } else if (hasCode(err)) {
    return err.code === "ENOENT";
  }

  return false;
};

export const fileExists = async (
  file: string | vscode.Uri
): Promise<boolean> => {
  const uri = typeof file === "string" ? vscode.Uri.file(file) : file;

  return vscode.workspace.fs.stat(uri).then(
    () => true,
    (err) => !isFileNotFoundError(err)
  );
};

export const getHomeDirectory = (): string => {
  if (process.env.HOME !== undefined) {
    return process.env.HOME;
  }
  if (process.env.USERPROFILE !== undefined) {
    return process.env.USERPROFILE;
  }
  if (process.env.HOMEPATH !== undefined) {
    const homeDrive: string = process.env.HOMEDRIVE || "C:";

    return path.join(homeDrive, process.env.HOMEPATH);
  }

  return os.homedir();
};
