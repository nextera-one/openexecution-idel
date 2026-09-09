const { cp } = require('node:fs/promises');
const { join, resolve } = require('node:path');
module.exports = {
  appId: 'one.nextera.openexecution.idel', productName: 'OpenExecution IDEL',
  directories: { app: 'dist/desktop-stage/app', output: 'dist/installers' },
  files: ['main.cjs', 'preload.cjs', 'icon.png', 'package.json', 'LICENSE'],
  afterPack: async context => {
    const resources = context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, 'OpenExecution IDEL.app/Contents/Resources')
      : join(context.appOutDir, 'resources');
    await cp(resolve('dist/desktop-stage/runtime'), join(resources, 'runtime'), { recursive: true });
  },
  asar: true,
  npmRebuild: false,
  icon: 'desktop/icon.png',
  artifactName: 'IDEL-${version}-${os}-${arch}.${ext}',
  publish: null,
  win: { target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  mac: { target: ['dmg'], category: 'public.app-category.developer-tools', hardenedRuntime: true },
  linux: { target: ['AppImage', 'deb'], icon: 'desktop/icons', category: 'Development', maintainer: 'Nextera One', executableName: 'idel-desktop' },
};
