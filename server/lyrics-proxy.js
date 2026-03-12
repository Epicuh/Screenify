/* eslint-disable no-console */
const http = require('http')

const PORT = Number(process.env.LYRICS_PROXY_PORT || 8787)
const BASE_URL = 'https://lrclib.net/api'
const USER_AGENT = 'Nowify Lyrics Proxy/2.0'
const LRCLIB_CLIENT = 'Nowify'

const jsonResponse = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(payload))
}

const uniqueValues = values => {
  const seen = new Set()
  const ordered = []

  for (const value of values) {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    ordered.push(normalized)
  }

  return ordered
}

const cleanTitleText = text => {
  if (!text) return ''

  return String(text)
    .replace(/\s*\((feat\.?|with)\s+[^)]*\)/gi, '')
    .replace(/\s*\[(feat\.?|with)\s+[^\]]*\]/gi, '')
    .replace(/\s*-\s*(feat\.?|with)\s+.*$/gi, '')
    .replace(/\s*\((?:[^)]*\s)?remaster(?:ed)?(?:\s+\d{4})?[^)]*\)/gi, '')
    .replace(/\s*\[(?:[^\]]*\s)?remaster(?:ed)?(?:\s+\d{4})?[^\]]*\]/gi, '')
    .replace(/\s*-\s*remaster(?:ed)?(?:\s+\d{4})?.*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const cleanAlbumText = text => {
  if (!text) return ''

  return String(text)
    .replace(
      /\s*\((?:deluxe|expanded|special|anniversary|collector'?s|bonus|remaster(?:ed)?)[^)]*\)/gi,
      ''
    )
    .replace(
      /\s*\[(?:deluxe|expanded|special|anniversary|collector'?s|bonus|remaster(?:ed)?)[^\]]*\]/gi,
      ''
    )
    .replace(
      /\s*-\s*(?:deluxe|expanded|special|anniversary|collector'?s|bonus|remaster(?:ed)?).*/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const normalizeText = text =>
  String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

const tokenize = text =>
  normalizeText(text)
    .split(' ')
    .filter(Boolean)

const splitArtistParts = artist => {
  const raw = String(artist || '').trim()
  if (!raw) return []

  return uniqueValues(
    raw
      .split(/,|&|\/|\bx\b|\band\b|\bfeat\.?\b|\bwith\b/gi)
      .map(value => value.trim())
  )
}

const toTrackMatchCandidates = track => {
  const raw = String(track || '').trim()
  const cleaned = cleanTitleText(raw)
  return uniqueValues([raw, cleaned])
}

const toTrackQueryCandidates = track => {
  const raw = String(track || '').trim()
  const cleaned = cleanTitleText(raw)
  return uniqueValues([cleaned, raw])
}

const toArtistMatchCandidates = artist => {
  const raw = String(artist || '').trim()
  const first = raw.split(',')[0].trim()
  return uniqueValues([raw, first, ...splitArtistParts(raw)])
}

const toArtistQueryCandidates = artist => {
  const raw = String(artist || '').trim()
  const first = raw.split(',')[0].trim()
  return uniqueValues([first, ...splitArtistParts(raw), raw])
}

const toAlbumMatchCandidates = album => {
  const raw = String(album || '').trim()
  const cleaned = cleanAlbumText(raw)
  return uniqueValues([raw, cleaned])
}

const toAlbumQueryCandidates = album => {
  const raw = String(album || '').trim()
  const cleaned = cleanAlbumText(raw)
  return uniqueValues([cleaned, raw])
}

const normalizeDurationSeconds = durationMs => {
  const parsed = Number(durationMs)
  if (!Number.isFinite(parsed) || parsed <= 0) return null

  return Number((parsed / 1000).toFixed(3))
}

const getTokenOverlap = (expected, actual) => {
  const expectedTokens = tokenize(expected)
  const actualTokens = tokenize(actual)

  if (!expectedTokens.length || !actualTokens.length) {
    return {
      intersection: 0,
      coverage: 0,
      jaccard: 0
    }
  }

  const actualSet = new Set(actualTokens)
  const expectedSet = new Set(expectedTokens)
  let intersection = 0

  for (const token of expectedSet) {
    if (actualSet.has(token)) intersection += 1
  }

  const unionSize = new Set([...expectedSet, ...actualSet]).size

  return {
    intersection,
    coverage: intersection / expectedSet.size,
    jaccard: unionSize ? intersection / unionSize : 0
  }
}

const scoreTextMatch = (
  expectedCandidates,
  actualCandidates,
  { exact, partial, token, weak, miss }
) => {
  const expected = uniqueValues(expectedCandidates)
  const actual = uniqueValues(actualCandidates)

  if (!expected.length || !actual.length) return 0

  let bestScore = miss

  for (const left of expected) {
    for (const right of actual) {
      const normalizedLeft = normalizeText(left)
      const normalizedRight = normalizeText(right)

      if (!normalizedLeft || !normalizedRight) continue
      if (normalizedLeft === normalizedRight) {
        bestScore = Math.max(bestScore, exact)
        continue
      }

      if (
        normalizedLeft.includes(normalizedRight) ||
        normalizedRight.includes(normalizedLeft)
      ) {
        bestScore = Math.max(bestScore, partial)
        continue
      }

      const overlap = getTokenOverlap(normalizedLeft, normalizedRight)

      if (overlap.coverage === 1) {
        bestScore = Math.max(bestScore, token + 6)
      } else if (overlap.coverage >= 0.75 && overlap.jaccard >= 0.5) {
        bestScore = Math.max(bestScore, token)
      } else if (overlap.coverage >= 0.5) {
        bestScore = Math.max(bestScore, weak)
      } else if (overlap.intersection > 0) {
        bestScore = Math.max(bestScore, 0)
      }
    }
  }

  return bestScore
}

const scoreDurationMatch = (expectedDurationSeconds, actualDurationSeconds) => {
  if (!expectedDurationSeconds || !actualDurationSeconds) return 0

  const distance = Math.abs(
    Number(actualDurationSeconds) - Number(expectedDurationSeconds)
  )

  if (!Number.isFinite(distance)) return 0
  if (distance <= 1.5) return 24
  if (distance <= 4) return 20
  if (distance <= 8) return 14
  if (distance <= 15) return 8
  if (distance <= 25) return 2
  if (distance <= 40) return -8
  if (distance <= 60) return -18
  return -30
}

const hasUsableLyrics = candidate =>
  Boolean(candidate?.syncedLyrics || candidate?.plainLyrics)

const getCandidateKey = candidate => {
  const id = String(candidate?.id || '').trim()
  if (id) return id

  return normalizeText(
    [
      candidate?.trackName,
      candidate?.artistName,
      candidate?.albumName,
      candidate?.duration
    ].join('|')
  )
}

const scoreCandidateMatch = (context, candidate) => {
  const trackScore = scoreTextMatch(
    context.trackMatchCandidates,
    uniqueValues([
      candidate.trackName,
      candidate.name,
      cleanTitleText(candidate.trackName),
      cleanTitleText(candidate.name)
    ]),
    {
      exact: 52,
      partial: 40,
      token: 28,
      weak: 14,
      miss: -20
    }
  )

  const artistScore = scoreTextMatch(
    context.artistMatchCandidates,
    uniqueValues([
      candidate.artistName,
      ...toArtistMatchCandidates(candidate.artistName)
    ]),
    {
      exact: 46,
      partial: 34,
      token: 24,
      weak: 10,
      miss: -35
    }
  )

  const albumScore = context.albumMatchCandidates.length
    ? scoreTextMatch(
        context.albumMatchCandidates,
        uniqueValues([
          candidate.albumName,
          cleanAlbumText(candidate.albumName)
        ]),
        {
          exact: 18,
          partial: 12,
          token: 8,
          weak: 3,
          miss: -6
        }
      )
    : 0

  const durationScore = scoreDurationMatch(
    context.durationSeconds,
    candidate.duration
  )

  let lyricsScore = -40
  if (candidate.syncedLyrics) lyricsScore = 8
  else if (candidate.plainLyrics) lyricsScore = 3

  const sourceScore = candidate.source === 'direct' ? 3 : 0

  const totalScore =
    trackScore +
    artistScore +
    albumScore +
    durationScore +
    lyricsScore +
    sourceScore

  const durationDistance =
    context.durationSeconds && candidate.duration
      ? Math.abs(Number(candidate.duration) - Number(context.durationSeconds))
      : 0

  const usable =
    hasUsableLyrics(candidate) &&
    trackScore >= 14 &&
    artistScore >= 10 &&
    totalScore >= 40 &&
    durationDistance <= 75

  const highConfidence =
    usable &&
    trackScore >= 40 &&
    artistScore >= 34 &&
    (!context.durationSeconds || durationScore >= 8)

  return {
    trackScore,
    artistScore,
    albumScore,
    durationScore,
    lyricsScore,
    sourceScore,
    totalScore,
    durationDistance,
    usable,
    highConfidence
  }
}

const buildDirectLookupAttempts = context => {
  const attempts = []
  const pushAttempt = attempt => {
    const trackName = String(attempt.track_name || '').trim()
    const artistName = String(attempt.artist_name || '').trim()
    if (!trackName || !artistName) return

    const params = {
      track_name: trackName,
      artist_name: artistName
    }

    if (attempt.album_name) params.album_name = attempt.album_name
    if (attempt.duration) params.duration = attempt.duration

    const key = JSON.stringify(params)
    if (attempts.some(item => item.key === key)) return

    attempts.push({
      key,
      params
    })
  }

  const primaryTrack = context.trackQueryCandidates[0] || context.track
  const secondaryTrack = context.trackQueryCandidates[1] || ''
  const primaryArtist = context.artistQueryCandidates[0] || context.artist
  const secondaryArtist = context.artistQueryCandidates[1] || ''
  const primaryAlbum = context.albumQueryCandidates[0] || ''
  const duration = context.durationSeconds

  pushAttempt({
    track_name: primaryTrack,
    artist_name: primaryArtist,
    album_name: primaryAlbum,
    duration
  })
  pushAttempt({
    track_name: secondaryTrack,
    artist_name: primaryArtist,
    album_name: primaryAlbum,
    duration
  })
  pushAttempt({
    track_name: primaryTrack,
    artist_name: secondaryArtist,
    album_name: primaryAlbum,
    duration
  })
  pushAttempt({
    track_name: primaryTrack,
    artist_name: primaryArtist,
    duration
  })
  pushAttempt({
    track_name: secondaryTrack,
    artist_name: primaryArtist,
    duration
  })
  pushAttempt({
    track_name: primaryTrack,
    artist_name: secondaryArtist,
    duration
  })
  pushAttempt({
    track_name: primaryTrack,
    artist_name: primaryArtist,
    album_name: primaryAlbum
  })

  return attempts.map(item => item.params)
}

const buildSearchAttempts = context => {
  const attempts = []
  const pushAttempt = attempt => {
    const params = {}

    for (const [key, value] of Object.entries(attempt)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        params[key] = value
        continue
      }

      const normalized = String(value || '').trim()
      if (normalized) params[key] = normalized
    }

    if (!params.q && !params.track_name) return

    const key = JSON.stringify(params)
    if (attempts.some(item => item.key === key)) return

    attempts.push({
      key,
      params
    })
  }

  const primaryTrack = context.trackQueryCandidates[0] || context.track
  const secondaryTrack = context.trackQueryCandidates[1] || ''
  const primaryArtist = context.artistQueryCandidates[0] || context.artist
  const secondaryArtist = context.artistQueryCandidates[1] || ''
  const primaryAlbum = context.albumQueryCandidates[0] || ''

  pushAttempt({
    track_name: primaryTrack,
    artist_name: primaryArtist,
    album_name: primaryAlbum
  })
  pushAttempt({
    track_name: primaryTrack,
    artist_name: primaryArtist
  })
  pushAttempt({
    track_name: secondaryTrack,
    artist_name: primaryArtist
  })
  pushAttempt({
    track_name: primaryTrack,
    artist_name: secondaryArtist
  })
  pushAttempt({
    track_name: primaryTrack
  })
  pushAttempt({
    q: [primaryTrack, primaryArtist].filter(Boolean).join(' ')
  })

  return attempts.map(item => item.params)
}

const fetchJson = async (path, query = {}) => {
  const url = new URL(`${BASE_URL}${path}`)

  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      url.searchParams.set(key, String(value))
      continue
    }

    const normalized = String(value || '').trim()
    if (normalized) {
      url.searchParams.set(key, normalized)
    }
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'Lrclib-Client': LRCLIB_CLIENT
    }
  })

  if (response.status === 404) {
    const error = new Error('LRC Lib resource not found')
    error.statusCode = 404
    throw error
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const error = new Error(
      `LRC Lib request failed (${response.status})${body ? `: ${body}` : ''}`
    )
    error.statusCode = response.status
    throw error
  }

  return response.json()
}

const lookupLyricsByMetadata = async params => {
  try {
    return await fetchJson('/get', params)
  } catch (error) {
    if (error.statusCode === 404) return null
    throw error
  }
}

const searchLyrics = async params => {
  try {
    const payload = await fetchJson('/search', params)
    return Array.isArray(payload) ? payload : []
  } catch (error) {
    if (error.statusCode === 404) return []
    throw error
  }
}

const rankAndChooseCandidate = (context, candidates) => {
  const deduped = new Map()

  for (const candidate of candidates) {
    const key = getCandidateKey(candidate)
    if (!key) continue

    const score = scoreCandidateMatch(context, candidate)
    if (!score.usable) continue

    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, {
        ...candidate,
        score
      })
      continue
    }

    const shouldReplace =
      score.totalScore > existing.score.totalScore ||
      (score.totalScore === existing.score.totalScore &&
        Boolean(candidate.syncedLyrics) &&
        !existing.syncedLyrics)

    if (shouldReplace) {
      deduped.set(key, {
        ...candidate,
        score
      })
    }
  }

  const ranked = [...deduped.values()].sort((left, right) => {
    if (right.score.totalScore !== left.score.totalScore) {
      return right.score.totalScore - left.score.totalScore
    }

    const rightSynced = Number(Boolean(right.syncedLyrics))
    const leftSynced = Number(Boolean(left.syncedLyrics))
    if (rightSynced !== leftSynced) return rightSynced - leftSynced

    if (left.score.durationDistance !== right.score.durationDistance) {
      return left.score.durationDistance - right.score.durationDistance
    }

    return Number(Boolean(right.albumName)) - Number(Boolean(left.albumName))
  })

  return ranked[0] || null
}

const resolveLyrics = async ({ track, artist, album, durationMs }) => {
  const context = {
    track: String(track || '').trim(),
    artist: String(artist || '').trim(),
    album: String(album || '').trim(),
    durationSeconds: normalizeDurationSeconds(durationMs),
    trackMatchCandidates: toTrackMatchCandidates(track),
    trackQueryCandidates: toTrackQueryCandidates(track),
    artistMatchCandidates: toArtistMatchCandidates(artist),
    artistQueryCandidates: toArtistQueryCandidates(artist),
    albumMatchCandidates: toAlbumMatchCandidates(album),
    albumQueryCandidates: toAlbumQueryCandidates(album)
  }

  const collectedCandidates = []

  for (const params of buildDirectLookupAttempts(context)) {
    const result = await lookupLyricsByMetadata(params)
    if (!result || !hasUsableLyrics(result)) continue

    const candidate = {
      ...result,
      source: 'direct',
      query: params
    }
    const score = scoreCandidateMatch(context, candidate)

    collectedCandidates.push(candidate)

    if (score.highConfidence && candidate.syncedLyrics) {
      return {
        candidate,
        rankedCandidates: [
          {
            ...candidate,
            score
          }
        ]
      }
    }
  }

  const searchAttempts = buildSearchAttempts(context)
  const searchResponses = await Promise.all(
    searchAttempts.map(params => searchLyrics(params))
  )

  for (let index = 0; index < searchResponses.length; index += 1) {
    const params = searchAttempts[index]
    const results = searchResponses[index]

    for (const result of results) {
      if (!hasUsableLyrics(result)) continue

      collectedCandidates.push({
        ...result,
        source: 'search',
        query: params
      })
    }
  }

  const bestCandidate = rankAndChooseCandidate(context, collectedCandidates)

  return {
    candidate: bestCandidate,
    rankedCandidates: bestCandidate ? [bestCandidate] : []
  }
}

const createLyricsServer = () =>
  http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      jsonResponse(res, 204, {})
      return
    }

    const url = new URL(req.url, `http://${req.headers.host}`)

    if (req.method !== 'GET' || url.pathname !== '/api/lyrics') {
      jsonResponse(res, 404, { error: 'Not found' })
      return
    }

    try {
      const track = (url.searchParams.get('track') || '').trim()
      const artist = (url.searchParams.get('artist') || '').trim()
      const album = (url.searchParams.get('album') || '').trim()
      const durationMs = (url.searchParams.get('durationMs') || '').trim()

      if (!track || !artist) {
        jsonResponse(res, 400, { error: 'track and artist are required' })
        return
      }

      const { candidate } = await resolveLyrics({
        track,
        artist,
        album,
        durationMs,
        isrc: (url.searchParams.get('isrc') || '').trim()
      })

      if (!candidate) {
        jsonResponse(res, 404, { syncedLyrics: '', lyrics: '' })
        return
      }

      jsonResponse(res, 200, {
        syncedLyrics: candidate.syncedLyrics || '',
        lyrics: candidate.plainLyrics || ''
      })
    } catch (error) {
      jsonResponse(res, 500, {
        error: 'Failed to fetch lyrics',
        details: error.message
      })
    }
  })

if (require.main === module) {
  const server = createLyricsServer()

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Lyrics proxy listening on http://0.0.0.0:${PORT}`)
  })
}

module.exports = {
  createLyricsServer,
  resolveLyrics,
  scoreCandidateMatch
}
