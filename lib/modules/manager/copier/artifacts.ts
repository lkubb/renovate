import is from '@sindresorhus/is';
import { quote } from 'shlex';
import { GlobalConfig } from '../../../config/global';
import { logger } from '../../../logger';
import { coerceArray } from '../../../util/array';
import { exec } from '../../../util/exec';
import type { ExecOptions } from '../../../util/exec/types';
import { readLocalFile } from '../../../util/fs';
import { getRepoStatus } from '../../../util/git';
import type {
  UpdateArtifact,
  UpdateArtifactsConfig,
  UpdateArtifactsResult,
} from '../types';

const DEFAULT_COMMAND_OPTIONS = ['--skip-answered', '--defaults'];

function buildCommand(
  config: UpdateArtifactsConfig,
  packageFileName: string,
  newVersion: string,
): string {
  const command = ['copier', 'update', ...DEFAULT_COMMAND_OPTIONS];
  if (GlobalConfig.get('allowScripts') && !config.ignoreScripts) {
    command.push('--trust');
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

function getPythonVersionConstraint(
  config: UpdateArtifactsConfig,
): string | undefined | null {
  const { constraints = {} } = config;
  const { python } = constraints;

  if (python) {
    logger.debug('Using python constraint from config');
    return python;
  }

  return undefined;
}

function getCopierVersionConstraint(config: UpdateArtifactsConfig): string {
  const { constraints = {} } = config;
  const { copier } = constraints;

  if (is.string(copier)) {
    logger.debug('Using copier constraint from config');
    return copier;
  }

  return '';
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

  const command = buildCommand(config, packageFileName, newVersion);
  const pythonConstraint = getPythonVersionConstraint(config);
  const copierConstraint = getCopierVersionConstraint(config);
  const execOptions: ExecOptions = {
    docker: {},
    userConfiguredEnv: config.env,
    toolConstraints: [
      {
        toolName: 'python',
        constraint: pythonConstraint,
      },
      {
        toolName: 'copier',
        constraint: copierConstraint,
      },
    ],
  };
  try {
    await exec(command, execOptions);
  } catch (err) {
    logger.debug({ err }, `Failed to update copier template: ${err.message}`);
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
    logger.debug({ packageFileName, depName: updatedDeps[0]?.depName }, msg);
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
