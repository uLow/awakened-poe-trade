import { autoUpdater } from 'electron-updater'
import { net } from 'electron'
import fs from 'fs'
import path from 'path'
import type { ServerEvents } from './server'
import type { UpdateInfo, UpdateChannel, ReleaseInfo } from '../../ipc/types'

type GithubFeed = { provider: 'github', owner: string, repo: string }

const OFFICIAL_FEED: GithubFeed = { provider: 'github', owner: 'SnosMe', repo: 'awakened-poe-trade' }

// repository this build was published to (written by electron-builder)
function readBuiltinFeed (): GithubFeed {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const field = (name: string) => yml.match(new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+)`, 'm'))?.[1].trim()
    const owner = field('owner')
    const repo = field('repo')
    if (field('provider') === 'github' && owner && repo) {
      return { provider: 'github', owner, repo }
    }
  } catch {}
  return OFFICIAL_FEED
}

export class AppUpdater {
  private _checkedAtStartup = false
  private _info: UpdateInfo = { state: 'initial' }
  private _channel: UpdateChannel = { type: 'default' }
  private _channelKey = JSON.stringify(this._channel)
  private readonly builtinFeed = readBuiltinFeed()
  // tag of a release the user picked to install, until it's downloaded
  private _pinnedTag: string | null = null

  private readonly platformNoDownloadReason:
    Extract<UpdateInfo, { state: 'update-available' }>['noDownloadReason'] = null

  get noAutoUpdatesReason () {
    return this.platformNoDownloadReason ??
      ((this._channel.type === 'off' && !this._pinnedTag) ? 'channel-off' : null)
  }

  // repository used for update checks and the release list
  private get channelFeed (): GithubFeed {
    switch (this._channel.type) {
      case 'github':
        return { provider: 'github', owner: this._channel.owner, repo: this._channel.repo }
      case 'official':
        return OFFICIAL_FEED
      default:
        return this.builtinFeed
    }
  }

  get info () { return this._info }
  set info (info: UpdateInfo) {
    this._info = info
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::updater-state',
      payload: info
    })
  }

  constructor (
    private server: ServerEvents
  ) {
    setInterval(this.checkAutomatically, 16 * 60 * 60 * 1000)

    this.server.onEventAnyClient('CLIENT->MAIN::user-action', (e) => {
      if (e.action === 'check-for-update') {
        this.check()
      } else if (e.action === 'update-and-restart') {
        autoUpdater.quitAndInstall(false)
      } else if (e.action === 'list-releases') {
        this.listReleases()
      } else if (e.action === 'install-release') {
        this.installRelease(e.tag)
      }
    })

    // https://www.electron.build/configuration/nsis.html#portable
    if (process.env.PORTABLE_EXECUTABLE_DIR || process.platform === 'darwin') {
      this.platformNoDownloadReason = 'not-supported'
    } else if (process.argv.includes('--no-updates')) {
      this.platformNoDownloadReason = 'disabled-by-flag'
    }
    autoUpdater.autoDownload = (this.noAutoUpdatesReason == null)
    autoUpdater.setFeedURL(this.builtinFeed)

    autoUpdater.on('checking-for-update', () => {
      this.info = { state: 'checking-for-update' }
    })
    autoUpdater.on('update-available', (info: { version: string }) => {
      this.info = { state: 'update-available', version: info.version, noDownloadReason: this.noAutoUpdatesReason }
    })
    autoUpdater.on('update-not-available', () => {
      this.unpin()
      this.info = { state: 'update-not-available', checkedAt: Date.now() }
    })
    autoUpdater.on('error', () => {
      this.unpin()
      this.info = { state: 'error', checkedAt: Date.now() }
    })
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      this.unpin()
      this.info = { state: 'update-downloaded', version: info.version }
    })
    // on('download-progress') https://github.com/electron-userland/electron-builder/issues/2521
  }

  setChannel (channel: UpdateChannel | undefined) {
    channel ??= { type: 'default' }
    if (channel.type === 'github' && (!channel.owner || !channel.repo)) {
      channel = { type: 'off' }
    }
    const key = JSON.stringify(channel)
    if (key === this._channelKey) return
    const isFirstSet = !this._checkedAtStartup && this._info.state === 'initial'
    this._channel = channel
    this._channelKey = key

    if (!this._pinnedTag) {
      autoUpdater.setFeedURL(this.channelFeed)
      autoUpdater.autoDownload = (this.noAutoUpdatesReason == null)
    }

    // results of previous check were for another feed
    if (!isFirstSet && this._info.state !== 'update-downloaded') {
      this.info = { state: 'initial' }
    }
  }

  checkAtStartup () {
    if (!this._checkedAtStartup) {
      this._checkedAtStartup = true
      this.checkAutomatically()
    }
  }

  private checkAutomatically = () => {
    if (this._channel.type === 'off' || this._pinnedTag) return
    this.check()
  }

  private async listReleases () {
    const { owner, repo } = this.channelFeed
    let releases: ReleaseInfo[] = []
    let error: string | undefined
    try {
      const res = await net.fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json' }
      })
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`)
      const json = await res.json() as Array<{
        tag_name: string
        published_at: string
        prerelease: boolean
        draft: boolean
        assets: Array<{ name: string }>
      }>
      releases = json
        // only releases that the updater can install from
        .filter(r => !r.draft && r.assets.some(a => a.name === 'latest.yml'))
        .map(r => ({
          tag: r.tag_name,
          version: r.tag_name.replace(/^v/, ''),
          publishedAt: r.published_at,
          prerelease: r.prerelease
        }))
    } catch (e) {
      error = (e as Error).message
    }
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::updater-releases',
      payload: { repo: `${owner}/${repo}`, releases, error }
    })
  }

  // installs exact release, can be older than the running version
  private installRelease (tag: string) {
    if (this.platformNoDownloadReason || this._pinnedTag) return
    const { owner, repo } = this.channelFeed
    this._pinnedTag = tag
    autoUpdater.allowDowngrade = true
    autoUpdater.autoDownload = true
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}`
    })
    this.check()
  }

  private unpin () {
    if (!this._pinnedTag) return
    this._pinnedTag = null
    autoUpdater.allowDowngrade = false
    autoUpdater.setFeedURL(this.channelFeed)
    autoUpdater.autoDownload = (this.noAutoUpdatesReason == null)
  }

  private check = async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // handled by event
    }
  }
}
