/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* jshint node: true */
/* jshint esversion: 6 */

'use strict';

const gulp = require('gulp');
const ts = require('gulp-typescript');
const spawn = require('cross-spawn');
const path = require('path');
const del = require('del');
const fs = require('fs-extra');
const fsExtra = require('fs-extra');
const glob = require('glob');
const _ = require('lodash');
const nativeDependencyChecker = require('node-has-native-dependencies');
const flat = require('flat');
const { argv } = require('yargs');
const os = require('os');
const rmrf = require('rimraf');

const isCI = process.env.TRAVIS === 'true' || process.env.TF_BUILD !== undefined;

gulp.task('compile', (done) => {
    let failed = false;
    const tsProject = ts.createProject('tsconfig.json');
    tsProject
        .src()
        .pipe(tsProject())
        .on('error', () => {
            failed = true;
        })
        .js.pipe(gulp.dest('out'))
        .on('finish', () => (failed ? done(new Error('TypeScript compilation errors')) : done()));
});

gulp.task('precommit', (done) => run({ exitOnError: true, mode: 'staged' }, done));

gulp.task('output:clean', () => del(['coverage']));

gulp.task('clean:cleanExceptTests', () => del(['clean:vsix', 'out/client', 'out/startPage-ui', 'out/server']));
gulp.task('clean:vsix', () => del(['*.vsix']));
gulp.task('clean:out', () => del(['out']));

gulp.task('clean', gulp.parallel('output:clean', 'clean:vsix', 'clean:out'));

gulp.task('checkNativeDependencies', (done) => {
    if (hasNativeDependencies()) {
        done(new Error('Native dependencies detected'));
    }
    done();
});

const webpackEnv = { NODE_OPTIONS: '--max_old_space_size=9096' };

gulp.task('compile-viewers', async () => {
    await buildWebPackForDevOrProduction('./build/webpack/webpack.startPage-ui-viewers.config.js');
});

gulp.task('compile-webviews', gulp.series('compile-viewers'));

async function buildWebPackForDevOrProduction(configFile, configNameForProductionBuilds) {
    if (configNameForProductionBuilds) {
        await buildWebPack(configNameForProductionBuilds, ['--config', configFile], webpackEnv);
    } else {
        await spawnAsync('npm', ['run', 'webpack', '--', '--config', configFile, '--mode', 'production'], webpackEnv);
    }
}
gulp.task('webpack', async () => {
    // Build node_modules.
    await buildWebPackForDevOrProduction('./build/webpack/webpack.extension.dependencies.config.js', 'production');
    await buildWebPackForDevOrProduction('./build/webpack/webpack.startPage-ui-viewers.config.js', 'production');
    await buildWebPackForDevOrProduction('./build/webpack/webpack.extension.config.js', 'extension');
});

gulp.task('addExtensionDependencies', async () => {
    await addExtensionDependencies();
});

async function addExtensionDependencies() {
    // Update the package.json to add extension dependencies at build time so that
    // extension dependencies need not be installed during development
    const packageJsonContents = await fsExtra.readFile('package.json', 'utf-8');
    const packageJson = JSON.parse(packageJsonContents);
    packageJson.extensionDependencies = ['ms-toolsai.jupyter'].concat(
        packageJson.extensionDependencies ? packageJson.extensionDependencies : [],
    );
    await fsExtra.writeFile('package.json', JSON.stringify(packageJson, null, 4), 'utf-8');
}

gulp.task('updateBuildNumber', async () => {
    await updateBuildNumber(argv);
});

async function updateBuildNumber(args) {
    if (args && args.buildNumber) {
        // Edit the version number from the package.json
        const packageJsonContents = await fsExtra.readFile('package.json', 'utf-8');
        const packageJson = JSON.parse(packageJsonContents);

        // Change version number
        const versionParts = packageJson.version.split('.');
        const buildNumberPortion =
            versionParts.length > 2 ? versionParts[2].replace(/(\d+)/, args.buildNumber) : args.buildNumber;
        const newVersion =
            versionParts.length > 1
                ? `${versionParts[0]}.${versionParts[1]}.${buildNumberPortion}`
                : packageJson.version;
        packageJson.version = newVersion;

        // Write back to the package json
        await fsExtra.writeFile('package.json', JSON.stringify(packageJson, null, 4), 'utf-8');

        // Update the changelog.md if we are told to (this should happen on the release branch)
        if (args.updateChangelog) {
            const changeLogContents = await fsExtra.readFile('CHANGELOG.md', 'utf-8');
            const fixedContents = changeLogContents.replace(
                /##\s*(\d+)\.(\d+)\.(\d+)\s*\(/,
                `## $1.$2.${buildNumberPortion} (`,
            );

            // Write back to changelog.md
            await fsExtra.writeFile('CHANGELOG.md', fixedContents, 'utf-8');
        }
    } else {
        throw Error('buildNumber argument required for updateBuildNumber task');
    }
}

