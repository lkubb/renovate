import { quote } from 'shlex';
import { FILE_ACCESS_VIOLATION_ERROR } from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { coerceArray } from '../../../util/array';
import { exec } from '../../../util/exec';
import { readLocalFile } from '../../../util/fs';
import { ensureLocalPath } from '../../../util/fs/util';
import { getRepoStatus } from '../../../util/git';
import type {
  UpdateArtifact,
  UpdateArtifactsConfig,
  UpdateArtifactsResult,
} from '../types';

type CopierBoolOpt = 'skipTasks';
type CopierListOpt = 'skip' | 'exclude';

const boolOpts: Record<CopierBoolOpt, string> = {
  skipTasks: '--skip-tasks',
};

const listOpts: Record<CopierListOpt, string> = {
  skip: '--skip',
  exclude: '--exclude',
};

const DEFAULT_COMMAND_OPTIONS = ['--skip-answered', '--defaults'];

function buildCommand(
  config: UpdateArtifactsConfig,
  packageFileName: string,
  newVersion: string,
): string {
  const command = ['copier'];
  if (config?.copierOptions?.recopy) {
    command.push('recopy', ...DEFAULT_COMMAND_OPTIONS, '--overwrite');
  } else {
    command.push('update', ...DEFAULT_COMMAND_OPTIONS);
  }
  if (config?.copierTrust) {
    command.push('--trust');
  }
  for (const [opt, param] of Object.entries(boolOpts)) {
    if (config.copierOptions?.[opt]) {
      command.push(param);
    }
  }
  if (config.copierOptions?.dataFile) {
    try {
      ensureLocalPath(config.copierOptions.dataFile);
    } catch (err) {
      if (err.message === FILE_ACCESS_VIOLATION_ERROR) {
        throw new Error(
          'copierOptions.dataFile is not part of the repository',
          { cause: err },
        );
      }
      // istanbul ignore next
      throw err;
    }
    command.push('--data-file', quote(config.copierOptions.dataFile));
  }
  for (const [key, value] of Object.entries(config.copierOptions?.data ?? {})) {
    command.push('--data', quote(`${key}=${value}`));
  }
  for (const [opt, param] of Object.entries(listOpts)) {
    config.copierOptions?.[opt]?.forEach((item: string) => {
      command.push(param, quote(item));
    });
  }
  command.push(
    '--answers-file',
    quote(packageFileName),
    '--vcs-ref',
    quote(newVersion),
  );
  return command.join(' ');
}

function artifactError(
  packageFileName: string,
  message: string,
): UpdateArtifactsResult[] {
  return [
    {
      artifactError: {
        lockFile: packageFileName,
        stderr: message,
      },
    },
  ];
}

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  if (!updatedDeps || updatedDeps.length !== 1) {
    // Each answers file (~ packageFileName) has exactly one dependency to update.
    return artifactError(
      packageFileName,
      `Unexpected number of dependencies: ${updatedDeps.length} (should be 1)`,
    );
  }

  const newVersion = updatedDeps[0]?.newVersion ?? updatedDeps[0]?.newValue;
  if (!newVersion) {
    return artifactError(
      packageFileName,
      'Missing copier template version to update to',
    );
  }

  let command: string;
  try {
    command = buildCommand(config, packageFileName, newVersion);
  } catch (err) {
    logger.error({ err }, `Failed to build copier command: ${err.message}`);
    return artifactError(packageFileName, err.message);
  }

  try {
    await exec(command);
  } catch (err) {
    logger.error({ err }, `Failed to update copier template: ${err.message}`);
    return artifactError(packageFileName, err.message);
  }

  const status = await getRepoStatus();
  // If the answers file didn't change, Copier did not update anything.
  if (!status.modified.includes(packageFileName)) {
    return null;
  }

  if (status.conflicted.length > 0) {
    // Sometimes, Copier erroneously reports conflicts.
    const msg =
      `Updating the Copier template yielded ${status.conflicted.length} merge conflicts. ` +
      'Please check the proposed changes carefully! Conflicting files:\n  * ' +
      status.conflicted.join('\n  * ');
    logger.warn({ packageFileName, depName: updatedDeps[0]?.depName }, msg);
  }

  const res: UpdateArtifactsResult[] = [];

  for (const f of [
    ...status.modified,
    ...status.not_added,
    ...status.conflicted,
  ]) {
    const fileRes: UpdateArtifactsResult = {
      file: {
        type: 'addition',
        path: f,
        contents: await readLocalFile(f),
      },
    };
    if (status.conflicted.includes(f)) {
      // Make the reviewer aware of the conflicts.
      // This will be posted in a comment.
      fileRes.notice = {
        file: f,
        message:
          'This file had merge conflicts. Please check the proposed changes carefully!',
      };
    }
    res.push(fileRes);
  }
  for (const f of coerceArray(status.deleted)) {
    res.push({
      file: {
        type: 'deletion',
        path: f,
      },
    });
  }
  return res;
}
