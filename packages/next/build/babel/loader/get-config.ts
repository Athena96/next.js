import { createConfigItem, loadOptions } from 'next/dist/compiled/babel/core'
import loadConfig from 'next/dist/compiled/babel/core-lib-config'

import nextBabelPreset from '../preset'
import { NextBabelLoaderOptions, NextJsLoaderContext } from './types'
import { consumeIterator } from './util'

const nextDistPath = /(next[\\/]dist[\\/]next-server[\\/]lib)|(next[\\/]dist[\\/]client)|(next[\\/]dist[\\/]pages)/

/**
 * The properties defined here are the conditions with which subsets of inputs
 * can be identified that are able to share a common Babel config.  For example,
 * in dev mode, different transforms must be applied to a source file depending
 * on whether you're compiling for the client or for the server - thus `isServer`
 * is germane.
 *
 * However, these characteristics need not protect against circumstances that
 * will not be encountered in Next.js.  For example, a source file may be
 * transformed differently depending on whether we're doing a production compile
 * or for HMR in dev mode.  However, those two circumstances will never be
 * encountered within the context of a single V8 context (and, thus, shared
 * cache).  Therefore, hasReactRefresh is _not_ germane to caching.
 *
 * NOTE: This approach does not support multiple `.babelrc` files in a
 * single project.  A per-cache-key config will be generated once and,
 * if `.babelrc` is present, that config will be used for any subsequent
 * transformations.
 */
interface CharacteristicsGermaneToCaching {
  isServer: boolean
  isPageFile: boolean
  isNextDist: boolean
  hasModuleExports: boolean
}

function getCacheCharacteristics(
  loaderOptions: NextBabelLoaderOptions,
  source: string,
  filename: string
): CharacteristicsGermaneToCaching {
  const { isServer, pagesDir } = loaderOptions
  const isPageFile = filename.startsWith(pagesDir)
  const isNextDist = nextDistPath.test(filename)
  const hasModuleExports = source.indexOf('module.exports') !== -1

  return {
    isServer,
    isPageFile,
    isNextDist,
    hasModuleExports,
  }
}

/**
 * Return an array of Babel plugins, conditioned upon loader options and
 * source file characteristics.
 */
function getPlugins(
  loaderOptions: NextBabelLoaderOptions,
  cacheCharacteristics: CharacteristicsGermaneToCaching
) {
  const {
    isServer,
    isPageFile,
    isNextDist,
    hasModuleExports,
  } = cacheCharacteristics

  const { hasReactRefresh, development } = loaderOptions

  const applyCommonJsItem = hasModuleExports
    ? createConfigItem(require('../plugins/commonjs'), { type: 'plugin' })
    : null
  const reactRefreshItem = hasReactRefresh
    ? createConfigItem(
        [require('react-refresh/babel'), { skipEnvCheck: true }],
        { type: 'plugin' }
      )
    : null
  const noAnonymousDefaultExportItem =
    hasReactRefresh && !isServer
      ? createConfigItem(
          [require('../plugins/no-anonymous-default-export'), {}],
          { type: 'plugin' }
        )
      : null
  const pageConfigItem =
    !isServer && isPageFile
      ? createConfigItem([require('../plugins/next-page-config')], {
          type: 'plugin',
        })
      : null
  const disallowExportAllItem =
    !isServer && isPageFile
      ? createConfigItem(
          [require('../plugins/next-page-disallow-re-export-all-exports')],
          { type: 'plugin' }
        )
      : null
  const transformDefineItem = createConfigItem(
    [
      require.resolve('next/dist/compiled/babel/plugin-transform-define'),
      {
        'process.env.NODE_ENV': development ? 'development' : 'production',
        'typeof window': isServer ? 'undefined' : 'object',
        'process.browser': isServer ? false : true,
      },
      'next-js-transform-define-instance',
    ],
    { type: 'plugin' }
  )
  const nextSsgItem =
    !isServer && isPageFile
      ? createConfigItem([require.resolve('../plugins/next-ssg-transform')], {
          type: 'plugin',
        })
      : null
  const commonJsItem = isNextDist
    ? createConfigItem(
        require('next/dist/compiled/babel/plugin-transform-modules-commonjs'),
        { type: 'plugin' }
      )
    : null

  return [
    noAnonymousDefaultExportItem,
    reactRefreshItem,
    pageConfigItem,
    disallowExportAllItem,
    applyCommonJsItem,
    transformDefineItem,
    nextSsgItem,
    commonJsItem,
  ].filter(Boolean)
}

