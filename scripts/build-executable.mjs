import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stagingDirectory = join(projectRoot, 'dist', '.sea');
const releaseDirectory = join(projectRoot, 'release');
const bundlePath = join(stagingDirectory, 'cli.cjs');
const blobPath = join(stagingDirectory, 'sea-prep.blob');
const configPath = join(stagingDirectory, 'sea-config.json');
const noticesPath = join(releaseDirectory, 'THIRD_PARTY_NOTICES.txt');
const projectLicensePath = join(projectRoot, 'LICENSE');
const releaseLicensePath = join(releaseDirectory, 'LICENSE.txt');
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const platformNames = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};
const supportedArchitectures = new Set(['arm64', 'x64']);

function fail(message) {
  throw new Error(message);
}

function run(command, args, description, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });

  if (result.error) {
    fail(`${description} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .join('\n')
      .trim();
    fail(`${description} failed with exit code ${result.status}.${output ? `\n${output}` : ''}`);
  }
  return result;
}

function validateEnvironment() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    fail(
      `Building a standalone executable requires Node.js 20 or newer. ` +
        `Current version: ${process.version}.`,
    );
  }

  if (!(process.platform in platformNames)) {
    fail(`Unsupported build platform: ${process.platform}.`);
  }
  if (!supportedArchitectures.has(process.arch)) {
    fail(`Unsupported build architecture: ${process.arch}.`);
  }

  const seaHelp = run(process.execPath, ['--help'], 'Checking Node.js SEA support');
  if (!seaHelp.stdout.includes('--experimental-sea-config')) {
    fail(
      `Node.js ${process.version} does not expose --experimental-sea-config. ` +
        'Use a Node.js build with Single Executable Application support.',
    );
  }
}

async function bundleApplication() {
  console.log('Bundling application...');
  return build({
    entryPoints: [join(projectRoot, 'src', 'cli.ts')],
    outfile: bundlePath,
    bundle: true,
    define: {
      'import.meta.url': '__copilot_relay_import_meta_url',
    },
    banner: {
      js:
        'const __copilot_relay_import_meta_url = ' +
        'require("node:url").pathToFileURL(__filename).href;',
    },
    format: 'cjs',
    legalComments: 'eof',
    logLevel: 'warning',
    metafile: true,
    platform: 'node',
    sourcemap: false,
    target: `node${process.versions.node.split('.')[0]}`,
  });
}

function findPackageRoot(inputPath) {
  const absoluteInput = resolve(projectRoot, inputPath).replaceAll('\\', '/');
  const marker = '/node_modules/';
  const markerIndex = absoluteInput.lastIndexOf(marker);
  if (markerIndex === -1) return undefined;

  const packagePath = absoluteInput.slice(markerIndex + marker.length);
  const pathParts = packagePath.split('/');
  const packageName = pathParts[0].startsWith('@')
    ? `${pathParts[0]}/${pathParts[1]}`
    : pathParts[0];
  return absoluteInput.slice(0, markerIndex + marker.length) + packageName;
}

function findLicenseFile(packageRoot) {
  const licenseEntry = readdirSync(packageRoot, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /^licen[cs]e(?:\..*)?$/i.test(entry.name),
  );
  return licenseEntry ? join(packageRoot, licenseEntry.name) : undefined;
}

function findNodeLicense() {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    join(executableDirectory, 'LICENSE'),
    resolve(executableDirectory, '..', 'LICENSE'),
    '/usr/share/doc/nodejs/copyright',
    '/usr/share/doc/node/copyright',
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function writeThirdPartyNotices(metafile) {
  const packageRoots = new Set(
    Object.keys(metafile.inputs)
      .map(findPackageRoot)
      .filter((packageRoot) => packageRoot !== undefined),
  );
  const packages = [...packageRoots]
    .map((packageRoot) => {
      const packageJsonPath = join(packageRoot, 'package.json');
      if (!existsSync(packageJsonPath)) {
        fail(`Bundled package metadata was not found at ${packageJsonPath}.`);
      }
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const licensePath = findLicenseFile(packageRoot);
      if (!licensePath) {
        fail(`Bundled package ${packageJson.name} does not contain a license file.`);
      }
      return {
        name: packageJson.name,
        version: packageJson.version,
        license: packageJson.license,
        text: readFileSync(licensePath, 'utf8').trim(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const nodeLicensePath = findNodeLicense();
  if (!nodeLicensePath) {
    fail(
      `The Node.js license file was not found beside ${process.execPath}. ` +
        'Use an official Node.js distribution that includes its LICENSE file.',
    );
  }

  const sections = [
    `Node.js ${process.version}\n\n${readFileSync(nodeLicensePath, 'utf8').trim()}`,
    ...packages.map(
      (packageInfo) =>
        `${packageInfo.name} ${packageInfo.version} (${packageInfo.license})\n\n` +
        packageInfo.text,
    ),
  ];
  writeFileSync(
    noticesPath,
    [
      'Third-party software included in the copilot-relay standalone executable',
      '',
      ...sections.flatMap((section, index) =>
        index === sections.length - 1
          ? [section]
          : [section, '', '='.repeat(79), ''],
      ),
      '',
    ].join('\n'),
    'utf8',
  );
}

function generateBlob() {
  console.log('Generating SEA preparation blob...');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    ),
    'utf8',
  );
  run(
    process.execPath,
    ['--experimental-sea-config', configPath],
    'Generating the SEA preparation blob',
  );
  if (!existsSync(blobPath)) {
    fail(`Node.js did not create the expected SEA blob at ${blobPath}.`);
  }
}

function removeExistingSignature(executablePath) {
  if (process.platform === 'darwin') {
    run(
      '/usr/bin/codesign',
      ['--remove-signature', executablePath],
      'Removing the Node.js code signature',
    );
    return;
  }

  if (process.platform !== 'win32') return;
  const result = spawnSync('signtool', ['remove', '/s', executablePath], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') {
    console.log('Windows SDK signtool not found; continuing with an unsigned executable.');
    return;
  }
  if (result.error) {
    fail(`Removing the Node.js code signature failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `Removing the Node.js code signature failed with exit code ${result.status}.\n` +
        `${result.stderr || result.stdout}`.trim(),
    );
  }
}

