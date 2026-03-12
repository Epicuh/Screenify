<template>
  <div id="app">
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
      colourPalette: '',
      swatches: [],
      coverReady: true,
      paletteReqId: 0,
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

      const snapshotMs = this.getAdjustedSnapshotProgressMs(
        data,
        requestStartedAt,
        responseReceivedAt
      )

      this.progressSnapshotMs = snapshotMs
      this.progressSnapshotAt = responseReceivedAt

      if (data.item.id !== this.playerData.trackId) {
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
      responseReceivedAt = this.getClockNow()
    ) {
      const baseProgressMs = Math.max(0, Number(data.progress_ms || 0))

      if (!data.is_playing) {
        return baseProgressMs
      }

      const roundTripMs = Math.max(0, responseReceivedAt - requestStartedAt)
      return baseProgressMs + roundTripMs / 2
    },

    applyTrackChange(data = {}, snapshotMs = 0) {
      const item = data.item || {}
      const trackId = item.id || ''
      const images = item.album?.images || []
      const best =
        images.find(i => i.width && i.width <= 300) ||
        images.find(i => i.width && i.width <= 640) ||
        images[images.length - 1] ||
        images[0]

      const rawUrl = best?.url || ''
      const sep = rawUrl.includes('?') ? '&' : '?'
      const coverUrl = rawUrl ? `${rawUrl}${sep}t=${trackId}` : ''

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
      this.lyricsMode = false
      this.displayMode = 'meta'
      this.contentOpacity = 1
      this.currentLyricsIndex = -1
      this.lyricsState = 'idle'
      this.lyricsErrorMessage = 'Lyrics not found'
      this.parsedLyrics = []
      this.resetLyricsPosition(true)

      this.$nextTick(() => {
        this.measureProgressTrack()
        this.syncPlaybackUi(true)
        this.syncPlaybackLoopState()
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
      const nextMode = !this.lyricsMode
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
        .catch(() => {})
    },

    onCoverError() {
      this.coverReady = true
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
      document.documentElement.style.setProperty(
        '--colour-background-now-playing',
        this.colourPalette.background
      )
    },

    handleAlbumPalette(palette) {
      const preferred =
        palette.Vibrant ||
        palette.DarkVibrant ||
        palette.Muted ||
        palette.DarkMuted ||
        Object.values(palette).find(s => s)

      if (!preferred) return

      this.colourPalette = {
        text: preferred.getTitleTextColor(),
        background: preferred.getHex()
      }

      this.$nextTick(() => {
        this.setAppColours()
      })
    },

    handleExpiredToken() {
      clearTimeout(this.pollPlaying)
      this.pollPlaying = 0
      this.pendingImmediatePoll = false
      this.stopPlaybackLoop()
      this.$emit('requestRefreshToken')
    }
  },

  watch: {
    'auth.status': function(newStatus) {
      if (newStatus === false) {
        clearTimeout(this.pollPlaying)
        this.pollPlaying = 0
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
