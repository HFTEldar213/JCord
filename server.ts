import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { dbOps } from "./src/db";

const app = express();
const PORT = 3000;

app.use(express.json());

// API Routes
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || username.length > 25 || username.includes('@')) {
    return res.status(400).json({ error: "Invalid username. Cannot contain '@' and must be max 25 characters." });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  try {
    const existing = dbOps.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: "Username taken" });
    }
    const user = dbOps.createUser(username, password);
    res.json(user);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = dbOps.getUserByUsername(username);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  
  if (!dbOps.verifyPassword(user, password)) {
    return res.status(401).json({ error: "Invalid password" });
  }
  
  const { password_hash, ...safeUser } = user;
  res.json(safeUser);
});

const broadcastUserUpdate = (userId: string) => {
  const updatedUser = dbOps.getUserById(userId);
  if (!updatedUser) return;
  
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'user_update', data: updatedUser }));
  }
  
  const friends = dbOps.getFriends(userId);
  friends.forEach(friend => {
    const friendWs = clients.get(friend.id);
    if (friendWs && friendWs.readyState === WebSocket.OPEN) {
      friendWs.send(JSON.stringify({ type: 'friend_update', data: updatedUser }));
    }
  });
};

// Admin Routes
app.post("/api/admin/verify", (req, res) => {
  const { password } = req.body;
  if (password === '250226') {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid admin password" });
  }
});

app.get("/api/admin/users", (req, res) => {
  const users = dbOps.getAllUsers();
  res.json(users);
});

app.post("/api/admin/revoke-title", (req, res) => {
  const { userId, title } = req.body;
  dbOps.revokeTitle(userId, title);
  broadcastUserUpdate(userId);
  res.json({ success: true });
});

app.post("/api/admin/grant-title", (req, res) => {
  const { userId, title } = req.body;
  dbOps.grantTitle(userId, title);
  broadcastUserUpdate(userId);
  res.json({ success: true });
});

app.post("/api/admin/verify-user", (req, res) => {
  const { userId, verified } = req.body;
  dbOps.setVerified(userId, verified);
  broadcastUserUpdate(userId);
  res.json({ success: true });
});

app.post("/api/admin/delete-user", (req, res) => {
  const { userId } = req.body;
  const friends = dbOps.getFriends(userId);
  
  dbOps.deleteUser(userId);
  
  const ws = clients.get(userId);
  if (ws) {
    ws.close();
    clients.delete(userId);
  }
  
  friends.forEach(friend => {
    const friendWs = clients.get(friend.id);
    if (friendWs && friendWs.readyState === WebSocket.OPEN) {
      friendWs.send(JSON.stringify({ type: 'friend_offline', data: { id: userId } }));
      // Also trigger a friend list refresh
      friendWs.send(JSON.stringify({ type: 'friend_update', data: { id: userId, deleted: true } }));
    }
  });
  
  res.json({ success: true });
});

app.post("/api/admin/ban", (req, res) => {
  const { userId, reason, duration } = req.body;
  const until = Date.now() + duration * 60 * 60 * 1000;
  dbOps.banUser(userId, reason, until);
  
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'banned', data: { reason, until } }));
  }
  
  res.json({ success: true });
});

app.post("/api/admin/unban", (req, res) => {
  const { userId } = req.body;
  dbOps.unbanUser(userId);
  
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'unbanned' }));
  }
  
  res.json({ success: true });
});

app.post("/api/admin/grant-jcoins", (req, res) => {
  const { userId, amount } = req.body;
  const user = dbOps.getUserById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  
  const newJcoins = Math.max(0, (user.jcoins || 0) + amount);
  dbOps.updateUser(userId, { jcoins: newJcoins });
  
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'jcoins_awarded', data: { amount } }));
  }
  
  res.json({ success: true });
});

app.get("/api/admin/messages", (req, res) => {
  const messages = dbOps.getAllMessages();
  res.json(messages);
});

app.get("/api/admin/chats", (req, res) => {
  try {
    const chats = dbOps.getAllChats();
    res.json(chats);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch chats" });
  }
});

