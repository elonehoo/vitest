import { importModule } from 'local-pkg'
import type { Environment } from '../../types'
import { populateGlobal } from './utils'

export default <Environment>({
  name: 'happy-dom',
  transformMode: 'web',
  async setupVM({ happyDOM = {} }) {
    const { Window } = await importModule('happy-dom') as typeof import('happy-dom')
    const win = new Window({
      ...happyDOM,
      url: happyDOM.url || 'http://localhost:3000',
    }) as any

    // TODO: browser doesn't expose Buffer, but a lot of dependencies use it
    win.Buffer = Buffer

    // inject structuredClone if it exists
    if (typeof structuredClone !== 'undefined' && !win.structuredClone)
      win.structuredClone = structuredClone

    return {
      getVmContext() {
        return win
      },
      async teardown() {
        await win.happyDOM.cancelAsync()
      },
    }
  },
  async setup(global, { happyDOM = {} }) {
    // happy-dom v3 introduced a breaking change to Window, but
    // provides GlobalWindow as a way to use previous behaviour
    const { Window, GlobalWindow } = await importModule('happy-dom') as typeof import('happy-dom')
    const win = new (GlobalWindow || Window)({
      ...happyDOM,
      url: happyDOM.url || 'http://localhost:3000',
    })

    const { keys, originals } = populateGlobal(global, win, { bindFunctions: true })

    return {
      teardown(global) {
        win.happyDOM.cancelAsync()
        keys.forEach(key => delete global[key])
        originals.forEach((v, k) => global[k] = v)
      },
    }
  },
})