/**
 * Generate a new, flat Babel config, ready to be handed to Babel-traverse.
 * This config should have no unresolved overrides, presets, etc.
 */
function getFreshConfig(
  this: NextJsLoaderContext,
  cacheCharacteristics: CharacteristicsGermaneToCaching,
  loaderOptions: NextBabelLoaderOptions,
  target: string,
  filename: string,
  inputSourceMap?: object | null
) {
  const {
    presets = [],
    isServer,
    pagesDir,
    development,
    hasReactRefresh,
    hasJsxRuntime,
    babelrc,
  } = loaderOptions
  const nextPresetItem = createConfigItem(nextBabelPreset, { type: 'preset' })

  let options = {
    babelrc,
    cloneInputAst: false,
    filename,
    inputSourceMap: inputSourceMap || undefined,

    // Set the default sourcemap behavior based on Webpack's mapping flag,
    // but allow users to override if they want.
    sourceMaps:
      loaderOptions.sourceMaps === undefined
        ? inputSourceMap
        : loaderOptions.sourceMaps,

    // Ensure that Webpack will get a full absolute path in the sourcemap
    // so that it can properly map the module back to its internal cached
    // modules.
    sourceFileName: filename,

    plugins: getPlugins(loaderOptions, cacheCharacteristics),

    presets: [...presets, nextPresetItem],

    overrides: loaderOptions.overrides,

    caller: {
      name: 'next-babel-turbo-loader',
      supportsStaticESM: true,
      supportsDynamicImport: true,

      // Provide plugins with insight into webpack target.
      // https://github.com/babel/babel-loader/issues/787
      target: target,

      // Webpack 5 supports TLA behind a flag. We enable it by default
      // for Babel, and then webpack will throw an error if the experimental
      // flag isn't enabled.
      supportsTopLevelAwait: true,

      isServer,
      pagesDir,
      development,
      hasReactRefresh,
      hasJsxRuntime,

      ...loaderOptions.caller,
    },
  } as any

  Object.defineProperty(options.caller, 'onWarning', {
    enumerable: false,
    writable: false,
    value: (reason: any) => {
      if (!(reason instanceof Error)) {
        reason = new Error(reason)
      }
      this.emitWarning(reason)
    },
  })

  const loadedOptions = loadOptions(options)
  const config = consumeIterator(loadConfig(loadedOptions))

  return config
}

/**
 * Each key returned here corresponds with a Babel config that can be shared.
 * The conditions of permissible sharing between files is dependent on specific
 * file attributes and Next.js compiler states: `CharacteristicsGermaneToCaching`.
 */
function getCacheKey(cacheCharacteristics: CharacteristicsGermaneToCaching) {
  const {
    isServer,
    isPageFile,
    isNextDist,
    hasModuleExports,
  } = cacheCharacteristics

  return (
    0 |
    (isServer ? 0b0001 : 0) |
    (isPageFile ? 0b0010 : 0) |
    (isNextDist ? 0b0100 : 0) |
    (hasModuleExports ? 0b1000 : 0)
  )
}

type BabelConfig = any
const configCache: Map<number, BabelConfig> = new Map()

export default function getConfig(
  this: NextJsLoaderContext,
  {
    source,
    loaderOptions,
    target,
    filename,
    inputSourceMap,
  }: {
    source: string
    loaderOptions: NextBabelLoaderOptions
    target: string
    filename: string
    inputSourceMap?: object | null
  }
): BabelConfig {
  const cacheCharacteristics = getCacheCharacteristics(
    loaderOptions,
    source,
    filename
  )

  const cacheKey = getCacheKey(cacheCharacteristics)
  if (configCache.has(cacheKey)) {
    return {
      ...configCache.get(cacheKey),
      filename,
      sourceFileName: filename,
    }
  }

  const freshConfig = getFreshConfig.call(
    this,
    cacheCharacteristics,
    loaderOptions,
    target,
    filename,
    inputSourceMap
  )

  configCache.set(cacheKey, freshConfig)

  return freshConfig
}