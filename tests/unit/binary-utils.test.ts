import { test, expect } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const utils = require('../../scripts/binary-utils.cjs') as {
  getPlatformArch: (platform: string, arch: string) => string
  getBinaryFilename: (platform: string) => string
  getCachedBinaryPath: (opts: {
    version: string
    platform: string
    arch: string
    baseDir: string
  }) => string
  getGithubReleaseBinaryUrl: (opts: {
    version: string
    platform: string
    arch: string
    owner?: string
    repo?: string
    tag?: string
    baseUrl?: string
  }) => string
}

test('binary-utils: platform/arch and filenames', () => {
  expect(utils.getPlatformArch('darwin', 'arm64')).toBe('darwin-arm64')
  expect(utils.getPlatformArch('win32', 'x64')).toBe('win32-x64')
  expect(utils.getBinaryFilename('darwin')).toBe('cpaper')
  expect(utils.getBinaryFilename('linux')).toBe('cpaper')
  expect(utils.getBinaryFilename('win32')).toBe('cpaper.exe')
})

test('binary-utils: cached binary path', () => {
  expect(
    utils.getCachedBinaryPath({
      version: '2.0.0',
      platform: 'darwin',
      arch: 'arm64',
      baseDir: '/tmp/cpaper-bin',
    }),
  ).toBe('/tmp/cpaper-bin/2.0.0/darwin-arm64/cpaper')

  expect(
    utils.getCachedBinaryPath({
      version: '2.0.0',
      platform: 'win32',
      arch: 'x64',
      baseDir: '/tmp/cpaper-bin',
    }),
  ).toBe('/tmp/cpaper-bin/2.0.0/win32-x64/cpaper.exe')
})

test('binary-utils: GitHub release URL', () => {
  expect(
    utils.getGithubReleaseBinaryUrl({
      version: '2.0.0',
      platform: 'darwin',
      arch: 'arm64',
      owner: 'FredFang1216',
      repo: 'MARs',
      tag: 'v2.0.0',
    }),
  ).toBe(
    'https://github.com/FredFang1216/MARs/releases/download/v2.0.0/cpaper-darwin-arm64',
  )
})

test('binary-utils: base URL override', () => {
  const prev = process.env.KODE_BINARY_BASE_URL
  process.env.KODE_BINARY_BASE_URL = 'https://example.com/cpaper'
  try {
    expect(
      utils.getGithubReleaseBinaryUrl({
        version: '2.0.0',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toBe('https://example.com/cpaper/cpaper-linux-x64')
  } finally {
    if (prev === undefined) delete process.env.KODE_BINARY_BASE_URL
    else process.env.KODE_BINARY_BASE_URL = prev
  }
})
