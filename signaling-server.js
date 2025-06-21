// This is the same server code, optimized for a platform like Render.

const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const { v4: uuidv4 } = require("uuid")

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

const rooms = {} // Store rooms and their clients
const PEER_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const ROOM_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes

const adjectives = [
  "Electric",
  "Blue",
  "Quick",
  "Silent",
  "Happy",
  "Green",
  "Fast",
  "Clever",
  "Brave",
  "Shiny",
  "Wise",
  "Gentle",
  "Red",
  "Cosmic",
  "Digital",
]
const nouns = [
  "Muffin",
  "Panda",
  "River",
  "Star",
  "Fox",
  "Cloud",
  "Tiger",
  "Ocean",
  "Lion",
  "Moon",
  "Robot",
  "Wizard",
  "Comet",
  "Galaxy",
  "Pixel",
]

function generateFunName() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const num = Math.floor(Math.random() * 100)
  return `${adj} ${noun} ${num}`
}

wss.on("connection", (ws) => {
  const peerId = uuidv4()
  const peerName = generateFunName()
  ws.peerId = peerId
  ws.peerName = peerName
  ws.lastActivity = Date.now()

  console.log(`Peer ${peerName} (${peerId}) connected.`)

  ws.on("message", (message) => {
    ws.lastActivity = Date.now()
    let data
    try {
      data = JSON.parse(message)
    } catch (e) {
      console.error(`Invalid JSON received from ${ws.peerName} (${ws.peerId}):`, message)
      ws.send(JSON.stringify({ type: "error", payload: "Invalid JSON format." }))
      return
    }

    const { type, roomId, payload } = data

    if (!roomId && type !== "create-room" && type !== "ping") {
      ws.send(JSON.stringify({ type: "error", payload: "Room ID is required for this action." }))
      return
    }

    if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }))
      return
    }

    if (type === "create-room") {
      const newRoomId = payload?.requestedRoomId || uuidv4().slice(0, 12)
      if (rooms[newRoomId]) {
        ws.send(JSON.stringify({ type: "error", payload: `Room ${newRoomId} already exists.` }))
        return
      }
      rooms[newRoomId] = {
        peers: new Map(),
        lastActivity: Date.now(),
        passwordProtected: !!payload?.password,
        passwordHash: payload?.password,
      }
      console.log(`Room ${newRoomId} created.`)
      joinRoom(ws, newRoomId, peerName, payload?.password)
    } else if (type === "join-room") {
      joinRoom(ws, roomId, peerName, payload?.password)
    } else if (type === "update-nickname") {
      const { newNickname } = payload
      if (ws.roomId && rooms[ws.roomId] && rooms[ws.roomId].peers.has(ws.peerId)) {
        const oldNickname = rooms[ws.roomId].peers.get(ws.peerId).name
        rooms[ws.roomId].peers.get(ws.peerId).name = newNickname
        ws.peerName = newNickname

        broadcastToRoom(ws.roomId, { type: "nickname-updated", payload: { peerId: ws.peerId, newNickname } }, ws.peerId)
        ws.send(JSON.stringify({ type: "nickname-self-updated", payload: { newNickname } }))
      }
    } else if (ws.roomId && rooms[ws.roomId] && rooms[ws.roomId].peers.has(peerId)) {
      const targetPeerId = payload?.targetPeerId
      if (targetPeerId && rooms[ws.roomId].peers.has(targetPeerId)) {
        const targetPeer = rooms[ws.roomId].peers.get(targetPeerId)
        targetPeer.ws.send(JSON.stringify({ type, payload: { ...payload, senderPeerId: peerId } }))
      } else {
        broadcastToRoom(roomId, { type, payload: { ...payload, senderPeerId: peerId } }, peerId)
      }
    }
  })

  function joinRoom(socket, roomIdToJoin, currentPeerName, passwordAttempt) {
    if (!rooms[roomIdToJoin]) {
      socket.send(JSON.stringify({ type: "error", payload: `Room ${roomIdToJoin} does not exist.` }))
      return
    }
    if (rooms[roomIdToJoin].passwordProtected && rooms[roomIdToJoin].passwordHash !== passwordAttempt) {
      socket.send(JSON.stringify({ type: "error", payload: `Incorrect password for room ${roomIdToJoin}.` }))
      return
    }
    if (socket.roomId) leaveRoom(socket)

    rooms[roomIdToJoin].peers.set(socket.peerId, { ws: socket, name: currentPeerName })
    rooms[roomIdToJoin].lastActivity = Date.now()
    socket.roomId = roomIdToJoin

    const currentPeers = Array.from(rooms[roomIdToJoin].peers.values())
      .filter((p) => p.ws.peerId !== socket.peerId)
      .map((p) => ({ peerId: p.ws.peerId, peerName: p.name }))

    socket.send(
      JSON.stringify({
        type: "room-joined",
        payload: { selfId: socket.peerId, selfName: currentPeerName, peers: currentPeers, roomId: roomIdToJoin },
      }),
    )
    broadcastToRoom(
      roomIdToJoin,
      { type: "peer-joined", payload: { peerId: socket.peerId, peerName: currentPeerName } },
      socket.peerId,
    )
    console.log(`Peer ${currentPeerName} (${socket.peerId}) joined room ${roomIdToJoin}.`)
  }

  function leaveRoom(socket) {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].peers.delete(socket.peerId)
      broadcastToRoom(
        socket.roomId,
        { type: "peer-left", payload: { peerId: socket.peerId, peerName: socket.peerName } },
        socket.peerId,
      )
      if (rooms[socket.roomId].peers.size === 0) {
        console.log(`Room ${socket.roomId} is now empty.`)
      }
      socket.roomId = null
    }
  }

  ws.on("close", () => {
    console.log(`Peer ${ws.peerName} (${ws.peerId}) disconnected.`)
    leaveRoom(ws)
  })
})

function broadcastToRoom(roomId, message, excludePeerId) {
  if (rooms[roomId]) {
    rooms[roomId].peers.forEach((peer) => {
      if (peer.ws.peerId !== excludePeerId) {
        peer.ws.send(JSON.stringify(message))
      }
    })
  }
}

// Cleanup inactive peers and empty rooms
setInterval(() => {
  const now = Date.now()
  for (const roomId in rooms) {
    rooms[roomId].peers.forEach((peer, peerId) => {
      if (now - peer.ws.lastActivity > PEER_TIMEOUT_MS) {
        peer.ws.terminate()
      }
    })
    if (rooms[roomId].peers.size === 0 && now - rooms[roomId].lastActivity > ROOM_TIMEOUT_MS) {
      delete rooms[roomId]
    }
  }
}, 30000)

// Health check endpoint for Render
app.get("/", (req, res) => {
  res.status(200).send("Signaling server is running.")
})

const PORT = process.env.PORT || 10000 // Render provides the PORT env var
server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`)
})