app.get("/api/admin/chats/:user1Id/:user2Id/messages", (req, res) => {
  const { user1Id, user2Id } = req.params;
  try {
    const messages = dbOps.getMessagesForChat(user1Id, user2Id);
    res.json(messages);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.get("/api/users/search", (req, res) => {
  const { q, userId } = req.query;
  if (!q || !userId) return res.json([]);
  try {
    const users = dbOps.searchUsers(q as string, userId as string);
    res.json(users);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/api/users/:userId", (req, res) => {
  const user = dbOps.getUserById(req.params.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { password_hash, ...safeUser } = user as any;
  res.json(safeUser);
});

app.patch("/api/users/:userId", (req, res) => {
  const { status, avatar_url, active_title, display_name, username } = req.body;
  const userId = req.params.userId;
  
  const user = dbOps.getUserById(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (active_title !== undefined && user.active_title === 'SCAM' && active_title !== 'SCAM') {
    const scamAssignedAt = user.scam_assigned_at || 0;
    const hoursPassed = (Date.now() - scamAssignedAt) / (1000 * 60 * 60);
    if (hoursPassed < 42) {
      return res.status(403).json({ error: `You cannot change the SCAM title for another ${Math.ceil(42 - hoursPassed)} hours.` });
    }
  }

  const updates: any = { status, avatar_url, active_title };

  if (display_name && display_name !== user.display_name) {
    const lastChanged = user.display_name_changed_at || 0;
    const daysPassed = (Date.now() - lastChanged) / (1000 * 60 * 60 * 24);
    if (daysPassed < 3) {
      return res.status(403).json({ error: `You can only change your display name once every 3 days. Try again in ${Math.ceil(3 - daysPassed)} days.` });
    }
    updates.display_name = display_name;
    updates.display_name_changed_at = Date.now();
  }

  if (username && username !== user.username) {
    if (username.includes('@')) {
      return res.status(400).json({ error: "Username cannot contain '@'." });
    }
    const lastChanged = user.username_changed_at || 0;
    const weeksPassed = (Date.now() - lastChanged) / (1000 * 60 * 60 * 24 * 7);
    if (weeksPassed < 3) {
      return res.status(403).json({ error: `You can only change your username once every 3 weeks. Try again in ${Math.ceil(3 - weeksPassed)} weeks.` });
    }
    const existing = dbOps.getUserByUsername(username);
    if (existing && existing.id !== userId) {
      return res.status(409).json({ error: "Username taken" });
    }
    updates.username = username;
    updates.username_changed_at = Date.now();
  }

  dbOps.updateUser(userId, updates);
  const updatedUser = dbOps.getUserById(userId);
  if (!updatedUser) {
    return res.status(404).json({ error: "User not found" });
  }
  
  broadcastUserUpdate(userId);

  const { password_hash, ...safeUser } = updatedUser as any;
  res.json(safeUser);
});

app.post("/api/friends/request", (req, res) => {
  const { senderId, receiverId } = req.body;
  try {
    const existing = dbOps.getFriendship(senderId, receiverId);
    if (existing) {
      return res.status(400).json({ error: "Friendship already exists or pending" });
    }
    const friendship = dbOps.createFriendRequest(senderId, receiverId);
    
    // Notify receiver
    const receiverWs = clients.get(receiverId);
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
      receiverWs.send(JSON.stringify({ type: 'friend_request', data: friendship }));
    }
    
    res.json(friendship);
  } catch (e) {
    res.status(500).json({ error: "Failed to send request" });
  }
});

app.post("/api/friends/respond", (req, res) => {
  const { friendshipId, status } = req.body;
  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const friendship = dbOps.updateFriendshipStatus(friendshipId, status);
  
  if (friendship) {
    const senderWs = clients.get(friendship.sender_id);
    if (senderWs && senderWs.readyState === WebSocket.OPEN) {
      senderWs.send(JSON.stringify({ type: 'friend_request_update', data: friendship }));
    }
    const receiverWs = clients.get(friendship.receiver_id);
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
      receiverWs.send(JSON.stringify({ type: 'friend_request_update', data: friendship }));
    }
  }
  
  res.json({ success: true });
});

app.get("/api/friends/:userId", (req, res) => {
  const friends = dbOps.getFriends(req.params.userId);
  const friendsWithOnlineStatus = friends.map(f => ({
    ...f,
    is_online: clients.has(f.id)
  }));
  res.json(friendsWithOnlineStatus);
});

app.get("/api/friends/requests/:userId", (req, res) => {
  const requests = dbOps.getPendingRequests(req.params.userId);
  res.json(requests);
});

app.get("/api/messages/:user1Id/:user2Id", (req, res) => {
  const messages = dbOps.getMessages(req.params.user1Id, req.params.user2Id);
  res.json(messages);
});

const SHOP_ITEMS = [
  { id: 'title_bro', name: 'Bro', type: 'title', price: 500 },
  { id: 'title_mylove', name: 'My Love', type: 'title', price: 1000 },
  { id: 'title_sigma', name: 'Sigma', type: 'title', price: 1500 },
  { id: 'wp_pulse', name: 'Pulse', type: 'wallpaper', price: 2000 },
  { id: 'wp_dance', name: 'Dance', type: 'wallpaper', price: 2500 },
  { id: 'wp_matrix', name: 'Matrix', type: 'wallpaper', price: 3000 },
];

export const NFT_GIFTS = [
  { id: 'nft_gaming_pc', name: 'Gaming PC', collection: 'Gaming', price: 4000 },
  { id: 'nft_keyboard', name: 'Keyboard', collection: 'Gaming', price: 3000 },
  { id: 'nft_videocard', name: 'Videocard', collection: 'Gaming', price: 2500 },
  { id: 'nft_retro_tv', name: 'Retro TV', collection: 'Retro', price: 3500 },
  { id: 'nft_broken_tv', name: 'Broken TV', collection: 'Retro', price: 2000 },
  { id: 'nft_radio', name: 'Radio', collection: 'Retro', price: 2000 },
  { id: 'nft_dvd', name: 'DVD', collection: 'Retro', price: 1000 },
];

export const CASES = [
  { id: 'case_classic', name: 'Classic Case', price: 700, collection: 'Classic' },
  { id: 'case_retro', name: 'Retro Case', price: 2000, collection: 'Retro' },
  { id: 'case_gaming', name: 'Gaming Case', price: 3000, collection: 'Gaming' },
];

app.post("/api/shop/purchase", (req, res) => {
  const { itemId } = req.body;
  const userId = req.headers['x-user-id'] as string; // Assuming we pass this or get it from session
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const user = dbOps.getUserById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  if (user.unlocked_items?.includes(itemId)) {
    return res.status(400).json({ error: "Item already unlocked" });
  }

  if ((user.jcoins || 0) < item.price) {
    return res.status(400).json({ error: "Not enough JCoins" });
  }

  const newJcoins = (user.jcoins || 0) - item.price;
  const newUnlocked = [...(user.unlocked_items || []), itemId];
  
  const updates: any = { jcoins: newJcoins, unlocked_items: newUnlocked };
  
  if (item.type === 'title') {
    updates.titles = Array.from(new Set([...(user.titles || []), item.name]));
  }

  dbOps.updateUser(userId, updates);
  broadcastUserUpdate(userId);
  
  res.json({ success: true });
});

app.post("/api/shop/equip", (req, res) => {
  const { itemId, type } = req.body;
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const user = dbOps.getUserById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (!user.unlocked_items?.includes(itemId)) {
    return res.status(400).json({ error: "Item not unlocked" });
  }

  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const updates: any = {};
  if (type === 'title') {
    updates.active_title = item.name;
  } else if (type === 'wallpaper') {
    updates.chat_wallpaper = itemId;
  }

  dbOps.updateUser(userId, updates);
  broadcastUserUpdate(userId);

  res.json({ success: true });
});

app.post("/api/shop/open-case", (req, res) => {
  const { caseId } = req.body;
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const user = dbOps.getUserById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const caseItem = CASES.find(c => c.id === caseId);
  if (!caseItem) return res.status(404).json({ error: "Case not found" });

  if ((user.jcoins || 0) < caseItem.price) {
    return res.status(400).json({ error: "Not enough JCoins" });
  }

  // Determine which NFTs can drop
  let possibleDrops = NFT_GIFTS;
  if (caseItem.collection !== 'Classic') {
    possibleDrops = NFT_GIFTS.filter(nft => nft.collection === caseItem.collection);
  }

  if (possibleDrops.length === 0) {
    return res.status(500).json({ error: "No items available in this case" });
  }

  // Randomly select one
  const drop = possibleDrops[Math.floor(Math.random() * possibleDrops.length)];
  
  // Create a unique instance of the NFT
  const newNft = {
    ...drop,
    id: `${drop.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    acquiredAt: Date.now(),
    isPinned: false
  };

  const currentNfts = user.nft_gifts || [];
  
  dbOps.updateUser(userId, {
    jcoins: (user.jcoins || 0) - caseItem.price,
    nft_gifts: [...currentNfts, newNft]
  });

  broadcastUserUpdate(userId);
  res.json({ success: true, drop: newNft });
});

app.post("/api/shop/sell-nft", (req, res) => {
  const { nftId } = req.body;
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const user = dbOps.getUserById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const currentNfts = user.nft_gifts || [];
  const nftIndex = currentNfts.findIndex(n => n.id === nftId);
  
  if (nftIndex === -1) {
    return res.status(404).json({ error: "NFT not found in your inventory" });
  }

  const nft = currentNfts[nftIndex];
  const sellPrice = Math.floor(nft.price * 0.8); // 80% of original price

  const updatedNfts = [...currentNfts];
  updatedNfts.splice(nftIndex, 1);

  dbOps.updateUser(userId, {
    jcoins: (user.jcoins || 0) + sellPrice,
    nft_gifts: updatedNfts
  });

  broadcastUserUpdate(userId);
  res.json({ success: true, jcoinsEarned: sellPrice });
});

app.post("/api/shop/pin-nft", (req, res) => {
  const { nftId, isPinned } = req.body;
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const user = dbOps.getUserById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const currentNfts = user.nft_gifts || [];
  const updatedNfts = currentNfts.map(nft => 
    nft.id === nftId ? { ...nft, isPinned } : nft
  );

  dbOps.updateUser(userId, { nft_gifts: updatedNfts });
  broadcastUserUpdate(userId);
  res.json({ success: true });
});

app.post("/api/shop/gift-nft", (req, res) => {
  const { nftId, receiverId } = req.body;
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  if (userId === receiverId) return res.status(400).json({ error: "Cannot gift to yourself" });

  const sender = dbOps.getUserById(userId);
  const receiver = dbOps.getUserById(receiverId);
  
  if (!sender || !receiver) return res.status(404).json({ error: "User not found" });

  const senderNfts = sender.nft_gifts || [];
  const nftIndex = senderNfts.findIndex(n => n.id === nftId);
  
  if (nftIndex === -1) {
    return res.status(404).json({ error: "NFT not found in your inventory" });
  }

  const nft = senderNfts[nftIndex];
  
  // Remove from sender
  const updatedSenderNfts = [...senderNfts];
  updatedSenderNfts.splice(nftIndex, 1);
  
  // Add to receiver (unpin it)
  const receiverNfts = receiver.nft_gifts || [];
  const updatedReceiverNfts = [...receiverNfts, { ...nft, isPinned: false, acquiredAt: Date.now() }];

  dbOps.updateUser(userId, { nft_gifts: updatedSenderNfts });
  dbOps.updateUser(receiverId, { nft_gifts: updatedReceiverNfts });

  broadcastUserUpdate(userId);
  broadcastUserUpdate(receiverId);
  
  res.json({ success: true });
});

app.post("/api/shop/gift-jcoins", (req, res) => {
  const { amount, receiverId } = req.body;
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  if (userId === receiverId) return res.status(400).json({ error: "Cannot gift to yourself" });
  if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });

  const sender = dbOps.getUserById(userId);
  const receiver = dbOps.getUserById(receiverId);
  
  if (!sender || !receiver) return res.status(404).json({ error: "User not found" });

  if ((sender.jcoins || 0) < amount) {
    return res.status(400).json({ error: "Not enough JCoins" });
  }

  dbOps.updateUser(userId, { jcoins: (sender.jcoins || 0) - amount });
  dbOps.updateUser(receiverId, { jcoins: (receiver.jcoins || 0) + amount });

  broadcastUserUpdate(userId);
  broadcastUserUpdate(receiverId);
  
  res.json({ success: true });
});

// --- TRADING SYSTEM ---
const trades = new Map<string, any>();

app.post("/api/trade/offer", (req, res) => {
  const { receiverId, offer, request } = req.body;
  const senderId = req.headers['x-user-id'] as string;
  if (!senderId) return res.status(401).json({ error: "Unauthorized" });

  if (senderId === receiverId) return res.status(400).json({ error: "Cannot trade with yourself" });

  const sender = dbOps.getUserById(senderId);
  const receiver = dbOps.getUserById(receiverId);
  
  if (!sender || !receiver) return res.status(404).json({ error: "User not found" });

  // Validate offer
  if (offer.jcoins > (sender.jcoins || 0)) {
    return res.status(400).json({ error: "Not enough JCoins to offer" });
  }
  const senderNfts = sender.nft_gifts || [];
  for (const nftId of offer.nfts) {
    if (!senderNfts.find(n => n.id === nftId)) {
      return res.status(400).json({ error: "You don't own all offered NFTs" });
    }
  }

  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const trade = {
    id: tradeId,
    senderId,
    receiverId,
    offer,
    request,
    status: 'pending',
    createdAt: Date.now()
  };

  trades.set(tradeId, trade);

  const receiverWs = clients.get(receiverId);
  if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
    receiverWs.send(JSON.stringify({ type: 'trade_offer', data: trade }));
  }

  res.json({ success: true, trade });
});

app.post("/api/trade/accept", (req, res) => {
  const { tradeId } = req.body;
  const receiverId = req.headers['x-user-id'] as string;
  if (!receiverId) return res.status(401).json({ error: "Unauthorized" });

  const trade = trades.get(tradeId);
  if (!trade || trade.receiverId !== receiverId || trade.status !== 'pending') {
    return res.status(404).json({ error: "Trade not found or invalid" });
  }

  const sender = dbOps.getUserById(trade.senderId);
  const receiver = dbOps.getUserById(trade.receiverId);

  if (!sender || !receiver) return res.status(404).json({ error: "User not found" });

  // Re-validate sender's offer
  if (trade.offer.jcoins > (sender.jcoins || 0)) {
    return res.status(400).json({ error: "Sender no longer has enough JCoins" });
  }
  const senderNfts = sender.nft_gifts || [];
  const offeredNfts = [];
  for (const nftId of trade.offer.nfts) {
    const nft = senderNfts.find(n => n.id === nftId);
    if (!nft) return res.status(400).json({ error: "Sender no longer owns all offered NFTs" });
    offeredNfts.push(nft);
  }

  // Validate receiver's request (what they are giving)
  if (trade.request.jcoins > (receiver.jcoins || 0)) {
    return res.status(400).json({ error: "You don't have enough JCoins" });
  }
  const receiverNfts = receiver.nft_gifts || [];
  const requestedNfts = [];
  for (const nftId of trade.request.nfts) {
    const nft = receiverNfts.find(n => n.id === nftId);
    if (!nft) return res.status(400).json({ error: "You don't own all requested NFTs" });
    requestedNfts.push(nft);
  }

  // Execute trade
  // 1. JCoins
  const newSenderJcoins = (sender.jcoins || 0) - trade.offer.jcoins + trade.request.jcoins;
  const newReceiverJcoins = (receiver.jcoins || 0) - trade.request.jcoins + trade.offer.jcoins;

  // 2. NFTs
  const newSenderNfts = senderNfts.filter(n => !trade.offer.nfts.includes(n.id));
  requestedNfts.forEach(n => newSenderNfts.push({ ...n, isPinned: false, acquiredAt: Date.now() }));

  const newReceiverNfts = receiverNfts.filter(n => !trade.request.nfts.includes(n.id));
  offeredNfts.forEach(n => newReceiverNfts.push({ ...n, isPinned: false, acquiredAt: Date.now() }));

  dbOps.updateUser(sender.id, { jcoins: newSenderJcoins, nft_gifts: newSenderNfts });
  dbOps.updateUser(receiver.id, { jcoins: newReceiverJcoins, nft_gifts: newReceiverNfts });

  trade.status = 'accepted';

  // Notify both
  const senderWs = clients.get(sender.id);
  if (senderWs && senderWs.readyState === WebSocket.OPEN) {
    senderWs.send(JSON.stringify({ type: 'trade_accepted', data: trade }));
  }
  const receiverWs = clients.get(receiver.id);
  if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
    receiverWs.send(JSON.stringify({ type: 'trade_accepted', data: trade }));
  }

  res.json({ success: true, trade });
});

app.post("/api/trade/decline", (req, res) => {
  const { tradeId } = req.body;
  const receiverId = req.headers['x-user-id'] as string;
  if (!receiverId) return res.status(401).json({ error: "Unauthorized" });

  const trade = trades.get(tradeId);
  if (!trade || trade.receiverId !== receiverId || trade.status !== 'pending') {
    return res.status(404).json({ error: "Trade not found or invalid" });
  }

  trade.status = 'declined';

  const senderWs = clients.get(trade.senderId);
  if (senderWs && senderWs.readyState === WebSocket.OPEN) {
    senderWs.send(JSON.stringify({ type: 'trade_declined', data: trade }));
  }

  res.json({ success: true, trade });
});

app.post("/api/trade/cancel", (req, res) => {
  const { tradeId } = req.body;
  const senderId = req.headers['x-user-id'] as string;
  if (!senderId) return res.status(401).json({ error: "Unauthorized" });

  const trade = trades.get(tradeId);
  if (!trade || trade.senderId !== senderId || trade.status !== 'pending') {
    return res.status(404).json({ error: "Trade not found or invalid" });
  }

  trade.status = 'cancelled';

  const receiverWs = clients.get(trade.receiverId);
  if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
    receiverWs.send(JSON.stringify({ type: 'trade_cancelled', data: trade }));
  }

  res.json({ success: true, trade });
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket setup
const wss = new WebSocketServer({ server });

const clients = new Map<string, WebSocket>();
const userConnectionTimes = new Map<string, number>();

// JCoin earning logic
setInterval(() => {
  const now = Date.now();
  for (const [userId, ws] of clients.entries()) {
    const lastAwardTime = userConnectionTimes.get(userId) || now;
    // 10 minutes = 600,000 ms
    if (now - lastAwardTime >= 600000) {
      dbOps.addJCoins(userId, 1);
      userConnectionTimes.set(userId, now);
      
      // Notify user
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'jcoins_awarded', data: { amount: 1 } }));
      }
    }
  }
}, 60000); // Check every minute

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const userId = url.searchParams.get('userId');

  if (userId) {
    clients.set(userId, ws);
    userConnectionTimes.set(userId, Date.now());
    console.log(`User connected: ${userId}`);
    
    // Notify friends
    const friends = dbOps.getFriends(userId);
    friends.forEach(friend => {
      const friendWs = clients.get(friend.id);
      if (friendWs && friendWs.readyState === WebSocket.OPEN) {
        friendWs.send(JSON.stringify({ type: 'friend_online', data: { userId } }));
      }
    });

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Check if user exists
        const currentUser = dbOps.getUserById(userId);
        if (!currentUser) {
          ws.close();
          return;
        }

        if (data.type === 'message') {
          if (currentUser.is_banned) return;
          const { senderId, receiverId, content } = data;
          
          const receiver = dbOps.getUserById(receiverId);
          if (receiver?.is_banned) {
             // Cannot message banned user
             return;
          }

          const friendship = dbOps.getFriendship(senderId, receiverId);
          if (!friendship || friendship.status !== 'accepted') {
            return;
          }

          const msg = dbOps.createMessage(senderId, receiverId, content);
          
          // Send to receiver if connected
          const receiverWs = clients.get(receiverId);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({ type: 'message', data: msg }));
          }
          
          // Send confirmation back to sender (optional, but good for optimistic UI confirmation)
          ws.send(JSON.stringify({ type: 'message_sent', data: msg }));
        } else if (['call_offer', 'call_answer', 'call_ice_candidate', 'call_end', 'call_rejected'].includes(data.type)) {
          const { receiverId } = data.data;
          const receiverWs = clients.get(receiverId);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify(data));
          }
        }
      } catch (e) {
        console.error('WS Error:', e);
      }
    });

    ws.on('close', () => {
      clients.delete(userId);
      userConnectionTimes.delete(userId);
      console.log(`User disconnected: ${userId}`);
      
      // Notify friends
      const friends = dbOps.getFriends(userId);
      friends.forEach(friend => {
        const friendWs = clients.get(friend.id);
        if (friendWs && friendWs.readyState === WebSocket.OPEN) {
          friendWs.send(JSON.stringify({ type: 'friend_offline', data: { userId } }));
        }
      });
    });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve static files from dist
    // (Assuming build output is in dist)
    app.use(express.static('dist'));
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
