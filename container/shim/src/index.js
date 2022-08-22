import fsPromises from 'node:fs/promises'
import { cpus } from 'node:os'
import express from 'express'
import mimeTypes from 'mime-types'
import followRedirects from 'follow-redirects'
import crypto from 'node:crypto'
import xorDistance from 'xor-distance'
import pDefer from 'p-defer'
import pTimeout from 'p-timeout'
import timers from 'node:timers/promises'
import parseArgs from 'minimist'

import { addRegisterCheckRoute, deregister, register } from './modules/registration.js'
import {
  FIL_WALLET_ADDRESS,
  NODE_OPERATOR_EMAIL,
  NODE_UA,
  NODE_VERSION,
  nodeId,
  PORT,
  TESTING_CID,
  IPFS_GATEWAY_ORIGIN
} from './config.js'
import { streamCAR } from './utils/car.js'
import { trapServer } from './utils/trap.js'
import { debug } from './utils/logging.js'

import { submitRetrievals, initLogIngestor } from './modules/log_ingestor.js'

const { https } = followRedirects

const GATEWAY_TIMEOUT = 120_000
const PROXY_RESPONSE_HEADERS = [
  'content-disposition',
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'x-ipfs-path',
  'x-ipfs-roots',
  'x-ipfs-datasize',
  'x-content-type-options'
]

const argv = parseArgs(process.argv.slice(2))

debug('Saturn L1 Node')
debug.extend('id')(nodeId)
debug.extend('version')(NODE_VERSION)
debug.extend('important')('===== IMPORTANT =====')
debug.extend('important')(`Earnings will be sent to Filecoin wallet address: ${FIL_WALLET_ADDRESS}`)
debug.extend('important')(NODE_OPERATOR_EMAIL ? `Payment notifications and important update will be sent to: ${NODE_OPERATOR_EMAIL}` : 'NO OPERATOR EMAIL SET, WE HIGHLY RECOMMEND SETTING ONE')
debug.extend('important')('===== IMPORTANT =====')

process.on('SIGQUIT', shutdown)
process.on('SIGINT', shutdown)

setTimeout(async function () {
  if (argv.register !== false) {
    await register(true).catch(err => {
      debug(`Failed to register ${err.name} ${err.message}`)
      process.exit(1)
    })
  }

  // Start log ingestor
  await initLogIngestor()
}, 500)

const ipfsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Math.floor(256 / cpus().length)
})

const app = express()

const testCAR = await fsPromises.readFile('./public/QmQ2r6iMNpky5f1m4cnm3Yqw8VSvjuKpTcK1X7dBR1LkJF.car')

const connectedL2Nodes = new Map()
const openCARRequests = new Map()

function removeConnectedL2Node (id) {
  const { res, cleanedUp } = connectedL2Nodes.get(id)
  cleanedUp.value = true
  res.end()
  connectedL2Nodes.delete(id)
}

app.disable('x-powered-by')
app.set('trust proxy', true)

app.get('/favicon.ico', (req, res) => {
  res.sendStatus(404)
})

// Whenever nginx doesn't have a CAR file in cache, this is called
app.get('/ipns/:cid', handleCID)
app.get('/ipns/:cid/:path*', handleCID)
app.get('/ipfs/:cid', handleCID)
app.get('/ipfs/:cid/:path*', handleCID)

