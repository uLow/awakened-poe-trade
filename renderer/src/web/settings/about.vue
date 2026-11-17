<template>
  <div class="p-2 flex flex-col h-full items-center">
    <div class="flex flex-col items-center p-2 mb-4">
      <img class="w-12 h-12" src="/images/TransferOrb.png">
      <p class="text-base">Awakened PoE Trade</p>
      <p class="">{{ t('app.version', [version]) }}</p>
      <div class="flex gap-2">
        <a class="border-b" href="https://github.com/SnosMe/awakened-poe-trade/releases" target="_blank">{{ t('app.release_notes') }}</a>
        <a class="border-b" href="https://github.com/SnosMe/awakened-poe-trade/issues" target="_blank">{{ t('app.report_bug') }}</a>
      </div>
    </div>
    <div class="border border-gray-600 rounded p-2 whitespace-nowrap min-w-min w-72">
      <p>{{ info.str1 }}</p>
      <p>{{ info.str2 }}</p>
      <button v-if="info.action" @click="info.action"
        class="btn w-full mt-1">{{ info.actionText }}</button>
    </div>
    <div class="w-72 mt-4">
      <div class="mb-1">{{ t('updates.channel') }}</div>
      <select v-model="updateChannel" class="p-1 rounded bg-gray-700 w-full">
        <option value="default">{{ t('updates.channel_default') }}</option>
        <option value="official">{{ t('updates.channel_official') }}</option>
        <option value="github">{{ t('updates.channel_github') }}</option>
        <option value="off">{{ t('updates.channel_off') }}</option>
      </select>
      <input v-if="updateChannel === 'github'" v-model.trim="updateRepo"
        class="rounded bg-gray-900 px-1 block w-full font-sans mt-1" placeholder="owner/repo">
      <p class="text-gray-500 mt-1">{{ t('updates.channel_hint') }}</p>
    </div>
    <div class="w-72 mt-4">
      <div class="mb-1">{{ t('updates.pick_version') }}</div>
      <button v-if="!releases" @click="listReleases" :disabled="releasesLoading"
        class="btn w-full">{{ releasesLoading ? t('please_wait') : t('updates.show_versions') }}</button>
      <template v-else>
        <p class="text-gray-500 mb-1">{{ releases.repo }}</p>
        <p v-if="releases.error" class="text-red-400">{{ releases.error }}</p>
        <p v-else-if="!releases.releases.length" class="text-gray-500">{{ t('updates.no_versions') }}</p>
        <template v-else>
          <select v-model="selectedTag" class="p-1 rounded bg-gray-700 w-full">
            <option v-for="r of releases.releases" :key="r.tag" :value="r.tag">
              {{ r.version }} — {{ fmtDate(r.publishedAt) }}{{ r.prerelease ? ' (pre-release)' : '' }}{{ r.version === version ? ' ✓' : '' }}
            </option>
          </select>
          <button @click="installSelected" :disabled="!canInstall"
            class="btn w-full mt-1">{{ t('updates.install_version') }}</button>
        </template>
      </template>
    </div>
    <div class="text-center mt-auto py-8">
      <p>{{ t('app.contact_me') }} <br><span class="font-sans text-gray-500 select-all">&lt;@295216259795124225&gt;</span></p>
      <ul class="flex gap-4">
        <li><img class="rounded inline" src="/images/dc_tft.gif"> <a class="border-b" href="https://discord.gg/tftrove" target="_blank">The Forbidden Trove</a></li>
        <li><img class="rounded inline" src="/images/dc_reddit.png"> <a class="border-b" href="https://discord.gg/pathofexile" target="_blank">r/pathofexile</a></li>
      </ul>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Host } from '@/web/background/IPC'
import { AppConfig } from '@/web/Config'
import { DateTime } from 'luxon'
import { configProp } from './utils'
import type { IpcEventPayload } from '@ipc/types'

function checkForUpdates () {
  Host.sendEvent({
    name: 'CLIENT->MAIN::user-action',
    payload: { action: 'check-for-update' }
  })
}

