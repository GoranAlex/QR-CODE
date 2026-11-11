export function apiMountPaths(basePath, options = {}) {
  const paths = new Set(['/QrCode/api'])

  if (basePath) {
    paths.add(`${basePath}/api`)
  }

  if (!options.isProduction || options.allowRootApi) {
    paths.add('/api')
  }

  return [...paths]
}