async function handleCID (req, res) {
  const cid = req.params.cid
  const format = getResponseFormat(req)

  debug(`Cache miss for ${req.path}`)

  res.set({
    'Content-Type': mimeTypes.lookup(req.path) || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Saturn-Node-Id': nodeId,
    'Saturn-Node-Version': NODE_VERSION
  })

  if (req.headers.range) {
    let [start, end] = req.headers.range.split('=')[1].split('-')
    start = parseInt(start, 10)
    end = parseInt(end, 10)

    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${testCAR.length}`
    })
    return res.status(206).end(testCAR.slice(start, end + 1))
  }

  // Testing CID
  if (cid === TESTING_CID) {
    return res.send(testCAR)
  }

  debug(`Fetch ${req.path} from L2s`)
  const cidHash = crypto.createHash('sha512').update(cid).digest()
  Array.from(connectedL2Nodes.values())
    .map(l2Node => ({
      ...l2Node,
      distance: xorDistance(
        cidHash,
        l2Node.idHash
      )
    }))
    .sort((a, b) => xorDistance.compare(a.distance, b.distance))
    .slice(0, 3)
    .forEach(({ res }) => {
      const payload = {
        requestId: req.get('saturn-transfer-id'),
        cid
      }
      res.write(`${JSON.stringify(payload)}\n`)
    })

  const onResponse = pDefer()
  openCARRequests.set(cid, onResponse)

  let carResponse
  try {
    carResponse = await pTimeout(onResponse.promise, {
      milliseconds: 10_000
    })
  } catch {}
  if (carResponse) {
    try {
      await streamCAR(carResponse.req, res)
      return
    } finally {
      carResponse.res.end()
    }
  }

  debug(`Fetch ${req.path} from IPFS`)
  const ipfsUrl = new URL(IPFS_GATEWAY_ORIGIN + req.path)
  if (format) {
    ipfsUrl.searchParams.set('format', format)
  }
  for (const key of ['filename', 'download']) {
    if (key in req.query) {
      ipfsUrl.searchParams.set(key, req.query[key])
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, GATEWAY_TIMEOUT)

  const ipfsReq = https.get(ipfsUrl, {
    agent: ipfsAgent,
    timeout: GATEWAY_TIMEOUT,
    headers: { 'User-Agent': NODE_UA },
    signal: controller.signal
  }, async fetchRes => {
    clearTimeout(timeout)
    const { statusCode } = fetchRes
    if (statusCode >= 400) {
      debug.extend('error')(`Invalid response from IPFS gateway (${statusCode}) for ${cid}`)
    }

    res.status(statusCode)
    proxyResponseHeaders(fetchRes, res)

    if (format === 'car') {
      streamCAR(fetchRes, res).catch(() => {})
    } else {
      fetchRes.pipe(res)
    }
  }).on('error', err => {
    clearTimeout(timeout)
    debug.extend('error')(`Error fetching from IPFS gateway for ${cid}: ${err.name} ${err.message}`)
    if (controller.signal.aborted) {
      return res.sendStatus(504)
    }
    res.sendStatus(502)
  }).on('timeout', () => {
    clearTimeout(timeout)
    debug.extend('error')(`Timeout from IPFS gateway for ${cid}`)
    ipfsReq.destroy()
    res.destroy()
  })

  req.on('close', () => {
    clearTimeout(timeout)
    if (!res.writableEnded) {
      debug.extend('error')('Client aborted early, terminating gateway request')
      ipfsReq.destroy()
    }
  })
}

app.get('/register/:l2NodeId', async function (req, res) {
  res.writeHead(200, {
    'Cache-Control': 'no-cache'
  })
  const { l2NodeId } = req.params
  if (connectedL2Nodes.has(l2NodeId)) {
    removeConnectedL2Node(l2NodeId)
  }
  const cleanedUp = { value: false }
  connectedL2Nodes.set(l2NodeId, {
    res,
    cleanedUp,
    idHash: crypto.createHash('sha512').update(l2NodeId).digest()
  })
  while (!res.destroyed) {
    res.write('\n')
    await timers.setTimeout(5_000)
  }
  if (!cleanedUp.value) {
    removeConnectedL2Node(l2NodeId)
  }
})

app.post('/data/:cid', function (req, res) {
  const { cid } = req.params
  const openCARRequest = openCARRequests.get(cid)
  if (!openCARRequest) {
    res.end()
    return
  }
  openCARRequests.delete(cid)
  openCARRequest.resolve({ req, res })
})

addRegisterCheckRoute(app)

const server = app.listen(PORT, '127.0.0.1', async () => {
  debug.extend('server')('shim process running')
})

server.keepAliveTimeout = 60 * 60 * 1000

trapServer(server)

// https://github.com/ipfs/specs/blob/main/http-gateways/PATH_GATEWAY.md#response-headers
function proxyResponseHeaders (ipfsRes, nodeRes) {
  for (const key of PROXY_RESPONSE_HEADERS) {
    if (key in ipfsRes.headers) {
      nodeRes.set(key, ipfsRes.headers[key])
    }
  }
}

function getResponseFormat (req) {
  // ipfs gw returns default format for invalid formats
  if (req.query.format) {
    return req.query.format
  } else if (req.headers.accept === 'application/vnd.ipld.car') {
    return 'car'
  } else if (req.headers.accept === 'application/vnd.ipld.raw') {
    return 'raw'
  } else {
    return null
  }
}

async function shutdown () {
  try {
    await Promise.allSettled([
      submitRetrievals(),
      deregister()
    ])
  } catch (err) {
    debug(`Failed during shutdown: ${err.name} ${err.message}`)
  } finally {
    debug('Exiting...')
    process.exit(0)
  }
}
