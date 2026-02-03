const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const MAX_PLAYERS = 4;

// Simple in-memory rooms state
const rooms = {}; // roomId -> { players: [{id, name, seat}], deck, hands, trick, turnIndex, started }

function makeDeck() {
  const suits = ['Eichel', 'Gras', 'Herz', 'Schelln']; // German suits
  const ranks = ['7','8','9','10','Unter','Ober','König','Ass']; // 32 cards
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ id: `${rank}_von_${suit}`, suit, rank });
    }
  }
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function cardPower(card) {
  // Assign numeric power for trick resolution, simplified Schafkopf ordering.
  // Trumps: all Herz + all Ober (Damen) + all Unter (Buben)
  // Highest: Unter (all), then Ober (all), then Ass, 10, König, 9,8,7
  const trump = (card.suit === 'Herz') || (card.rank === 'Ober') || (card.rank === 'Unter');
  let base;
  if (card.rank === 'Unter') base = 100;
  else if (card.rank === 'Ober') base = 90;
  else if (card.rank === 'Ass') base = 80;
  else if (card.rank === '10') base = 70;
  else if (card.rank === 'König') base = 60;
  else if (card.rank === '9') base = 50;
  else if (card.rank === '8') base = 40;
  else if (card.rank === '7') base = 30;
  else base = 0;
  // Add suit tie-breaker so cards have unique power
  const suitOrder = { 'Eichel': 1, 'Gras': 2, 'Herz': 3, 'Schelln': 4 };
  return (trump ? 1000 : 0) + base + suitOrder[card.suit];
}

