import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { Server as SocketServer } from 'socket.io'
import { app as electronApp } from 'electron'
import { ensureApiToken, store } from './store.js'

const HOST = '127.0.0.1'
const MAX_PORT_ATTEMPTS = 50

/**
 * Constant-time token comparison. Bails on length mismatch first, because
 * timingSafeEqual throws rather than returning false for unequal lengths.
 */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function extractToken(req) {
  const header = req.get('authorization')
  if (header && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return req.get('x-api-key') ?? null
}

/**
 * Binds to `startPort`, stepping upward past anything already listening.
 * Resolves with the live http.Server.
 */
function listenWithFallback(httpServer, startPort) {
  return new Promise((resolve, reject) => {
    let port = startPort
    let attempts = 0

    const onError = (err) => {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
        httpServer.removeListener('error', onError)
        reject(err)
        return
      }
      attempts += 1
      if (attempts >= MAX_PORT_ATTEMPTS) {
        httpServer.removeListener('error', onError)
        reject(
          new Error(
            `No free port found in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`
          )
        )
        return
      }
      port += 1
      httpServer.listen(port, HOST)
    }

    httpServer.on('error', onError)
    httpServer.once('listening', () => {
      httpServer.removeListener('error', onError)
      resolve(httpServer)
    })

    httpServer.listen(port, HOST)
  })
}

/**
 * Publishes the live port and token to a file in userData so external scripts
 * can find the API without the user copying anything by hand.
 */
function writeDiscoveryFile(port, token) {
  try {
    const path = join(electronApp.getPath('userData'), 'api.json')
    writeFileSync(
      path,
      JSON.stringify({ port, token, baseUrl: `http://${HOST}:${port}`, pid: process.pid }, null, 2)
    )
    return path
  } catch (err) {
    console.warn('[server] could not write api.json:', err.message)
    return null
  }
}

/**
 * Starts the local REST + Socket.IO server.
 *
 * @param {object}   opts
 * @param {import('./timer-engine.js').TimerEngine} opts.engine
 * @param {object}   [opts.auth]     object exposing handleOAuthCallback(query)
 * @param {Function} [opts.onExpire] called when the timer expires
 */
export async function startServer({ engine, auth }) {
  const token = ensureApiToken()
  const api = express()

  api.disable('x-powered-by')
  api.use(express.json({ limit: '64kb' }))

  // No CORS headers anywhere, by design. A required custom header forces a
  // preflight for any browser-originated call, and with no CORS response that
  // preflight fails -- so a random web page you visit cannot drive your timer
  // even though the server is listening on localhost.

  // --- unauthenticated: lets a caller confirm which port the app landed on
  api.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      app: 'timer-desktop',
      version: electronApp.getVersion(),
      port: req.socket.localPort,
      authRequired: true
    })
  })

  // --- unauthenticated: Google redirects the browser here, and the browser
  //     obviously has no API token. The OAuth `state` parameter is what
  //     authenticates this request.
  api.get('/oauth/callback', async (req, res) => {
    if (!auth?.handleOAuthCallback) {
      res.status(501).send('OAuth is not configured in this build.')
      return
    }
    const result = await auth.handleOAuthCallback(req.query)
    res.status(result.ok ? 200 : 400).type('html').send(result.html)
  })

  api.use('/api', (req, res, next) => {
    if (tokenMatches(extractToken(req), token)) return next()
    res.status(401).json({
      error: 'unauthorized',
      message: 'Provide the API token via the X-API-Key header or Authorization: Bearer <token>.'
    })
  })

  /* ------------------------------------------------------------- routes */

  api.get('/api/timer/status', (req, res) => {
    res.json(engine.getState())
  })

  api.post('/api/timer/start', (req, res) => {
    const { durationMs, label } = req.body ?? {}
    // Remember what the API asked for, so the UI reopens with the same value.
    if (durationMs != null && Number.isFinite(Number(durationMs)) && Number(durationMs) > 0) {
      store.set('lastDurationMs', Math.round(Number(durationMs)))
    }
    if (label != null) store.set('lastLabel', String(label))
    res.json(engine.start({ durationMs, label }))
  })

  api.post('/api/timer/pause', (req, res) => res.json(engine.pause()))
  api.post('/api/timer/resume', (req, res) => res.json(engine.resume()))
  api.post('/api/timer/toggle', (req, res) => res.json(engine.toggle()))
  api.post('/api/timer/reset', (req, res) => res.json(engine.reset()))
  api.post('/api/timer/stop', (req, res) => res.json(engine.stop()))

  api.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` })
  })

  // RangeError from the engine means the caller sent a bad duration.
  api.use((err, req, res, _next) => {
    const badInput = err instanceof RangeError || err instanceof SyntaxError
    if (!badInput) console.error('[server]', err)
    res.status(badInput ? 400 : 500).json({
      error: badInput ? 'bad_request' : 'internal_error',
      message: err.message
    })
  })

  /* ------------------------------------------------------------- listen */

  const httpServer = createServer(api)
  const preferredPort = store.get('preferredPort') ?? 3000
  await listenWithFallback(httpServer, preferredPort)
  const { port } = httpServer.address()

  /* ----------------------------------------------------------- socket.io */

  const io = new SocketServer(httpServer, {
    // Socket.IO v4 rejects cross-origin browser clients by default; leaving
    // CORS unset keeps that protection. Node/CLI subscribers are unaffected.
    serveClient: false
  })

  io.use((socket, next) => {
    const provided = socket.handshake.auth?.token ?? socket.handshake.headers['x-api-key']
    if (tokenMatches(provided, token)) return next()
    next(new Error('unauthorized'))
  })

  io.on('connection', (socket) => {
    socket.emit('timer:state', engine.getState())
  })

  const onState = (snapshot) => io.emit('timer:state', snapshot)
  const onExpired = (snapshot) => io.emit('timer:expired', snapshot)

  // The engine ticks ~5x a second for smooth UI redraw; socket subscribers
  // only want a heartbeat, so throttle the broadcast to once per second.
  let lastTickSecond = -1
  const onTick = (snapshot) => {
    const second = Math.ceil(snapshot.remainingMs / 1000)
    if (second === lastTickSecond) return
    lastTickSecond = second
    io.emit('timer:tick', snapshot)
  }

  engine.on('state', onState)
  engine.on('tick', onTick)
  engine.on('expired', onExpired)

  const discoveryPath = writeDiscoveryFile(port, token)
  console.log(`[server] listening on http://${HOST}:${port}`)
  if (preferredPort !== port) {
    console.log(`[server] port ${preferredPort} was busy, fell back to ${port}`)
  }

  return {
    port,
    token,
    discoveryPath,
    baseUrl: `http://${HOST}:${port}`,
    async close() {
      engine.off('state', onState)
      engine.off('tick', onTick)
      engine.off('expired', onExpired)
      await io.close()
      await new Promise((resolve) => httpServer.close(resolve))
    }
  }
}
