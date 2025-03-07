import { existsSync, promises as fs } from 'node:fs'
import { resolve } from 'pathe'
import type { AfterSuiteRunMeta, CoverageIstanbulOptions, CoverageProvider, ReportContext, ResolvedCoverageOptions, Vitest } from 'vitest'
import { coverageConfigDefaults, defaultExclude, defaultInclude } from 'vitest/config'
import { BaseCoverageProvider } from 'vitest/coverage'
import c from 'picocolors'
import libReport from 'istanbul-lib-report'
import reports from 'istanbul-reports'
import type { CoverageMap } from 'istanbul-lib-coverage'
import libCoverage from 'istanbul-lib-coverage'
import libSourceMaps from 'istanbul-lib-source-maps'
import { type Instrumenter, createInstrumenter } from 'istanbul-lib-instrument'

// @ts-expect-error missing types
import _TestExclude from 'test-exclude'
import { COVERAGE_STORE_KEY } from './constants'

type Options = ResolvedCoverageOptions<'istanbul'>

interface TestExclude {
  new(opts: {
    cwd?: string | string[]
    include?: string | string[]
    exclude?: string | string[]
    extension?: string | string[]
    excludeNodeModules?: boolean
    relativePath?: boolean
  }): {
    shouldInstrument(filePath: string): boolean
    glob(cwd: string): Promise<string[]>
  }
}

export class IstanbulCoverageProvider extends BaseCoverageProvider implements CoverageProvider {
  name = 'istanbul'

  ctx!: Vitest
  options!: Options
  instrumenter!: Instrumenter
  testExclude!: InstanceType<TestExclude>

  /**
   * Coverage objects collected from workers.
   * Some istanbul utilizers write these into file system instead of storing in memory.
   * If storing in memory causes issues, we can simply write these into fs in `onAfterSuiteRun`
   * and read them back when merging coverage objects in `onAfterAllFilesRun`.
   */
  coverages: any[] = []

  initialize(ctx: Vitest) {
    const config: CoverageIstanbulOptions = ctx.config.coverage

    this.ctx = ctx
    this.options = {
      ...coverageConfigDefaults,

      // User's options
      ...config,

      // Resolved fields
      provider: 'istanbul',
      reportsDirectory: resolve(ctx.config.root, config.reportsDirectory || coverageConfigDefaults.reportsDirectory),
      reporter: this.resolveReporters(config.reporter || coverageConfigDefaults.reporter),
    }

    this.instrumenter = createInstrumenter({
      produceSourceMap: true,
      autoWrap: false,
      esModules: true,
      compact: false,
      coverageVariable: COVERAGE_STORE_KEY,
      // @ts-expect-error missing type
      coverageGlobalScope: 'globalThis',
      coverageGlobalScopeFunc: false,
      ignoreClassMethods: this.options.ignoreClassMethods,
    })

    this.testExclude = new _TestExclude({
      cwd: ctx.config.root,
      include: typeof this.options.include === 'undefined' ? undefined : [...this.options.include],
      exclude: [...defaultExclude, ...defaultInclude, ...this.options.exclude],
      excludeNodeModules: true,
      extension: this.options.extension,
      relativePath: !this.options.allowExternal,
    })
  }

  resolveOptions() {
    return this.options
  }

  onFileTransform(sourceCode: string, id: string, pluginCtx: any) {
    if (!this.testExclude.shouldInstrument(id))
      return

    const sourceMap = pluginCtx.getCombinedSourcemap()
    sourceMap.sources = sourceMap.sources.map(removeQueryParameters)

    const code = this.instrumenter.instrumentSync(sourceCode, id, sourceMap as any)
    const map = this.instrumenter.lastSourceMap() as any

    return { code, map }
  }

  onAfterSuiteRun({ coverage }: AfterSuiteRunMeta) {
    this.coverages.push(coverage)
  }

  async clean(clean = true) {
    if (clean && existsSync(this.options.reportsDirectory))
      await fs.rm(this.options.reportsDirectory, { recursive: true, force: true, maxRetries: 10 })

    this.coverages = []
  }

