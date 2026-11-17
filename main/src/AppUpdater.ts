import { autoUpdater } from 'electron-updater'
import fs from 'fs'
import path from 'path'
import type { ServerEvents } from './server'
import type { UpdateInfo, UpdateChannel } from '../../ipc/types'

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

  private readonly platformNoDownloadReason:
    Extract<UpdateInfo, { state: 'update-available' }>['noDownloadReason'] = null

  get noAutoUpdatesReason () {
    return this.platformNoDownloadReason ??
      ((this._channel.type === 'off') ? 'channel-off' : null)
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

    this.server.onEventAnyClient('CLIENT->MAIN::user-action', ({ action }) => {
      if (action === 'check-for-update') {
        this.check()
      } else if (action === 'update-and-restart') {
        autoUpdater.quitAndInstall(false)
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
      this.info = { state: 'update-not-available', checkedAt: Date.now() }
    })
    autoUpdater.on('error', () => {
      this.info = { state: 'error', checkedAt: Date.now() }
    })
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
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

    if (channel.type === 'github') {
      autoUpdater.setFeedURL({ provider: 'github', owner: channel.owner, repo: channel.repo })
    } else if (channel.type === 'official') {
      autoUpdater.setFeedURL(OFFICIAL_FEED)
    } else {
      autoUpdater.setFeedURL(this.builtinFeed)
    }
    autoUpdater.autoDownload = (this.noAutoUpdatesReason == null)

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
    if (this._channel.type === 'off') return
    this.check()
  }

  private check = async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // handled by event
    }
  }
}
