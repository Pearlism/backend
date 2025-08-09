const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const clients = new Map(); // Map sessionId => discord Client

app.post('/api/login', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // Needed to read message content
    ],
    partials: [Partials.GuildMember, Partials.Message, Partials.Channel],
  });

  try {
    await client.login(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token or login failed' });
  }

  const user = client.user;

  await client.guilds.fetch();

  const guilds = await Promise.all(
    client.guilds.cache.map(async (g) => {
      let inviteURL = null;
      try {
        const guild = await client.guilds.fetch(g.id);
        const channels = await guild.channels.fetch();
        const inviteChannel = channels.find(
          (ch) =>
            ch.type === 0 && // GUILD_TEXT
            ch.permissionsFor(client.user).has('CreateInstantInvite')
        );
        if (inviteChannel) {
          const invite = await inviteChannel.createInvite({
            maxAge: 86400, // 1 day
            maxUses: 0,
            unique: true,
          });
          inviteURL = `https://discord.gg/${invite.code}`;
        }
      } catch {
        // no invite or no perms, ignore error
      }

      return {
        id: g.id,
        name: g.name,
        iconURL: g.iconURL(),
        memberCount: g.memberCount,
        inviteURL,
      };
    })
  );

  const sessionId = Math.random().toString(36).slice(2);
  clients.set(sessionId, client);

  res.json({
    sessionId,
    user: {
      id: user.id,
      username: user.username,
      avatarURL: user.displayAvatarURL(),
    },
    guilds,
  });
});

app.get('/api/guilds/:sessionId', (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  const guilds = client.guilds.cache.map((g) => ({
    id: g.id,
    name: g.name,
    iconURL: g.iconURL(),
    memberCount: g.memberCount,
  }));
  res.json({ guilds });
});

app.post('/api/status/:sessionId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  const { status, activity } = req.body;

  try {
    await client.user.setPresence({ activities: activity ? [activity] : [], status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nickname/:sessionId/:guildId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  const { nickname } = req.body;
  try {
    const guild = await client.guilds.fetch(req.params.guildId);
    const me = await guild.members.fetch(client.user.id);
    await me.setNickname(nickname);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/avatar/:sessionId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  const { avatarBase64 } = req.body;

  try {
    await client.user.setAvatar(avatarBase64);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change bot username (global)
app.post('/api/username/:sessionId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  const { username } = req.body;
  try {
    await client.user.setUsername(username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave guild endpoint
app.post('/api/leave/:sessionId/:guildId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  try {
    const guild = await client.guilds.fetch(req.params.guildId);
    await guild.leave();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get channels where bot can send messages in a guild
app.get('/api/channels/:sessionId/:guildId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  try {
    const guild = await client.guilds.fetch(req.params.guildId);
    const channels = await guild.channels.fetch();

    // Filter channels where bot has SEND_MESSAGES permission
    const textChannels = channels
      .filter(
        (ch) =>
          ch.type === 0 && // GUILD_TEXT
          ch.permissionsFor(client.user).has('SendMessages')
      )
      .map((ch) => ({
        id: ch.id,
        name: ch.name,
      }));

    res.json({ channels: textChannels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NEW: Get last 50 messages from a channel
app.get('/api/messages/:sessionId/:channelId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  try {
    const channel = await client.channels.fetch(req.params.channelId);
    if (!channel || channel.type !== 0) // GUILD_TEXT
      return res.status(400).json({ error: 'Invalid channel' });

    const messages = await channel.messages.fetch({ limit: 50 });
    const sorted = messages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(m => ({
        id: m.id,
        author: m.author.username,
        content: m.content,
        timestamp: m.createdTimestamp,
      }));

    res.json({ messages: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NEW: Send a message as the bot in the channel
app.post('/api/messages/:sessionId/:channelId', async (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (!client) return res.status(401).json({ error: 'Session expired' });

  const { content } = req.body;
  if (!content || content.trim() === '') {
    return res.status(400).json({ error: 'Message content required' });
  }

  try {
    const channel = await client.channels.fetch(req.params.channelId);
    if (!channel || channel.type !== 0) // GUILD_TEXT
      return res.status(400).json({ error: 'Invalid channel' });

    const sentMsg = await channel.send(content);

    res.json({
      success: true,
      messageId: sentMsg.id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout/:sessionId', (req, res) => {
  const client = clients.get(req.params.sessionId);
  if (client) {
    client.destroy();
    clients.delete(req.params.sessionId);
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