  async reportCoverage({ allTestsRun }: ReportContext = {}) {
    const mergedCoverage: CoverageMap = this.coverages.reduce((coverage, previousCoverageMap) => {
      const map = libCoverage.createCoverageMap(coverage)
      map.merge(previousCoverageMap)
      return map
    }, libCoverage.createCoverageMap({}))

    if (this.options.all && allTestsRun)
      await this.includeUntestedFiles(mergedCoverage)

    includeImplicitElseBranches(mergedCoverage)

    const sourceMapStore = libSourceMaps.createSourceMapStore()
    const coverageMap: CoverageMap = await sourceMapStore.transformCoverage(mergedCoverage)

    const context = libReport.createContext({
      dir: this.options.reportsDirectory,
      coverageMap,
      sourceFinder: sourceMapStore.sourceFinder,
      watermarks: this.options.watermarks,
    })

    if (hasTerminalReporter(this.options.reporter))
      this.ctx.logger.log(c.blue(' % ') + c.dim('Coverage report from ') + c.yellow(this.name))

    for (const reporter of this.options.reporter) {
      reports.create(reporter[0], {
        skipFull: this.options.skipFull,
        projectRoot: this.ctx.config.root,
        ...reporter[1],
      }).execute(context)
    }

    if (this.options.branches
      || this.options.functions
      || this.options.lines
      || this.options.statements) {
      this.checkThresholds({
        coverageMap,
        thresholds: {
          branches: this.options.branches,
          functions: this.options.functions,
          lines: this.options.lines,
          statements: this.options.statements,
        },
        perFile: this.options.perFile,
      })
    }

    if (this.options.thresholdAutoUpdate && allTestsRun) {
      this.updateThresholds({
        coverageMap,
        thresholds: {
          branches: this.options.branches,
          functions: this.options.functions,
          lines: this.options.lines,
          statements: this.options.statements,
        },
        perFile: this.options.perFile,
        configurationFile: this.ctx.server.config.configFile,
      })
    }
  }

  async includeUntestedFiles(coverageMap: CoverageMap) {
    // Load, instrument and collect empty coverages from all files which
    // are not already in the coverage map
    const includedFiles = await this.testExclude.glob(this.ctx.config.root)
    const uncoveredFiles = includedFiles
      .map(file => resolve(this.ctx.config.root, file))
      .filter(file => !coverageMap.data[file])

    const transformResults = await Promise.all(uncoveredFiles.map(async (filename) => {
      const transformResult = await this.ctx.vitenode.transformRequest(filename)
      return { transformResult, filename }
    }))

    for (const { transformResult, filename } of transformResults) {
      const sourceMap = transformResult?.map

      if (sourceMap) {
        this.instrumenter.instrumentSync(
          transformResult.code,
          filename,
          sourceMap as any,
        )

        const lastCoverage = this.instrumenter.lastFileCoverage()
        if (lastCoverage)
          coverageMap.addFileCoverage(lastCoverage)
      }
    }
  }
}

/**
 * Remove possible query parameters from filenames
 * - From `/src/components/Header.component.ts?vue&type=script&src=true&lang.ts`
 * - To `/src/components/Header.component.ts`
 */
function removeQueryParameters(filename: string) {
  return filename.split('?')[0]
}

/**
 * Work-around for #1887 and #2239 while waiting for https://github.com/istanbuljs/istanbuljs/pull/706
 *
 * Goes through all files in the coverage map and checks if branchMap's have
 * if-statements with implicit else. When finds one, copies source location of
 * the if-statement into the else statement.
 */
function includeImplicitElseBranches(coverageMap: CoverageMap) {
  for (const file of coverageMap.files()) {
    const fileCoverage = coverageMap.fileCoverageFor(file)

    for (const branchMap of Object.values(fileCoverage.branchMap)) {
      if (branchMap.type === 'if') {
        const lastIndex = branchMap.locations.length - 1

        if (lastIndex > 0) {
          const elseLocation = branchMap.locations[lastIndex]

          if (elseLocation && isEmptyCoverageRange(elseLocation)) {
            const ifLocation = branchMap.locations[0]

            elseLocation.start = { ...ifLocation.start }
            elseLocation.end = { ...ifLocation.end }
          }
        }
      }
    }
  }
}

function isEmptyCoverageRange(range: libCoverage.Range) {
  return (
    range.start === undefined
    || range.start.line === undefined
    || range.start.column === undefined
    || range.end === undefined
    || range.end.line === undefined
    || range.end.column === undefined
  )
}

function hasTerminalReporter(reporters: Options['reporter']) {
  return reporters.some(([reporter]) =>
    reporter === 'text'
    || reporter === 'text-summary'
    || reporter === 'text-lcov'
    || reporter === 'teamcity')
}