function injectBlob(executablePath) {
  console.log('Injecting application into the Node.js executable...');
  const postjectCli = require.resolve('postject/dist/cli.js');
  const args = [
    postjectCli,
    executablePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    seaFuse,
  ];
  if (process.platform === 'darwin') {
    args.push('--macho-segment-name', 'NODE_SEA');
  }
  run(process.execPath, args, 'Injecting the SEA blob');

  if (process.platform === 'darwin') {
    run('/usr/bin/codesign', ['--sign', '-', executablePath], 'Ad-hoc signing the executable');
  }
}

function smokeTest(executablePath) {
  console.log('Running standalone executable smoke test...');
  const result = run(executablePath, ['--help'], 'Standalone executable smoke test', {
    env: { ...process.env, PATH: '' },
    timeout: 30_000,
  });
  if (!result.stdout.includes('Usage: copilot-relay')) {
    fail('Standalone executable smoke test did not return the expected CLI help.');
  }
}

function writeChecksum(executablePath) {
  const digest = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
  const checksumPath = `${executablePath}.sha256`;
  writeFileSync(checksumPath, `${digest}  ${basename(executablePath)}\n`, 'utf8');
  return checksumPath;
}

async function main() {
  validateEnvironment();

  const platformName = platformNames[process.platform];
  const extension = process.platform === 'win32' ? '.exe' : '';
  const executableName = `copilot-relay-${platformName}-${process.arch}${extension}`;
  const executablePath = join(releaseDirectory, executableName);
  const checksumPath = `${executablePath}.sha256`;
  const releaseArtifacts = [executablePath, checksumPath, noticesPath, releaseLicensePath];

  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  mkdirSync(releaseDirectory, { recursive: true });
  for (const artifactPath of releaseArtifacts) {
    rmSync(artifactPath, { force: true });
  }

  try {
    const buildResult = await bundleApplication();
    generateBlob();

    copyFileSync(process.execPath, executablePath);
    if (process.platform !== 'win32') chmodSync(executablePath, 0o755);
    removeExistingSignature(executablePath);
    injectBlob(executablePath);
    smokeTest(executablePath);

    copyFileSync(projectLicensePath, releaseLicensePath);
    writeThirdPartyNotices(buildResult.metafile);
    writeChecksum(executablePath);
    rmSync(stagingDirectory, { recursive: true, force: true });

    console.log('');
    console.log('Standalone executable created:');
    console.log(`  ${executablePath}`);
    console.log(`  ${checksumPath}`);
    console.log(`  ${releaseLicensePath}`);
    console.log(`  ${noticesPath}`);
    if (process.platform === 'win32') {
      console.log('  Sign the executable before public distribution to avoid SmartScreen warnings.');
    }
  } catch (error) {
    for (const artifactPath of releaseArtifacts) {
      rmSync(artifactPath, { force: true });
    }
    throw error;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`build:exe failed: ${message}`);
  console.error(`Build staging files were kept at ${stagingDirectory}`);
  process.exitCode = 1;
});
