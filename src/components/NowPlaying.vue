<template>
  <div class="app-view">
    <div
      v-if="playerData.playing"
      class="now-playing"
      :class="getNowPlayingClass()"
    >
      <div class="now-playing__cover">
        <img
          :key="playerData.trackId"
          :src="playerData.trackAlbum.image"
          :alt="playerData.trackTitle"
          class="now-playing__image"
          crossorigin="anonymous"
          :style="{
            opacity: coverReady ? 1 : 0,
            transition: 'opacity 250ms ease'
          }"
          @load="onCoverLoaded"
          @error="onCoverError"
        />
      </div>
      <div class="now-playing__details">
        <div class="now-playing__content" :style="{ opacity: contentOpacity }">
          <div v-if="displayMode === 'meta'" class="now-playing__meta">
            <h1 class="now-playing__track" v-text="playerData.trackTitle"></h1>
            <h2 class="now-playing__artists" v-text="getTrackArtists"></h2>
          </div>

          <div v-else-if="displayMode === 'lyrics'" class="now-playing__lyrics">
            <div
              v-if="lyricsState === 'error'"
              class="now-playing__lyrics-empty"
            >
              {{ lyricsErrorMessage }}
            </div>

            <div
              v-else-if="lyricsState === 'ready'"
              ref="lyricsScroller"
              class="now-playing__lyrics-scroller"
            >
              <div ref="lyricsRail" class="now-playing__lyrics-rail">
                <p
                  v-for="(line, index) in parsedLyrics"
                  :key="`${playerData.trackId}-${index}-${line.timeMs}`"
                  class="now-playing__lyrics-line"
                  :class="getLyricsLineClass(index)"
                >
                  {{ line.text }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div class="now-playing__progress">
          <div ref="progressTrack" class="now-playing__progress-track">
            <div ref="progressFill" class="now-playing__progress-fill"></div>
            <span ref="progressDot" class="now-playing__progress-dot"></span>
          </div>

          <div class="now-playing__progress-times">
            <span>{{ formatDuration(displayProgressMs) }}</span>
            <span>{{ formatDuration(playerData.durationMs) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="now-playing" :class="getNowPlayingClass()">
      <h1 class="now-playing__idle-heading">No music is playing</h1>
    </div>
  </div>
</template>

<script>
import * as Vibrant from 'node-vibrant'
import props from '@/utils/props.js'

const LYRICS_ENDPOINT = process.env.VUE_APP_LYRICS_ENDPOINT || ''
const DEFAULT_LYRICS_PATH = '/api/lyrics'
const PROGRESS_DOT_SIZE_PX = 16
const POLL_DELAYS_MS = Object.freeze({
  activeVisible: 1000,
  activeHidden: 4000,
  idleVisible: 3000,
  idleHidden: 7000,
  nearTrackEndMinimum: 350,
  nearTrackEndWindow: 4000,
  nearTrackEndBuffer: 120
})
const TRACK_CHANGE_SETTLE_PROGRESS_MS = 1800
const BACKGROUND_FALLBACK_HSL = Object.freeze({
  h: 214,
  s: 0.2,
  l: 0.18
})
const BASE_SATURATION_RANGE = Object.freeze({
  min: 0.22,
  max: 0.68
})
const BASE_LIGHTNESS_RANGE = Object.freeze({
  min: 0.18,
  max: 0.42
})
const PALETTE_REJECTION_THRESHOLDS = Object.freeze({
  maxLightness: 0.72,
  minLightness: 0.08,
  minSaturation: 0.14,
  maxLuminance: 0.46,
  accentPopulationRatio: 0.18,
  accentSaturation: 0.62
})
const PALETTE_NAME_WEIGHTS = Object.freeze({
  DarkMuted: 0.42,
  Muted: 0.34,
  DarkVibrant: 0.24,
  Vibrant: 0.1,
  LightMuted: -0.1,
  LightVibrant: -0.24
})
const PI_GRADIENT_STOPS = Object.freeze({
  upper: 24,
  lower: 68
})

export default {
  name: 'NowPlaying',

  props: {
    auth: props.auth,
    endpoints: props.endpoints,
    player: props.player
  },

  data() {
    return {
      pollPlaying: 0,
      playbackFrame: 0,
      lyricScrollFrame: 0,
      playerResponse: {},
      playerData: this.getEmptyPlayer(),
      colourPalette: null,
      swatches: [],
      coverReady: true,
      paletteReqId: 0,
      preferredDisplayMode: 'meta',
      lyricsMode: false,
      displayMode: 'meta',
      contentOpacity: 1,
      transitionTimeouts: [],
      lyricsState: 'idle',
      lyricsErrorMessage: 'Lyrics not found',
      lyricsCache: {},
      parsedLyrics: [],
      currentLyricsIndex: -1,
      displayProgressMs: 0,
      progressSnapshotMs: 0,
      progressSnapshotAt: 0,
      progressTrackWidth: 0,
      lastRenderedProgressRatio: -1,
      lastRenderedProgressSecond: -1,
      nowPlayingRequestInFlight: false,
      pendingImmediatePoll: false,
      isDocumentVisible:
        typeof document === 'undefined'
          ? true
          : document.visibilityState !== 'hidden',
      lyricOffsetPx: 0
    }
  },

  computed: {
    getTrackArtists() {
      return (this.playerData.trackArtists || []).join(', ')
    }
  },

  mounted() {
    this.isDocumentVisible = this.getIsDocumentVisible()
    this.applyColourPalette(this.buildFallbackColourPalette())

    window.addEventListener('keydown', this.handleGlobalKeyDown)
    window.addEventListener('focus', this.handleWindowFocus)
    window.addEventListener('resize', this.handleWindowResize)

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }

    this.$nextTick(() => {
      this.measureProgressTrack()
      this.syncPlaybackUi(true)
      this.requestNowPlayingRefresh()
    })
  },

  beforeDestroy() {
    clearTimeout(this.pollPlaying)
    this.stopPlaybackLoop()

    if (this.lyricScrollFrame) cancelAnimationFrame(this.lyricScrollFrame)

    this.clearTransitionTimeouts()
    window.removeEventListener('keydown', this.handleGlobalKeyDown)
    window.removeEventListener('focus', this.handleWindowFocus)
    window.removeEventListener('resize', this.handleWindowResize)

    if (typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        this.handleVisibilityChange
      )
    }
  },

  methods: {
    formatDuration(ms) {
      const totalMs = Math.max(0, Number(ms || 0))
      const totalSeconds = Math.floor(totalMs / 1000)
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = String(totalSeconds % 60).padStart(2, '0')
      return `${minutes}:${seconds}`
    },

    getClockNow() {
      if (typeof performance !== 'undefined' && performance.now) {
        return performance.now()
      }

      return Date.now()
    },

    getIsDocumentVisible() {
      if (typeof document === 'undefined') return true
      return document.visibilityState !== 'hidden'
    },

    clampProgressMs(
      progressMs,
      totalMs = Number(this.playerData.durationMs || 0)
    ) {
      const normalizedProgress = Math.max(0, Number(progressMs || 0))

      if (!Number.isFinite(totalMs) || totalMs <= 0) {
        return normalizedProgress
      }

      return Math.min(totalMs, normalizedProgress)
    },

    shouldAnimatePlayback() {
      return Boolean(this.playerData.playing && this.isDocumentVisible)
    },

    requestNowPlayingRefresh() {
      if (!this.auth.accessToken || this.auth.status === false) return

      if (this.nowPlayingRequestInFlight) {
        this.pendingImmediatePoll = true
        return
      }

      this.scheduleNowPlayingPoll(0)
    },

    scheduleNowPlayingPoll(delayMs = 0) {
      clearTimeout(this.pollPlaying)
      this.pollPlaying = 0

      if (!this.auth.accessToken || this.auth.status === false) {
        return
      }

      this.pollPlaying = setTimeout(() => {
        this.pollPlaying = 0
        this.getNowPlaying()
      }, Math.max(0, Math.round(delayMs)))
    },

    getNextNowPlayingDelay(now = this.getClockNow()) {
      if (!this.isDocumentVisible) {
        return this.playerData.playing
          ? POLL_DELAYS_MS.activeHidden
          : POLL_DELAYS_MS.idleHidden
      }

      if (!this.playerData.playing) {
        return POLL_DELAYS_MS.idleVisible
      }

      const remainingMs = this.getRemainingTrackMs(now)

      if (remainingMs > 0 && remainingMs <= POLL_DELAYS_MS.nearTrackEndWindow) {
        return Math.min(
          POLL_DELAYS_MS.activeVisible,
          Math.max(
            POLL_DELAYS_MS.nearTrackEndMinimum,
            remainingMs - POLL_DELAYS_MS.nearTrackEndBuffer
          )
        )
      }

      return POLL_DELAYS_MS.activeVisible
    },

    async getNowPlaying() {
      if (
        !this.auth.accessToken ||
        this.auth.status === false ||
        this.nowPlayingRequestInFlight
      ) {
        return
      }

      this.nowPlayingRequestInFlight = true
      const requestStartedAt = this.getClockNow()

      try {
        const response = await fetch(
          `${this.endpoints.base}/${this.endpoints.nowPlaying}`,
          {
            cache: 'no-store',
            headers: {
              Authorization: `Bearer ${this.auth.accessToken}`
            }
          }
        )

        const responseReceivedAt = this.getClockNow()

        if (response.status === 204) {
          this.playerResponse = {}
          this.resetPlaybackState()
          return
        }

        if (response.status === 400 || response.status === 401) {
          this.handleExpiredToken()
          return
        }

        if (!response.ok) {
          throw new Error(`An error has occured: ${response.status}`)
        }

        const data = await response.json()
        this.applyNowPlayingResponse(data, {
          requestStartedAt,
          responseReceivedAt
        })
      } catch (error) {
        this.syncPlaybackLoopState()
      } finally {
        this.nowPlayingRequestInFlight = false
        const shouldSchedulePoll =
          this.auth.accessToken && this.auth.status !== false
        const shouldPollImmediately = this.pendingImmediatePoll

        this.pendingImmediatePoll = false

        if (shouldSchedulePoll) {
          this.scheduleNowPlayingPoll(
            shouldPollImmediately ? 0 : this.getNextNowPlayingDelay()
          )
        }
      }
    },

    applyNowPlayingResponse(
      data = {},
      { requestStartedAt = 0, responseReceivedAt = this.getClockNow() } = {}
    ) {
      this.playerResponse = data

      if (!data.item || data.is_playing === false) {
        this.resetPlaybackState()
        return
      }

      const isTrackChange = data.item.id !== this.playerData.trackId
      const shouldSettleFreshTrack = this.shouldSettleFreshTrack(
        data,
        isTrackChange
      )
      const snapshotMs = this.getAdjustedSnapshotProgressMs(
        data,
        requestStartedAt,
        responseReceivedAt,
        shouldSettleFreshTrack
      )

      this.progressSnapshotMs = snapshotMs
      this.progressSnapshotAt = responseReceivedAt

      if (isTrackChange) {
        if (shouldSettleFreshTrack) {
          this.pendingImmediatePoll = true
        }

        this.applyTrackChange(data, snapshotMs)
        return
      }

      this.playerData.playing = true
      this.playerData.progressMs = Number(data.progress_ms || 0)
      this.playerData.durationMs = Number(
        data.item.duration_ms || this.playerData.durationMs || 0
      )

      this.syncPlaybackUi(true, responseReceivedAt)
      this.syncPlaybackLoopState()
    },

    getAdjustedSnapshotProgressMs(
      data = {},
      requestStartedAt = 0,
      responseReceivedAt = this.getClockNow(),
      settleTrackChange = false
    ) {
      const baseProgressMs = Math.max(0, Number(data.progress_ms || 0))

      if (!data.is_playing || settleTrackChange) {
        return baseProgressMs
      }

      const roundTripMs = Math.max(0, responseReceivedAt - requestStartedAt)
      return baseProgressMs + roundTripMs / 2
    },

    shouldSettleFreshTrack(data = {}, isTrackChange = false) {
      if (!isTrackChange) return false

      return Number(data.progress_ms || 0) <= TRACK_CHANGE_SETTLE_PROGRESS_MS
    },

    applyTrackChange(data = {}, snapshotMs = 0) {
      const item = data.item || {}
      const trackId = item.id || ''
      const shouldRestoreLyrics = this.preferredDisplayMode === 'lyrics'
      const images = item.album?.images || []
      const best =
        images.find(i => i.width && i.width <= 300) ||
        images.find(i => i.width && i.width <= 640) ||
        images[images.length - 1] ||
        images[0]

      const rawUrl = best?.url || ''
      const sep = rawUrl.includes('?') ? '&' : '?'
      const coverUrl = rawUrl ? `${rawUrl}${sep}t=${trackId}` : ''

      this.clearTransitionTimeouts()
      this.coverReady = false
      this.playerData = {
        playing: Boolean(data.is_playing),
        trackArtists: Array.isArray(item.artists)
          ? item.artists.map(artist => artist.name)
          : [],
        trackTitle: item.name || '',
        trackId,
        trackAlbum: {
          title: item.album?.name || '',
          image: coverUrl
        },
        progressMs: Number(data.progress_ms || 0),
        durationMs: Number(item.duration_ms || 0)
      }

      this.displayProgressMs = this.clampProgressMs(
        snapshotMs,
        this.playerData.durationMs
      )
      this.lastRenderedProgressRatio = -1
      this.lastRenderedProgressSecond = -1
      this.lyricsMode = shouldRestoreLyrics
      this.displayMode = shouldRestoreLyrics ? 'blank' : 'meta'
      this.contentOpacity = shouldRestoreLyrics ? 0 : 1
      this.currentLyricsIndex = -1
      this.lyricsState = shouldRestoreLyrics ? 'loading' : 'idle'
      this.lyricsErrorMessage = 'Lyrics not found'
      this.parsedLyrics = []
      this.resetLyricsPosition(true)

      this.$nextTick(() => {
        this.measureProgressTrack()
        this.syncPlaybackUi(true)
        this.syncPlaybackLoopState()

        if (!shouldRestoreLyrics) {
          return
        }

        this.fetchTrackLyrics().finally(() => {
          if (this.playerData.trackId !== trackId) return
          if (this.preferredDisplayMode !== 'lyrics') return

          this.currentLyricsIndex = -1
          this.fadeInMode('lyrics', () => {
            this.syncPlaybackUi(true)
          })
        })
      })
    },

    resetPlaybackState() {
      const hadPlaybackState = Boolean(
        this.playerData.playing || this.playerData.trackId
      )

      if (hadPlaybackState) {
        this.playerData = this.getEmptyPlayer()
      } else {
        this.playerData.playing = false
        this.playerData.progressMs = 0
        this.playerData.durationMs = 0
      }

      this.progressSnapshotMs = 0
      this.progressSnapshotAt = this.getClockNow()
      this.displayProgressMs = 0
      this.lastRenderedProgressRatio = -1
      this.lastRenderedProgressSecond = -1
      this.lyricsMode = false
      this.displayMode = 'meta'
      this.contentOpacity = 1
      this.currentLyricsIndex = -1
      this.lyricsState = 'idle'
      this.lyricsErrorMessage = 'Lyrics not found'
      this.parsedLyrics = []
      this.stopPlaybackLoop()
      this.resetLyricsPosition(true)

      this.$nextTick(() => {
        this.measureProgressTrack()
        this.syncProgressVisuals(0, true)
      })
    },

    handleGlobalKeyDown(event) {
      if (event.key.toLowerCase() !== 'l') return
      if (!this.playerData.playing) return

      this.toggleLyricsMode()
    },

    toggleLyricsMode() {
      const nextMode = this.preferredDisplayMode !== 'lyrics'
      this.preferredDisplayMode = nextMode ? 'lyrics' : 'meta'
      this.lyricsMode = nextMode

      if (nextMode) {
        this.transitionToLyrics()
        return
      }

      this.transitionToMeta()
    },

    transitionToLyrics() {
      this.clearTransitionTimeouts()
      this.lyricsState = 'loading'
      this.lyricsErrorMessage = 'Lyrics not found'

      this.fadeOutCurrent(() => {
        this.displayMode = 'blank'

        this.fetchTrackLyrics().finally(() => {
          if (!this.lyricsMode) return

          this.currentLyricsIndex = -1
          this.fadeInMode('lyrics', () => {
            this.syncPlaybackUi(true)
          })
        })
      })
    },

    transitionToMeta() {
      this.clearTransitionTimeouts()

      this.fadeOutCurrent(() => {
        this.fadeInMode('meta')
      })
    },

    fadeOutCurrent(onComplete) {
      this.contentOpacity = 0
      const timeoutId = setTimeout(() => {
        onComplete()
      }, 400)
      this.transitionTimeouts.push(timeoutId)
    },

    fadeInMode(mode, onReady) {
      this.displayMode = mode
      this.contentOpacity = 0

      this.$nextTick(() => {
        this.measureProgressTrack()

        if (typeof onReady === 'function') {
          onReady()
        }

        const timeoutId = setTimeout(() => {
          this.contentOpacity = 1
        }, 0)
        this.transitionTimeouts.push(timeoutId)
      })
    },

    clearTransitionTimeouts() {
      this.transitionTimeouts.forEach(timeoutId => clearTimeout(timeoutId))
      this.transitionTimeouts = []
    },

    getLyricsEndpointCandidates() {
      const endpoints = []
      const seen = new Set()
      const push = value => {
        const normalized = String(value || '').trim()
        if (!normalized || seen.has(normalized)) return
        seen.add(normalized)
        endpoints.push(normalized)
      }

      push(LYRICS_ENDPOINT)

      if (typeof window !== 'undefined' && window.location) {
        push(new URL(DEFAULT_LYRICS_PATH, window.location.origin).toString())

        if (window.location.hostname) {
          const protocol =
            window.location.protocol === 'https:' ? 'https:' : 'http:'
          push(
            `${protocol}//${window.location.hostname}:8787${DEFAULT_LYRICS_PATH}`
          )
        }
      } else {
        push(DEFAULT_LYRICS_PATH)
      }

      return endpoints
    },

    async requestLyricsPayload(query) {
      const endpoints = this.getLyricsEndpointCandidates()
      const failures = []

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(`${endpoint}?${query.toString()}`)

          if (response.status === 404) {
            failures.push(`404 from ${endpoint}`)
            continue
          }

          if (!response.ok) {
            throw new Error(`Lyrics service error (${response.status})`)
          }

          return await response.json()
        } catch (error) {
          failures.push(`${endpoint}: ${error.message}`)
        }
      }

      throw new Error(
        failures[failures.length - 1] ||
          'Unable to fetch lyrics from any endpoint'
      )
    },

    async fetchTrackLyrics() {
      const cacheKey = this.playerData.trackId

      if (!cacheKey) {
        this.lyricsErrorMessage = 'Lyrics unavailable'
        this.lyricsState = 'error'
        return
      }

      if (this.lyricsCache[cacheKey]) {
        this.parsedLyrics = this.lyricsCache[cacheKey]
        this.lyricsState = this.parsedLyrics.length ? 'ready' : 'error'
        return
      }

      try {
        const query = new URLSearchParams({
          track: this.playerData.trackTitle,
          artist: this.getTrackArtists,
          album: this.playerResponse.item?.album?.name || '',
          durationMs: String(this.playerResponse.item?.duration_ms || 0),
          isrc: this.playerResponse.item?.external_ids?.isrc || ''
        })

        const data = await this.requestLyricsPayload(query)
        const synced = this.parseSyncedLyrics(data.syncedLyrics)
        const unsynced = this.parseUnsyncedLyrics(data.lyrics)
        const lyrics = synced.length ? synced : unsynced

        this.lyricsCache[cacheKey] = lyrics
        this.parsedLyrics = lyrics
        this.lyricsErrorMessage = 'Lyrics not found'
        this.lyricsState = lyrics.length ? 'ready' : 'error'
      } catch (error) {
        this.parsedLyrics = []
        this.lyricsErrorMessage =
          error.message && error.message.startsWith('404 from ')
            ? 'Lyrics not found'
            : 'Lyrics unavailable'
        this.lyricsState = 'error'
      }
    },

    parseSyncedLyrics(rawLyrics) {
      if (!rawLyrics) return []

      return rawLyrics
        .split('\n')
        .map(line => {
          const match = line.match(/^\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/)
          if (!match) return null

          const minutes = parseInt(match[1], 10)
          const seconds = parseInt(match[2], 10)
          const fraction = parseInt((match[3] || '0').padEnd(3, '0'), 10)
          const text = match[4].trim()

          return {
            timeMs: minutes * 60000 + seconds * 1000 + fraction,
            text: text || '...'
          }
        })
        .filter(Boolean)
    },

    parseUnsyncedLyrics(rawLyrics) {
      if (!rawLyrics) return []

      return rawLyrics
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, index) => ({
          timeMs: index * 5000,
          text: line
        }))
    },

    getLyricsLineClass(index) {
      const distance = Math.abs(index - this.currentLyricsIndex)

      return {
        'is-current': distance === 0,
        'is-near': distance === 1,
        'is-mid': distance === 2,
        'is-far': distance > 2
      }
    },

    getEstimatedProgressMs(now = this.getClockNow()) {
      const baseProgressMs = Math.max(0, Number(this.progressSnapshotMs || 0))
      if (!this.playerData.playing) return baseProgressMs

      const snapshotAt = Number(this.progressSnapshotAt || 0)
      const elapsed = snapshotAt > 0 ? Math.max(0, now - snapshotAt) : 0
      return baseProgressMs + elapsed
    },

    getRemainingTrackMs(now = this.getClockNow()) {
      const durationMs = Number(this.playerData.durationMs || 0)

      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return 0
      }

      return Math.max(0, durationMs - this.getEstimatedProgressMs(now))
    },

    syncPlaybackUi(force = false, now = this.getClockNow()) {
      const progressMs = this.clampProgressMs(this.getEstimatedProgressMs(now))

      this.syncProgressVisuals(progressMs, force)
      this.syncProgressTimestamp(progressMs, force)
      this.syncLyricsForProgress(progressMs, force)
    },

    syncProgressTimestamp(progressMs, force = false) {
      const nextSecond = Math.floor(progressMs / 1000)

      if (!force && nextSecond === this.lastRenderedProgressSecond) {
        return
      }

      this.lastRenderedProgressSecond = nextSecond
      this.displayProgressMs = progressMs
    },

    syncProgressVisuals(progressMs, force = false) {
      const total = Number(this.playerData.durationMs || 0)
      const fill = this.$refs.progressFill
      const dot = this.$refs.progressDot
      const ratio =
        Number.isFinite(total) && total > 0
          ? Math.max(0, Math.min(1, progressMs / total))
          : 0

      if (!force && Math.abs(ratio - this.lastRenderedProgressRatio) < 0.0004) {
        return
      }

      this.lastRenderedProgressRatio = ratio

      if (!fill || !dot) {
        return
      }

      if (!this.progressTrackWidth) {
        this.measureProgressTrack()
      }

      const usableTrackWidth = Math.max(
        0,
        this.progressTrackWidth - PROGRESS_DOT_SIZE_PX
      )
      const dotOffsetPx = usableTrackWidth * ratio

      fill.style.transform = `translateZ(0) scaleX(${ratio.toFixed(6)})`
      dot.style.transform = `translate3d(${dotOffsetPx.toFixed(3)}px, -50%, 0)`
    },

    measureProgressTrack() {
      const progressTrack = this.$refs.progressTrack

      if (!progressTrack) {
        this.progressTrackWidth = 0
        return 0
      }

      this.progressTrackWidth = Math.max(0, progressTrack.clientWidth || 0)
      return this.progressTrackWidth
    },

    syncPlaybackLoopState() {
      if (this.shouldAnimatePlayback()) {
        this.startPlaybackLoop()
        return
      }

      this.stopPlaybackLoop()
    },

    startPlaybackLoop() {
      if (this.playbackFrame || !this.shouldAnimatePlayback()) {
        return
      }

      const renderFrame = now => {
        this.playbackFrame = 0
        this.syncPlaybackUi(false, now)

        if (this.shouldAnimatePlayback()) {
          this.playbackFrame = requestAnimationFrame(renderFrame)
        }
      }

      this.playbackFrame = requestAnimationFrame(renderFrame)
    },

    stopPlaybackLoop() {
      if (!this.playbackFrame) return
      cancelAnimationFrame(this.playbackFrame)
      this.playbackFrame = 0
    },

    findLyricsIndexForProgress(progressMs) {
      if (!this.parsedLyrics.length) return -1
      if (progressMs < this.parsedLyrics[0].timeMs) return -1

      const currentLine = this.parsedLyrics[this.currentLyricsIndex]
      const nextLine = this.parsedLyrics[this.currentLyricsIndex + 1]

      if (
        currentLine &&
        currentLine.timeMs <= progressMs &&
        (!nextLine || nextLine.timeMs > progressMs)
      ) {
        return this.currentLyricsIndex
      }

      let low = 0
      let high = this.parsedLyrics.length - 1
      let nextIndex = -1

      while (low <= high) {
        const mid = Math.floor((low + high) / 2)

        if (this.parsedLyrics[mid].timeMs <= progressMs) {
          nextIndex = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }

      return nextIndex
    },

    syncLyricsForProgress(progressMs, force = false) {
      if (
        !this.lyricsMode ||
        this.displayMode !== 'lyrics' ||
        this.lyricsState !== 'ready' ||
        !this.parsedLyrics.length
      ) {
        if (force) {
          this.resetLyricsPosition(force)
        }

        return
      }

      const nextIndex = this.findLyricsIndexForProgress(progressMs)

      if (nextIndex < 0) {
        if (this.currentLyricsIndex !== -1) {
          this.currentLyricsIndex = -1
        }

        if (force) {
          this.scheduleLyricsPosition(true)
        }

        return
      }

      if (nextIndex !== this.currentLyricsIndex) {
        this.currentLyricsIndex = nextIndex
        this.$nextTick(() => {
          this.scheduleLyricsPosition(force)
        })
        return
      }

      if (force) {
        this.scheduleLyricsPosition(true)
      }
    },

    scheduleLyricsPosition(force = false) {
      if (this.lyricScrollFrame) {
        cancelAnimationFrame(this.lyricScrollFrame)
      }

      this.lyricScrollFrame = requestAnimationFrame(() => {
        this.lyricScrollFrame = 0
        this.positionLyricsRail(force)
      })
    },

    positionLyricsRail(force = false) {
      const scroller = this.$refs.lyricsScroller
      const rail = this.$refs.lyricsRail

      if (!scroller || !rail) {
        return
      }

      if (this.currentLyricsIndex < 0) {
        this.applyLyricsOffset(0, force)
        return
      }

      const activeLine = rail.children[this.currentLyricsIndex]
      if (!activeLine) return

      const centeredOffset =
        scroller.clientHeight / 2 - activeLine.clientHeight / 2
      const rawOffset = centeredOffset - activeLine.offsetTop
      const minOffset = Math.min(0, scroller.clientHeight - rail.scrollHeight)
      const nextOffset = Math.max(minOffset, Math.min(0, rawOffset))

      this.applyLyricsOffset(nextOffset, force)
    },

    applyLyricsOffset(offsetPx, force = false) {
      const rail = this.$refs.lyricsRail
      const normalizedOffset = Number(offsetPx || 0)

      if (!force && Math.abs(normalizedOffset - this.lyricOffsetPx) < 0.5) {
        return
      }

      this.lyricOffsetPx = normalizedOffset

      if (!rail) {
        return
      }

      if (force) {
        rail.style.transition = 'none'
        rail.style.transform = `translate3d(0, ${normalizedOffset.toFixed(
          3
        )}px, 0)`
        void rail.offsetHeight
        rail.style.transition = ''
        return
      }

      rail.style.transform = `translate3d(0, ${normalizedOffset.toFixed(
        3
      )}px, 0)`
    },

    resetLyricsPosition(force = false) {
      this.lyricOffsetPx = 0
      this.applyLyricsOffset(0, force)
    },

    getNowPlayingClass() {
      const playerClass = this.playerData.playing ? 'active' : 'idle'
      return `now-playing--${playerClass}`
    },

    onCoverLoaded(evt) {
      const imgEl = evt?.target
      if (!imgEl) return

      this.coverReady = true

      const trackId = this.playerData.trackId
      const imgUrl = this.playerData.trackAlbum?.image

      if (!trackId || !imgUrl) return
      if (imgEl.currentSrc !== imgUrl && imgEl.src !== imgUrl) return

      const reqId = ++this.paletteReqId

      Vibrant.from(imgEl)
        .quality(1)
        .clearFilters()
        .getPalette()
        .then(palette => {
          if (reqId !== this.paletteReqId) return
          if (trackId !== this.playerData.trackId) return
          if (imgUrl !== this.playerData.trackAlbum?.image) return

          this.handleAlbumPalette(palette)
        })
        .catch(() => {
          this.applyColourPalette(this.buildFallbackColourPalette())
        })
    },

    onCoverError() {
      this.coverReady = true
      this.applyColourPalette(this.buildFallbackColourPalette())
    },

    getEmptyPlayer() {
      return {
        playing: false,
        trackAlbum: {
          title: '',
          image: ''
        },
        trackArtists: [],
        trackId: '',
        trackTitle: '',
        progressMs: 0,
        durationMs: 0
      }
    },

    handleVisibilityChange() {
      this.isDocumentVisible = this.getIsDocumentVisible()

      if (this.isDocumentVisible) {
        this.$nextTick(() => {
          this.measureProgressTrack()
          this.syncPlaybackUi(true)
        })
        this.requestNowPlayingRefresh()
      }

      this.syncPlaybackLoopState()
    },

    handleWindowFocus() {
      if (!this.getIsDocumentVisible()) return

      this.$nextTick(() => {
        this.measureProgressTrack()
        this.syncPlaybackUi(true)
      })
      this.requestNowPlayingRefresh()
    },

    handleWindowResize() {
      this.$nextTick(() => {
        this.measureProgressTrack()
        this.syncPlaybackUi(true)
      })
    },

    setAppColours() {
      if (typeof document === 'undefined' || !this.colourPalette) {
        return
      }

      document.documentElement.style.setProperty(
        '--colour-background-now-playing-base',
        this.colourPalette.base
      )
      document.documentElement.style.setProperty(
        '--colour-background-now-playing-solid',
        this.colourPalette.solid
      )
      document.documentElement.style.setProperty(
        '--colour-background-now-playing-top',
        this.colourPalette.top
      )
      document.documentElement.style.setProperty(
        '--colour-background-now-playing-upper',
        this.colourPalette.upper
      )
      document.documentElement.style.setProperty(
        '--colour-background-now-playing-lower',
        this.colourPalette.lower
      )
      document.documentElement.style.setProperty(
        '--colour-background-now-playing-bottom',
        this.colourPalette.bottom
      )
      document.documentElement.style.setProperty(
        '--colour-background-now-playing',
        this.colourPalette.gradient
      )
    },

    handleAlbumPalette(palette) {
      const baseCandidate = this.selectBasePaletteCandidate(palette)
      const nextPalette = baseCandidate
        ? this.buildGradientPalette(baseCandidate.hsl, {
            source: baseCandidate.name
          })
        : this.buildFallbackColourPalette()

      this.applyColourPalette(nextPalette)
    },

    applyColourPalette(palette) {
      if (!palette) return

      this.colourPalette = palette

      this.$nextTick(() => {
        this.setAppColours()
      })
    },

    buildFallbackColourPalette() {
      return this.buildGradientPalette(BACKGROUND_FALLBACK_HSL, {
        source: 'fallback'
      })
    },

    selectBasePaletteCandidate(palette = {}) {
      const entries = Object.entries(palette).filter(([, swatch]) => swatch)

      if (!entries.length) {
        this.swatches = []
        return null
      }

      const maxPopulation = Math.max(
        ...entries.map(([, swatch]) => this.getSwatchPopulation(swatch)),
        1
      )
      const candidates = entries
        .map(([name, swatch]) =>
          this.normalizePaletteCandidate(name, swatch, maxPopulation)
        )
        .sort((left, right) => right.score - left.score)

      this.swatches = candidates.map(candidate => ({
        name: candidate.name,
        population: candidate.population,
        populationRatio: candidate.populationRatio,
        score: Number(candidate.score.toFixed(3)),
        rejected: candidate.rejectionReasons
      }))

      const selectedCandidate = candidates.find(
        candidate => !candidate.rejectionReasons.length
      )

      if (
        this.shouldPreferFallbackOverSelectedCandidate(
          selectedCandidate,
          candidates
        )
      ) {
        return null
      }

      return selectedCandidate
    },

    normalizePaletteCandidate(name, swatch, maxPopulation = 1) {
      const rgb = this.normalizeRgb(
        typeof swatch?.getRgb === 'function' ? swatch.getRgb() : swatch?._rgb
      )
      const rawHsl = this.rgbToHsl(rgb)
      const population = this.getSwatchPopulation(swatch)
      const populationRatio = Math.min(
        1,
        population / Math.max(1, Number(maxPopulation) || 1)
      )
      const luminance = this.getRelativeLuminance(rgb)
      const candidate = {
        hsl: this.getNormalizedBaseHsl(rawHsl),
        luminance,
        name,
        population,
        populationRatio,
        rawHsl,
        rgb
      }

      candidate.rejectionReasons = this.getPaletteCandidateRejectionReasons(
        candidate
      )
      candidate.score = this.getPaletteCandidateScore(candidate)

      return candidate
    },

    getPaletteCandidateRejectionReasons(candidate) {
      const reasons = []
      const { luminance, name, populationRatio, rawHsl } = candidate
      const isMutedCandidate = name.toLowerCase().includes('muted')
      const looksLikeAccent =
        populationRatio < PALETTE_REJECTION_THRESHOLDS.accentPopulationRatio &&
        rawHsl.s > PALETTE_REJECTION_THRESHOLDS.accentSaturation &&
        !isMutedCandidate

      if (
        rawHsl.l > PALETTE_REJECTION_THRESHOLDS.maxLightness ||
        luminance > PALETTE_REJECTION_THRESHOLDS.maxLuminance
      ) {
        reasons.push('too-light')
      }

      if (rawHsl.l < PALETTE_REJECTION_THRESHOLDS.minLightness) {
        reasons.push('too-dark')
      }

      if (rawHsl.s < PALETTE_REJECTION_THRESHOLDS.minSaturation) {
        reasons.push('too-gray')
      }

      if (looksLikeAccent) {
        reasons.push('tiny-accent')
      }

      return reasons
    },

    getPaletteCandidateScore(candidate) {
      const { name, populationRatio, rawHsl, rejectionReasons } = candidate
      const saturationFit = 1 - Math.min(1, Math.abs(rawHsl.s - 0.38) / 0.38)
      const lightnessFit = 1 - Math.min(1, Math.abs(rawHsl.l - 0.3) / 0.3)
      const labelWeight = PALETTE_NAME_WEIGHTS[name] || 0
      const accentPenalty =
        populationRatio < 0.24 && rawHsl.s > 0.58 && !name.includes('Muted')
          ? 0.35
          : 0
      const rejectionPenalty = rejectionReasons.length * 1.25

      return (
        populationRatio * 1.55 +
        saturationFit * 0.95 +
        lightnessFit * 0.85 +
        labelWeight -
        accentPenalty -
        rejectionPenalty
      )
    },

    shouldPreferFallbackOverSelectedCandidate(selectedCandidate, candidates) {
      if (!selectedCandidate) {
        return true
      }

      const selectedName = selectedCandidate.name.toLowerCase()
      const selectedLooksLikeAccent =
        !selectedName.includes('muted') &&
        selectedCandidate.populationRatio < 0.33 &&
        selectedCandidate.rawHsl.s > 0.45
      const rejectedMutedDominant = candidates.some(candidate => {
        const candidateName = candidate.name.toLowerCase()
        return (
          candidateName.includes('muted') &&
          candidate.populationRatio > 0.6 &&
          candidate.rejectionReasons.length > 0 &&
          candidate.rejectionReasons.every(reason => reason === 'too-gray')
        )
      })

      return selectedLooksLikeAccent && rejectedMutedDominant
    },

    getSwatchPopulation(swatch) {
      const population =
        typeof swatch?.getPopulation === 'function'
          ? swatch.getPopulation()
          : swatch?.population

      return Math.max(1, Number(population) || 1)
    },

    buildGradientPalette(hsl, meta = {}) {
      const base = this.getNormalizedBaseHsl(hsl)
      const topHsl = {
        h: base.h,
        s: this.clamp(base.s + 0.04, 0.18, 0.72),
        l: this.clamp(base.l + 0.09, 0.18, 0.54)
      }
      const upperHsl = {
        h: base.h,
        s: this.clamp(base.s + 0.02, 0.18, 0.7),
        l: this.clamp(base.l + 0.015, 0.16, 0.46)
      }
      const lowerHsl = {
        h: base.h,
        s: this.clamp(base.s - 0.01, 0.16, 0.66),
        l: this.clamp(base.l - 0.04, 0.12, 0.4)
      }
      const bottomHsl = {
        h: base.h,
        s: this.clamp(base.s - 0.03, 0.14, 0.64),
        l: this.clamp(base.l - 0.19, 0.06, 0.28)
      }
      const top = this.hslToCss(topHsl)
      const upper = this.hslToCss(upperHsl)
      const lower = this.hslToCss(lowerHsl)
      const bottom = this.hslToCss(bottomHsl)

      return {
        ...meta,
        base: this.hslToCss(base),
        solid: lower,
        top,
        upper,
        lower,
        bottom,
        gradient: `linear-gradient(180deg, ${top} 0%, ${upper} ${PI_GRADIENT_STOPS.upper}%, ${lower} ${PI_GRADIENT_STOPS.lower}%, ${bottom} 100%)`
      }
    },

    getNormalizedBaseHsl(hsl = {}) {
      const sourceHsl = {
        h: Number(hsl.h) || 0,
        s: Number(hsl.s) || 0,
        l: Number(hsl.l) || 0
      }

      return {
        h: ((sourceHsl.h % 360) + 360) % 360,
        s: this.clamp(
          sourceHsl.s < BASE_SATURATION_RANGE.min
            ? sourceHsl.s + 0.06
            : sourceHsl.s > BASE_SATURATION_RANGE.max
            ? sourceHsl.s - 0.08
            : sourceHsl.s,
          BASE_SATURATION_RANGE.min,
          BASE_SATURATION_RANGE.max
        ),
        l: this.clamp(
          sourceHsl.l,
          BASE_LIGHTNESS_RANGE.min,
          BASE_LIGHTNESS_RANGE.max
        )
      }
    },

    normalizeRgb(rgb = []) {
      return [0, 1, 2].map(index =>
        this.clamp(Math.round(Number(rgb[index] || 0)), 0, 255)
      )
    },

    rgbToHsl(rgb = []) {
      const [r, g, b] = this.normalizeRgb(rgb).map(channel => channel / 255)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const lightness = (max + min) / 2

      if (max === min) {
        return {
          h: 0,
          s: 0,
          l: lightness
        }
      }

      const delta = max - min
      const saturation =
        lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
      let hue = 0

      switch (max) {
        case r:
          hue = (g - b) / delta + (g < b ? 6 : 0)
          break
        case g:
          hue = (b - r) / delta + 2
          break
        default:
          hue = (r - g) / delta + 4
      }

      return {
        h: hue * 60,
        s: saturation,
        l: lightness
      }
    },

    hslToRgb(hsl = {}) {
      const hue = ((((Number(hsl.h) || 0) % 360) + 360) % 360) / 360
      const saturation = this.clamp(Number(hsl.s) || 0, 0, 1)
      const lightness = this.clamp(Number(hsl.l) || 0, 0, 1)

      if (saturation === 0) {
        const value = Math.round(lightness * 255)
        return [value, value, value]
      }

      const q =
        lightness < 0.5
          ? lightness * (1 + saturation)
          : lightness + saturation - lightness * saturation
      const p = 2 * lightness - q
      const channels = [hue + 1 / 3, hue, hue - 1 / 3].map(channel =>
        this.hueToRgbChannel(p, q, channel)
      )

      return channels.map(channel => Math.round(channel * 255))
    },

    hueToRgbChannel(p, q, t) {
      let channel = t

      if (channel < 0) channel += 1
      if (channel > 1) channel -= 1
      if (channel < 1 / 6) return p + (q - p) * 6 * channel
      if (channel < 1 / 2) return q
      if (channel < 2 / 3) return p + (q - p) * (2 / 3 - channel) * 6
      return p
    },

    hslToCss(hsl = {}) {
      return this.rgbToCss(this.hslToRgb(hsl))
    },

    rgbToCss(rgb = []) {
      const [red, green, blue] = this.normalizeRgb(rgb)
      return `rgb(${red}, ${green}, ${blue})`
    },

    getRelativeLuminance(rgb = []) {
      const [red, green, blue] = this.normalizeRgb(rgb).map(channel => {
        const normalized = channel / 255

        if (normalized <= 0.03928) {
          return normalized / 12.92
        }

        return ((normalized + 0.055) / 1.055) ** 2.4
      })

      return red * 0.2126 + green * 0.7152 + blue * 0.0722
    },

    clamp(value, min, max) {
      return Math.min(max, Math.max(min, Number(value) || 0))
    },

    handleExpiredToken() {
      clearTimeout(this.pollPlaying)
      this.pollPlaying = 0
      this.pendingImmediatePoll = false
      this.applyColourPalette(this.buildFallbackColourPalette())
      this.stopPlaybackLoop()
      this.$emit('requestRefreshToken')
    }
  },

  watch: {
    'auth.status': function(newStatus) {
      if (newStatus === false) {
        clearTimeout(this.pollPlaying)
        this.pollPlaying = 0
        this.applyColourPalette(this.buildFallbackColourPalette())
        this.stopPlaybackLoop()
        return
      }

      this.requestNowPlayingRefresh()
    },

    playerData() {
      this.$emit('spotifyTrackUpdated', this.playerData)
    },

    lyricsState(newState) {
      if (newState !== 'ready') return

      this.$nextTick(() => {
        this.scheduleLyricsPosition(true)
        this.syncPlaybackUi(true)
      })
    },

    displayMode(newMode) {
      if (newMode !== 'lyrics') return

      this.$nextTick(() => {
        this.measureProgressTrack()
        this.syncPlaybackUi(true)
      })
    }
  }
}
</script>

<style src="@/styles/components/now-playing.scss" lang="scss" scoped></style>
