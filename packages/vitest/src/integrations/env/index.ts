import { pathToFileURL } from 'node:url'
import { normalize, resolve } from 'pathe'
import { resolvePath } from 'mlly'
import type { BuiltinEnvironment, VitestEnvironment } from '../../types/config'
import type { Environment } from '../../types'
import node from './node'
import jsdom from './jsdom'
import happy from './happy-dom'
import edge from './edge-runtime'

export const environments = {
  node,
  jsdom,
  'happy-dom': happy,
  'edge-runtime': edge,
}

export const envs = Object.keys(environments)

export const envPackageNames: Record<Exclude<keyof typeof environments, 'node'>, string> = {
  'jsdom': 'jsdom',
  'happy-dom': 'happy-dom',
  'edge-runtime': '@edge-runtime/vm',
}

function isBuiltinEnvironment(env: VitestEnvironment): env is BuiltinEnvironment {
  return env in environments
}

export function getEnvPackageName(env: VitestEnvironment) {
  if (env === 'node')
    return null
  if (env in envPackageNames)
    return (envPackageNames as any)[env]
  return `vitest-environment-${env}`
}

export async function loadEnvironment(name: VitestEnvironment, root: string): Promise<Environment> {
  if (isBuiltinEnvironment(name))
    return environments[name]
  const packageId = name[0] === '.' || name[0] === '/'
    ? resolve(root, name)
    : await resolvePath(`vitest-environment-${name}`, { url: [root] }) ?? resolve(root, name)
  const pkg = await import(pathToFileURL(normalize(packageId)).href)
  if (!pkg || !pkg.default || typeof pkg.default !== 'object') {
    throw new TypeError(
      `Environment "${name}" is not a valid environment. `
    + `Path "${packageId}" should export default object with a "setup" or/and "setupVM" method.`,
    )
  }
  const environment = pkg.default
  if (environment.transformMode !== 'web' && environment.transformMode !== 'ssr') {
    throw new TypeError(
      `Environment "${name}" is not a valid environment. `
    + `Path "${packageId}" should export default object with a "transformMode" method equal to "ssr" or "web".`,
    )
  }
  return environment
}
