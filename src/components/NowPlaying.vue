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
        <h1 class="now-playing__track" v-text="playerData.trackTitle"></h1>
        <h2 class="now-playing__artists" v-text="getTrackArtists"></h2>
      </div>
    </div>

    <div v-else class="now-playing" :class="getNowPlayingClass()">
      <h1 class="now-playing__idle-heading">No music is playing 😔</h1>
    </div>
  </div>
</template>

<script>
import * as Vibrant from 'node-vibrant'
import props from '@/utils/props.js'

export default {
  name: 'NowPlaying',

  props: {
    auth: props.auth,
    endpoints: props.endpoints,
    player: props.player
  },

  data() {
    return {
      pollPlaying: '',
      playerResponse: {},
      playerData: this.getEmptyPlayer(),
      colourPalette: '',
      swatches: [],
      coverReady: true,
      paletteReqId: 0
    }
  },

  computed: {
    getTrackArtists() {
      return (this.playerData.trackArtists || []).join(', ')
    }
  },

  mounted() {
    this.setDataInterval()
  },

  beforeDestroy() {
    clearInterval(this.pollPlaying)
  },

  methods: {
    async getNowPlaying() {
      let data = {}

      try {
        const response = await fetch(
          `${this.endpoints.base}/${this.endpoints.nowPlaying}`,
          {
            headers: {
              Authorization: `Bearer ${this.auth.accessToken}`
            }
          }
        )

        if (!response.ok) {
          throw new Error(`An error has occured: ${response.status}`)
        }

        if (response.status === 204) {
          data = this.getEmptyPlayer()
          this.playerData = data

          this.$nextTick(() => {
            this.$emit('spotifyTrackUpdated', data)
          })

          return
        }

        data = await response.json()
        this.playerResponse = data
      } catch (error) {
        this.handleExpiredToken()

        data = this.getEmptyPlayer()
        this.playerData = data

        this.$nextTick(() => {
          this.$emit('spotifyTrackUpdated', data)
        })
      }
    },

    getNowPlayingClass() {
      const playerClass = this.playerData.playing ? 'active' : 'idle'
      return `now-playing--${playerClass}`
    },

    // run Vibrant only for the CURRENT track's loaded image
    onCoverLoaded(evt) {
      const imgEl = evt?.target
      if (!imgEl) return

      this.coverReady = true

      const trackId = this.playerData.trackId
      const imgUrl = this.playerData.trackAlbum?.image

      // guard: only extract palette if this load corresponds to current src+track
      if (!trackId || !imgUrl) return
      if (imgEl.currentSrc !== imgUrl && imgEl.src !== imgUrl) return

      const reqId = ++this.paletteReqId

      Vibrant.from(imgEl)
        .quality(1)
        .clearFilters()
        .getPalette()
        .then(palette => {
          // ignore stale results (prevents “one song behind”)
          if (reqId !== this.paletteReqId) return
          if (trackId !== this.playerData.trackId) return
          if (imgUrl !== this.playerData.trackAlbum?.image) return

          this.handleAlbumPalette(palette)
        })
        .catch(() => {
          // keep existing background if extraction fails
        })
    },

    onCoverError() {
      // If the image fails, show it anyway (avoid invisible cover forever)
      this.coverReady = true
    },

    getEmptyPlayer() {
      return {
        playing: false,
        trackAlbum: {},
        trackArtists: [],
        trackId: '',
        trackTitle: ''
      }
    },

    setDataInterval() {
      clearInterval(this.pollPlaying)
      this.pollPlaying = setInterval(() => {
        this.getNowPlaying()
      }, 2500)
    },

    setAppColours() {
      // Keep text untouched (you wanted white). Only update background.
      document.documentElement.style.setProperty(
        '--colour-background-now-playing',
        this.colourPalette.background
      )
    },

    handleNowPlaying() {
      if (
        this.playerResponse.error?.status === 401 ||
        this.playerResponse.error?.status === 400
      ) {
        this.handleExpiredToken()
        return
      }

      if (this.playerResponse.is_playing === false) {
        this.playerData = this.getEmptyPlayer()
        return
      }

      if (this.playerResponse.item?.id === this.playerData.trackId) {
        return
      }

      const item = this.playerResponse.item
      const trackId = item.id

      // choose a reasonable cover size (good quality, not huge)
      const images = item.album?.images || []
      const best =
        images.find(i => i.width && i.width <= 300) ||
        images.find(i => i.width && i.width <= 640) ||
        images[images.length - 1] ||
        images[0]

      const rawUrl = best?.url || ''
      const sep = rawUrl.includes('?') ? '&' : '?'
      const coverUrl = rawUrl ? `${rawUrl}${sep}t=${trackId}` : ''

      // hide cover until new one is fully loaded (prevents half-render striping)
      this.coverReady = false

      this.playerData = {
        playing: this.playerResponse.is_playing,
        trackArtists: item.artists.map(artist => artist.name),
        trackTitle: item.name,
        trackId,
        trackAlbum: {
          title: item.album.name,
          image: coverUrl
        }
      }
    },

    handleAlbumPalette(palette) {
      // deterministic pick: no random “why did it change” nonsense
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
      clearInterval(this.pollPlaying)
      this.$emit('requestRefreshToken')
    }
  },

  watch: {
    auth(oldVal, newVal) {
      if (newVal.status === false) {
        clearInterval(this.pollPlaying)
      }
    },

    playerResponse() {
      this.handleNowPlaying()
    },

    playerData() {
      this.$emit('spotifyTrackUpdated', this.playerData)
      // DO NOT call getAlbumColours here anymore.
      // Palette runs only after the correct cover finishes loading.
    }
  }
}
</script>

<style src="@/styles/components/now-playing.scss" lang="scss" scoped></style>