async function buildWebPack(webpackConfigName, args, env) {
    // Remember to perform a case insensitive search.
    const allowedWarnings = getAllowedWarningsForWebPack(webpackConfigName).map((item) => item.toLowerCase());
    const stdOut = await spawnAsync(
        'npm',
        ['run', 'webpack', '--', ...args, ...['--mode', 'production', '--devtool', 'source-map']],
        env,
    );
    const stdOutLines = stdOut
        .split(os.EOL)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    // Remember to perform a case insensitive search.
    const warnings = stdOutLines
        .filter((item) => item.startsWith('WARNING in '))
        .filter(
            (item) =>
                allowedWarnings.findIndex((allowedWarning) =>
                    item.toLowerCase().startsWith(allowedWarning.toLowerCase()),
                ) === -1,
        );
    const errors = stdOutLines.some((item) => item.startsWith('ERROR in'));
    if (errors) {
        throw new Error(`Errors in ${webpackConfigName}, \n${warnings.join(', ')}\n\n${stdOut}`);
    }
    if (warnings.length > 0) {
        throw new Error(
            `Warnings in ${webpackConfigName}, Check gulpfile.js to see if the warning should be allowed., \n\n${stdOut}`,
        );
    }
}
function getAllowedWarningsForWebPack(buildConfig) {
    switch (buildConfig) {
        case 'production':
            return [
                'WARNING in asset size limit: The following asset(s) exceed the recommended size limit (244 KiB).',
                'WARNING in entrypoint size limit: The following entrypoint(s) combined asset size exceeds the recommended limit (244 KiB). This can impact web performance.',
                'WARNING in webpack performance recommendations:',
                'WARNING in ./node_modules/encoding/lib/iconv-loader.js',
                'WARNING in ./node_modules/any-promise/register.js',
                'WARNING in ./node_modules/log4js/lib/appenders/index.js',
                'WARNING in ./node_modules/log4js/lib/clustering.js',
                'WARNING in ./node_modules/diagnostic-channel-publishers/dist/src/azure-coretracing.pub.js',
                'WARNING in ./node_modules/applicationinsights/out/AutoCollection/NativePerformance.js',
            ];
        case 'extension':
            return [
                'WARNING in ./node_modules/encoding/lib/iconv-loader.js',
                'WARNING in ./node_modules/any-promise/register.js',
                'remove-files-plugin@1.4.0:',
                'WARNING in ./node_modules/diagnostic-channel-publishers/dist/src/azure-coretracing.pub.js',
                'WARNING in ./node_modules/applicationinsights/out/AutoCollection/NativePerformance.js',
            ];
        case 'debugAdapter':
            return [
                'WARNING in ./node_modules/vscode-uri/lib/index.js',
                'WARNING in ./node_modules/diagnostic-channel-publishers/dist/src/azure-coretracing.pub.js',
                'WARNING in ./node_modules/applicationinsights/out/AutoCollection/NativePerformance.js',
            ];
        default:
            throw new Error('Unknown WebPack Configuration');
    }
}
gulp.task('renameSourceMaps', async () => {
    // By default source maps will be disabled in the extension.
    // Users will need to use the command `python.enableSourceMapSupport` to enable source maps.
    const extensionSourceMap = path.join(__dirname, 'out', 'client', 'extension.js.map');
    await fs.rename(extensionSourceMap, `${extensionSourceMap}.disabled`);
});

gulp.task('verifyBundle', async () => {
    const matches = await glob.sync(path.join(__dirname, '*.vsix'));
    if (!matches || matches.length === 0) {
        throw new Error('Bundle does not exist');
    } else {
        console.log(`Bundle ${matches[0]} exists.`);
    }
});

gulp.task('prePublishBundle', gulp.series('webpack', 'renameSourceMaps'));
gulp.task('checkDependencies', gulp.series('checkNativeDependencies'));
gulp.task('prePublishNonBundle', gulp.series('compile', 'compile-webviews'));