function createRoomIfMissing(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [], // { socketId, name, seatIndex }
      started: false,
      deck: [],
      hands: {}, // socketId -> [cards]
      table: [], // played cards in current trick: [{socketId, card}]
      turnIndex: 0, // index in players array for whose turn
      trickLeader: 0
    };
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', ({ roomId, name }) => {
    currentRoom = roomId || 'default';
    createRoomIfMissing(currentRoom);
    socket.join(currentRoom);
    // send current room state to client
    io.to(currentRoom).emit('roomState', { players: rooms[currentRoom].players.map(p => ({ name: p.name, seatIndex: p.seatIndex })) });
  });

  socket.on('takeSeat', ({ roomId, seatIndex, name }) => {
    createRoomIfMissing(roomId);
    const room = rooms[roomId];
    if (room.players.find(p => p.seatIndex === seatIndex)) {
      socket.emit('seatFailed', { reason: 'Sitz bereits belegt' });
      return;
    }
    room.players.push({ socketId: socket.id, name: name || 'Spieler', seatIndex });
    io.to(roomId).emit('roomState', { players: room.players.map(p => ({ name: p.name, seatIndex: p.seatIndex })) });
  });

  socket.on('leaveSeat', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.socketId !== socket.id);
    delete room.hands[socket.id];
    io.to(roomId).emit('roomState', { players: room.players.map(p => ({ name: p.name, seatIndex: p.seatIndex })) });
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.players.length !== MAX_PLAYERS) {
      socket.emit('startFailed', { reason: 'Es müssen 4 Spieler am Tisch sitzen' });
      return;
    }
    room.started = true;
    // Setup deck and hands
    const deck = makeDeck();
    shuffle(deck);
    room.deck = deck;
    // deal 8 cards each, in order of seats (by seatIndex ascending)
    const playersBySeat = [...room.players].sort((a,b)=>a.seatIndex-b.seatIndex);
    playersBySeat.forEach((p, idx) => {
      room.hands[p.socketId] = deck.slice(idx*8, idx*8+8);
    });
    room.table = [];
    room.trickLeader = 0;
    room.turnIndex = 0; // starting with player 0 in playersBySeat
    // announce hands privately
    for (const p of playersBySeat) {
      io.to(p.socketId).emit('deal', { hand: room.hands[p.socketId], seatIndex: p.seatIndex });
    }
    // broadcast that game started + seats order
    io.to(roomId).emit('gameStarted', { players: playersBySeat.map(p => ({ name: p.name, seatIndex: p.seatIndex })) });
    // set current turn by socket id
    const currentPlayerSocket = playersBySeat[room.turnIndex].socketId;
    io.to(roomId).emit('turn', { socketId: currentPlayerSocket });
  });

  socket.on('playCard', ({ roomId, cardId }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex === -1) return;
    // check if it's this player's turn
    const playersBySeat = [...room.players].sort((a,b)=>a.seatIndex-b.seatIndex);
    const currentSocket = playersBySeat[room.turnIndex].socketId;
    if (currentSocket !== socket.id) {
      socket.emit('playFailed', { reason: 'Nicht dran' });
      return;
    }
    const hand = room.hands[socket.id];
    const cardPos = hand.findIndex(c => c.id === cardId);
    if (cardPos === -1) {
      socket.emit('playFailed', { reason: 'Karte nicht im Blatt' });
      return;
    }
    const card = hand.splice(cardPos,1)[0];
    room.table.push({ socketId: socket.id, card });
    io.to(roomId).emit('cardPlayed', { seatIndex: room.players.find(p=>p.socketId===socket.id).seatIndex, card });
    // next turn
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    // if trick complete (4 cards)
    if (room.table.length === room.players.length) {
      // determine trick winner by power, considering lead suit and trumps
      const lead = room.table[0].card;
      const leadSuit = (() => {
        if ((lead.suit === 'Herz') || (lead.rank === 'Ober') || (lead.rank === 'Unter')) {
          // If lead is trump, trick trumped; treat as trump lead
          return null; // signals trump lead
        }
        return lead.suit;
      })();
      let best = null;
      for (const played of room.table) {
        const pCard = played.card;
        // compute effective power: if trump => cardPower (with trump flag), else if following suit => base power, else minimal
        const isTrump = (pCard.suit === 'Herz') || (pCard.rank === 'Ober') || (pCard.rank === 'Unter');
        let power = cardPower(pCard);
        if (!isTrump) {
          // if leadSuit exists and card is not of lead suit, give low power
          if (leadSuit && pCard.suit !== leadSuit) power = cardPower({ ...pCard, rank: '7', suit: pCard.suit }) - 200;
        }
        if (!best || power > best.power) best = { socketId: played.socketId, power };
      }
      // winner found
      const winnerSocket = best.socketId;
      const winnerSeat = room.players.find(p => p.socketId === winnerSocket).seatIndex;
      io.to(roomId).emit('trickWon', { winnerSeat, trick: room.table });
      // clear table, set next leader to winner
      const winnerSeatIndexInPlayersBySeat = playersBySeat.findIndex(p=>p.socketId===winnerSocket);
      room.trickLeader = winnerSeatIndexInPlayersBySeat;
      room.turnIndex = winnerSeatIndexInPlayersBySeat;
      room.table = [];
      // check for end of hand (all hands empty)
      const handsEmpty = Object.values(room.hands).every(h => h.length === 0);
      if (handsEmpty) {
        io.to(roomId).emit('handEnded', { message: 'Stichrunde beendet' });
        room.started = false;
        // For simplicity not computing points now.
      } else {
        const currentPlayerSocket = playersBySeat[room.turnIndex].socketId;
        io.to(roomId).emit('turn', { socketId: currentPlayerSocket });
      }
    } else {
      // not yet complete: notify next player
      const playersBySeatNow = [...room.players].sort((a,b)=>a.seatIndex-b.seatIndex);
      const nextSocket = playersBySeatNow[room.turnIndex].socketId;
      io.to(roomId).emit('turn', { socketId: nextSocket });
    }
  });

  socket.on('disconnecting', () => {
    for (const roomId of Object.keys(socket.rooms)) {
      if (rooms[roomId]) {
        rooms[roomId].players = rooms[roomId].players.filter(p => p.socketId !== socket.id);
        delete rooms[roomId].hands[socket.id];
        io.to(roomId).emit('roomState', { players: rooms[roomId].players.map(p => ({ name: p.name, seatIndex: p.seatIndex })) });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