function openDownloadPage () {
  const { updateChannel, updateRepo } = AppConfig()
  if (updateChannel === 'github' && updateRepo?.includes('/')) {
    window.open(`https://github.com/${updateRepo.trim()}/releases`)
  } else {
    window.open('https://snosme.github.io/awakened-poe-trade/download')
  }
}

function quitAndInstall () {
  Host.sendEvent({
    name: 'CLIENT->MAIN::user-action',
    payload: { action: 'update-and-restart' }
  })
}

function fmtDate (iso: string) {
  return DateTime.fromISO(iso).toLocaleString(DateTime.DATE_MED)
}

function fmtTime (millis: number) {
  return DateTime.fromMillis(millis).toRelative({ style: 'long' }) ?? 'n/a'
}

export default defineComponent({
  name: 'settings.about',
  inheritAttrs: false,
  props: configProp(),
  setup (props) {
    const { t } = useI18n()

    const updateChannel = computed({
      get () { return props.config.updateChannel ?? 'default' },
      set (value) { props.config.updateChannel = value }
    })
    const releases = ref<IpcEventPayload<'MAIN->CLIENT::updater-releases'>>()
    const releasesLoading = ref(false)
    const selectedTag = ref<string>()
    const releasesListener = Host.onEvent('MAIN->CLIENT::updater-releases', (payload) => {
      releases.value = payload
      releasesLoading.value = false
      selectedTag.value = payload.releases[0]?.tag
    })
    onUnmounted(() => releasesListener.abort())

    function listReleases () {
      releasesLoading.value = true
      Host.sendEvent({ name: 'CLIENT->MAIN::user-action', payload: { action: 'list-releases' } })
    }
    function installSelected () {
      if (!selectedTag.value) return
      Host.sendEvent({ name: 'CLIENT->MAIN::user-action', payload: { action: 'install-release', tag: selectedTag.value } })
    }
    const canInstall = computed(() => {
      const state = Host.updateInfo.value.state
      const selected = releases.value?.releases.find(r => r.tag === selectedTag.value)
      return selected != null &&
        selected.version !== Host.version.value &&
        state !== 'checking-for-update' &&
        !(state === 'update-available' && !Host.updateInfo.value.noDownloadReason) // downloading
    })

    const updateRepo = computed({
      get () { return props.config.updateRepo ?? '' },
      set (value) { props.config.updateRepo = value }
    })

    const info = computed(() => {
      const rawInfo = Host.updateInfo.value
      switch (rawInfo.state) {
        case 'initial':
          return { str1: t('updates.maybe_outdated'), str2: t('updates.never_checked'), action: checkForUpdates, actionText: t('updates.check_now') }
        case 'checking-for-update':
          return { str1: t('updates.checking'), str2: t('please_wait') }
        case 'update-not-available':
          return { str1: t('updates.latest'), str2: t('updates.last_checked', [fmtTime(rawInfo.checkedAt)]), action: checkForUpdates, actionText: t('updates.check_now') }
        case 'error':
          return { str1: t('updates.maybe_outdated'), str2: t('updates.error'), action: openDownloadPage, actionText: t('updates.downloads_page') }
        case 'update-downloaded':
          return { str1: t('updates.available', [rawInfo.version]), str2: t('updates.installed_on_exit'), action: quitAndInstall, actionText: t('updates.install_now') }
        case 'update-available':
          return (rawInfo.noDownloadReason)
            ? { str1: t('updates.available', [rawInfo.version]), str2: (rawInfo.noDownloadReason === 'not-supported') ? t('updates.download_manually') : t('updates.download_disabled'), action: openDownloadPage, actionText: t('updates.downloads_page') }
            : { str1: t('updates.available', [rawInfo.version]), str2: t('updates.downloading') }
      }
    })

    return {
      t,
      info,
      updateChannel,
      updateRepo,
      releases,
      releasesLoading,
      selectedTag,
      listReleases,
      installSelected,
      canInstall,
      fmtDate,
      version: Host.version
    }
  }
})
</script>