gulp.task('installPythonRequirements', async () => {
    let args = [
        '-m',
        'pip',
        '--disable-pip-version-check',
        'install',
        '-t',
        './pythonFiles/lib/python',
        '--no-cache-dir',
        '--implementation',
        'py',
        '--no-deps',
        '--upgrade',
        '-r',
        './requirements.txt',
    ];
    let success = await spawnAsync(process.env.CI_PYTHON_PATH || 'python3', args, undefined, true)
        .then(() => true)
        .catch((ex) => {
            console.error("Failed to install Python Libs using 'python3'", ex);
            return false;
        });
    if (!success) {
        console.info("Failed to install Python Libs using 'python3', attempting to install using 'python'");
        await spawnAsync('python', args).catch((ex) =>
            console.error("Failed to install Python Libs using 'python'", ex),
        );
        return;
    }

    args = [
        '-m',
        'pip',
        '--disable-pip-version-check',
        'install',
        '-t',
        './pythonFiles/lib/jedilsp',
        '--no-cache-dir',
        '--implementation',
        'py',
        '--no-deps',
        '--upgrade',
        '-r',
        './jedils_requirements.txt',
    ];
    success = await spawnAsync(process.env.CI_PYTHON_PATH || 'python3', args, undefined, true)
        .then(() => true)
        .catch((ex) => {
            console.error("Failed to install Python Libs using 'python3'", ex);
            return false;
        });
    if (!success) {
        console.info("Failed to install Python Libs using 'python3', attempting to install using 'python'");
        await spawnAsync('python', args).catch((ex) =>
            console.error("Failed to install Python Libs using 'python'", ex),
        );
    }
});

// See https://github.com/microsoft/vscode-python/issues/7136
gulp.task('installDebugpy', async () => {
    // Install dependencies needed for 'install_debugpy.py'
    const depsArgs = [
        '-m',
        'pip',
        '--disable-pip-version-check',
        'install',
        '-t',
        './pythonFiles/lib/temp',
        '-r',
        './build/debugger-install-requirements.txt',
    ];
    const successWithWheelsDeps = await spawnAsync(process.env.CI_PYTHON_PATH || 'python3', depsArgs, undefined, true)
        .then(() => true)
        .catch((ex) => {
            console.error("Failed to install new DEBUGPY wheels using 'python3'", ex);
            return false;
        });
    if (!successWithWheelsDeps) {
        console.info(
            "Failed to install dependencies need by 'install_debugpy.py' using 'python3', attempting to install using 'python'",
        );
        await spawnAsync('python', depsArgs).catch((ex) =>
            console.error("Failed to install dependencies need by 'install_debugpy.py' using 'python'", ex),
        );
    }

    // Install new DEBUGPY with wheels for python 3.7
    const wheelsArgs = ['./pythonFiles/install_debugpy.py'];
    const wheelsEnv = { PYTHONPATH: './pythonFiles/lib/temp' };
    const successWithWheels = await spawnAsync(process.env.CI_PYTHON_PATH || 'python3', wheelsArgs, wheelsEnv, true)
        .then(() => true)
        .catch((ex) => {
            console.error("Failed to install new DEBUGPY wheels using 'python3'", ex);
            return false;
        });
    if (!successWithWheels) {
        console.info("Failed to install new DEBUGPY wheels using 'python3', attempting to install using 'python'");
        await spawnAsync('python', wheelsArgs, wheelsEnv).catch((ex) =>
            console.error("Failed to install DEBUGPY wheels using 'python'", ex),
        );
    }

    rmrf.sync('./pythonFiles/lib/temp');
});

gulp.task('installPythonLibs', gulp.series('installPythonRequirements', 'installDebugpy'));

function spawnAsync(command, args, env, rejectOnStdErr = false) {
    env = env || {};
    env = { ...process.env, ...env };
    return new Promise((resolve, reject) => {
        let stdOut = '';
        console.info(`> ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, { cwd: __dirname, env });
        proc.stdout.on('data', (data) => {
            // Log output on CI (else travis times out when there's not output).
            stdOut += data.toString();
            if (isCI) {
                console.log(data.toString());
            }
        });
        proc.stderr.on('data', (data) => {
            console.error(data.toString());
            if (rejectOnStdErr) {
                reject(data.toString());
            }
        });
        proc.on('close', () => resolve(stdOut));
        proc.on('error', (error) => reject(error));
    });
}

function hasNativeDependencies() {
    let nativeDependencies = nativeDependencyChecker.check(path.join(__dirname, 'node_modules'));
    if (!Array.isArray(nativeDependencies) || nativeDependencies.length === 0) {
        return false;
    }
    const dependencies = JSON.parse(spawn.sync('npm', ['ls', '--json', '--prod']).stdout.toString());
    const jsonProperties = Object.keys(flat.flatten(dependencies));
    nativeDependencies = _.flatMap(nativeDependencies, (item) =>
        path.dirname(item.substring(item.indexOf('node_modules') + 'node_modules'.length)).split(path.sep),
    )
        .filter((item) => item.length > 0)
        .filter((item) => !item.includes('zeromq') && item !== 'fsevents' && !item.includes('canvas')) // This is a known native. Allow this one for now
        .filter(
            (item) =>
                jsonProperties.findIndex((flattenedDependency) =>
                    flattenedDependency.endsWith(`dependencies.${item}.version`),
                ) >= 0,
        );
    if (nativeDependencies.length > 0) {
        console.error('Native dependencies detected', nativeDependencies);
        return true;
    }
    return false;
}
